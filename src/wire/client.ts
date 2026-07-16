import { z } from "zod";
import { QuestionSchema } from "../common/question.js";
import { IngestBatchRequestSchema } from "../ingest/index.js";
import { wireVariant } from "./envelope.js";

/**
 * AGENT → SERVER messages on `/agent/v1` (the runner is the client). The opening
 * `register` frame lives in `./handshake.ts`; this module owns the steady-state
 * client messages: `heartbeat`, `accept`, `needs_input`, `upload`, `run_status`.
 *
 * REUSE (no divergent duplicates — see the T1-01 shapes this composes):
 *   - `needs_input` embeds the shared {@link QuestionSchema} (`../common/question`).
 *   - `upload`      embeds {@link IngestBatchRequestSchema} (`../ingest/`) verbatim.
 */

/** Runner liveness/pause states surfaced on a heartbeat. `paused` is the
 *  provider-limit backoff (ARCHITECTURE §1 "paused: provider limit — auto-resume
 *  at HH:MM"); `draining` = finishing in-flight runs, accepting no new leases. */
export const RUNNER_STATUSES = ["online", "paused", "draining"] as const;
export type RunnerStatus = (typeof RUNNER_STATUSES)[number];

/** The run-lifecycle phase a `run_status` reports — mirrors the `run.started` /
 *  `run.completed` / `run.halted` events (spike-report G4/G6). */
export const RUN_STATUS_PHASES = ["started", "completed", "halted"] as const;
export type RunStatusPhase = (typeof RUN_STATUS_PHASES)[number];

/**
 * `heartbeat` (agent → server) — periodic liveness at the cadence the server
 * gave on `register_ack`. Carries the runner's in-flight runs (for capacity /
 * lease-TTL bookkeeping) and its pause state. The control plane uses the last
 * heartbeat to mark a runner offline and its leases interrupted (ARCHITECTURE §1
 * "Leases carry a heartbeat TTL"). Set `id` to pair with the `heartbeat_ack`.
 */
export const HeartbeatMessageSchema = wireVariant("heartbeat", {
  runner_id: z.string().min(1),
  /** Run ids currently executing on this runner (liveness + capacity signal). */
  active_run_ids: z.array(z.string()).optional(),
  /** Runner state; absent ⇒ treat as `online`. */
  status: z.enum(RUNNER_STATUSES).optional(),
  /** When `status: "paused"`, the ISO time auto-resume is expected (provider
   *  limit reset), or null if unknown. */
  paused_until: z.string().datetime({ offset: true }).nullable().optional(),
});
export type HeartbeatMessage = z.infer<typeof HeartbeatMessageSchema>;

/**
 * `accept` (agent → server) — the runner accepts a `lease` (see `./server.ts`).
 * Echo the lease's correlation `id` on the envelope so the gateway pairs the
 * acceptance to the offer. After this the server issues the job JWT + declared
 * secrets and the runner checks out the workspace and invokes `pipeline drive`
 * (ARCHITECTURE §"Data flow").
 */
export const AcceptMessageSchema = wireVariant("accept", {
  runner_id: z.string().min(1),
  /** The job being accepted (from the `lease`). */
  job_id: z.string().min(1),
  /** The run this job executes. */
  run_id: z.string().min(1),
});
export type AcceptMessage = z.infer<typeof AcceptMessageSchema>;

/**
 * `needs_input` (agent → server) — the runner surfaces a drive question up the
 * WSS channel so the control plane can notify the user (web push) and collect an
 * answer (the reply is the server's `answer` message, `./server.ts`). This is the
 * live-answer transport; the same park is ALSO journalled as an `awaiting_input`
 * event for mirror observability (spike-report G7 — "one truth, two transports").
 *
 * Shape MIRRORS `AwaitingInputData` (`../events/types.ts`): `run_id` +
 * `question_id` (both required — this is a v5-only message that always carries
 * identity, spike-report G3) siblings around the shared {@link QuestionSchema}.
 * The `question_id` is echoed by the `answer` so a stale answer racing a
 * superseded question is rejected by the relay (T1-13).
 */
export const NeedsInputMessageSchema = wireVariant("needs_input", {
  run_id: z.string().min(1),
  /** Stable question identity (G3), echoed by the answer. Required here (unlike
   *  the optional `question_id` INSIDE `QuestionSchema`, which stays optional for
   *  v4 back-compat) — this message is v5-only. */
  question_id: z.string().min(1),
  question: QuestionSchema,
});
export type NeedsInputMessage = z.infer<typeof NeedsInputMessageSchema>;

/**
 * `upload` (agent → server) — a batched, idempotent event upload.
 *
 * ── Idempotency + ordering (spike-report G1) ────────────────────────────────
 * The payload is {@link IngestBatchRequestSchema} REUSED VERBATIM (`../ingest/`):
 * a `run_id` + records each bearing the SHIPPER-ASSIGNED `seq`. Ingest is
 * idempotent on `(run_id, seq)` — re-posting an existing pair is a no-op
 * (`INSERT … ON CONFLICT DO NOTHING`), so retries / overlapping batches / a WSS
 * flap-and-resend are all safe. INVARIANT: exactly ONE shipper per run assigns
 * `seq` (two concurrent shippers on one journal is unsupported). See the full
 * contract on `IngestBatchRequestSchema`.
 *
 * ── Transport note (ARCHITECTURE reconciliation) ────────────────────────────
 * ARCHITECTURE §1 makes the CANONICAL upload transport a separate HTTPS POST
 * `/ingest` ("All uploads are separate HTTPS batches (survive WSS flaps)"), whose
 * body IS exactly `IngestBatchRequestSchema`. This WSS `upload` message wraps the
 * SAME schema so there is ONE idempotency contract regardless of transport (HTTPS
 * primary, or WSS on the long-poll-fallback path). Because the batch shape is
 * shared, an event never has a divergent duplicate definition. Which transport a
 * given deployment prefers is a T1-06/T1-11 wiring choice, not a schema choice.
 */
export const UploadMessageSchema = wireVariant("upload", {
  /** The batched upload body — the exact `../ingest/` request shape. */
  batch: IngestBatchRequestSchema,
});
export type UploadMessage = z.infer<typeof UploadMessageSchema>;

/**
 * `run_status` (agent → server) — a compact run-lifecycle signal REFERENCING the
 * `run.started` / `run.completed` / `run.halted` events (spike-report G4/G6),
 * giving the control plane an at-a-glance job phase without parsing the event
 * batch. It does not duplicate the event `data` schemas: `phase` is the event's
 * suffix, and the terminal detail (`outcome` / `halt_reason`) mirrors the
 * corresponding event's fields. The authoritative record remains the uploaded
 * events; this is a routing/notification convenience. Fire-and-forget (no `id`).
 */
export const RunStatusMessageSchema = wireVariant("run_status", {
  run_id: z.string().min(1),
  /** The job this run executes (from the lease), if the runner tracks it. */
  job_id: z.string().min(1).optional(),
  phase: z.enum(RUN_STATUS_PHASES),
  /** Terminal outcome for `completed` (e.g. "completed" | "depth-exhausted") —
   *  mirrors `RunCompletedData.outcome`. Null/absent while `started`. */
  outcome: z.string().nullable().optional(),
  /** Halt reason for `halted` — mirrors `RunHaltedData.halt_reason`. */
  halt_reason: z.string().nullable().optional(),
});
export type RunStatusMessage = z.infer<typeof RunStatusMessageSchema>;
