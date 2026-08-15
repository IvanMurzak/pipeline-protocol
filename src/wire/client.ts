import { z } from "zod";
import { QuestionSchema } from "../common/question.js";
import { IngestBatchRequestSchema } from "../ingest/index.js";
import { wireVariant } from "./envelope.js";
// Shared chat message-length bound (review A1) — defined alongside `chat_send`
// in `./server.ts` (the frame's "primary" definition) and reused here so
// `chat_send`/`chat_reply` share exactly one cap, never two.
import { CHAT_MESSAGE_MAX_CHARS } from "./server.js";

/**
 * AGENT → SERVER messages on `/agent/v1` (the runner is the client). The opening
 * `register` frame lives in `./handshake.ts`; this module owns the steady-state
 * client messages: `heartbeat`, `accept`, `needs_input`, `upload`, `run_status`,
 * `chat_reply`.
 *
 * REUSE (no divergent duplicates — see the T1-01 shapes this composes):
 *   - `needs_input` embeds the shared {@link QuestionSchema} (`../common/question`).
 *   - `upload`      embeds {@link IngestBatchRequestSchema} (`../ingest/`) verbatim.
 *   - `chat_reply`  shares {@link CHAT_MESSAGE_MAX_CHARS} with `chat_send`
 *     (`./server.ts`) — one length cap, not two.
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
  /**
   * OPTIONAL capability flag (D13, ADDITIVE, task d1): `true` ⇒ this runner's
   * `active_run_ids` is an AUTHORITATIVE, exhaustive list of its in-flight runs,
   * so the control plane may apply per-run lease-refresh/interrupt logic keyed
   * on membership (06.3). CAPABILITY-KEYED, not presence-keyed: shipped 0.2.x
   * runners already emit `active_run_ids: []` unconditionally (heartbeat.ts:141),
   * so keying per-run logic on the ARRAY's mere presence would misinterpret
   * every legacy heartbeat and interrupt every old runner's jobs after two
   * beats. Absent ⇒ the control plane falls back to today's legacy blanket
   * lease refresh, byte-for-byte unchanged — a heartbeat predating this field
   * behaves identically. Present and `true` only once the emitting runner
   * actually populates `active_run_ids` exhaustively (a runner MUST NOT set
   * this flag while still sending a stub empty array).
   */
  runs_authoritative: z.boolean().optional(),
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
 * The terminal-failure payload a `chat_reply` carries on its FINAL chunk when
 * a turn cannot complete normally (review B2) — see {@link ChatReplyMessageSchema}
 * `error` for when a runner sets this instead of staying silent. Nested object,
 * so `.passthrough()` per ADDITIVE-POLICY rule 3. `code` is deliberately a
 * lenient open string (rule 5), not a closed enum — mirrors
 * `DeptFailedEventSchema.reason` (`../department/events.ts`): a future failure
 * class needs no schema change to become parseable. Documented (not
 * exhaustive) values: `"not_owned"` (the `chat_send` named a run/session this
 * runner does not own — 07 T7), `"session_unavailable"` (the executor session
 * is dead, parked past resume, or the run is already terminal),
 * `"internal_error"` (an unexpected runner-side failure mid-stream).
 */
export const ChatReplyErrorSchema = z
  .object({
    /** Open, lenient failure class — see the documented values above. */
    code: z.string().min(1),
    /** Human-readable detail for logs / the composer's error state. */
    message: z.string().min(1),
  })
  .passthrough();
export type ChatReplyError = z.infer<typeof ChatReplyErrorSchema>;

/**
 * `chat_reply` (agent → server) — the runner's executor-session reply to a
 * `chat_send` (`./server.ts`), STREAMED as one or more frames (`pipeline-ui-v2`
 * task `a3-protocol-chat-frames`, design `02-target-architecture.md` M6, gate
 * G1b). `done: false` ⇒ more chunks follow; `done: true` ⇒ this is the final
 * chunk. A non-streaming runner sends exactly ONE frame with `done: true`.
 *
 * ── Turn identity (review B1) ────────────────────────────────────────────────
 * `message_id` REQUIRED-echoes the originating `chat_send.message_id`
 * (`./server.ts`) on every chunk — NOT the optional envelope `id`
 * (`./envelope.ts`, documented there as "a routing aid, not a schema gate").
 * See `ChatSendMessageSchema`'s doc for the full precedent (`needs_input`'s
 * `question_id`, `DeptMessageSchema.message_id`) and why an envelope-only key
 * cannot disambiguate concurrent turns, detect a redelivered send, or let a
 * reply to a superseded turn be rejected.
 *
 * ── Terminal failure (review B2) ─────────────────────────────────────────────
 * Silence is NOT a valid rejection. If the runner cannot (or can no longer)
 * service this turn — the `chat_send` named a run/session it does not own
 * (07 T7), the executor session died mid-stream, or the run went terminal —
 * it MUST emit a `chat_reply` with `done: true` and {@link error} populated,
 * never simply stop sending frames. `error` absent ⇒ ordinary content (either
 * a mid-stream chunk or a successful final chunk); `error` present ⇒ this IS
 * the final chunk (implies `done: true`) and its `message` text, if any, is
 * whatever partial content the runner managed before failing — the receiver
 * must not treat prose alone (e.g. an apologetic final chunk with no `error`)
 * as a machine-readable failure signal.
 *
 * ── Minimal channel (R5b) ────────────────────────────────────────────────────
 * Text only, bound to exactly ONE run's session: no attachment fields, no
 * history-backfill fields. `run_id` is the sole SESSION-scoping key, mirroring
 * `needs_input`/`answer` (no separate `session_id`); `message_id` scopes the
 * TURN (see above).
 *
 * ── Authorization (07 §T7) ───────────────────────────────────────────────────
 * The runner MUST reject (never route into) a `chat_send` naming a run/session
 * it does not own — chat must not steer an executor beyond the owner's intent
 * — and signal that rejection via `error: { code: "not_owned", ... }` per the
 * terminal-failure contract above, rather than silence. `run_id` here is the
 * runner's OWN declaration of which session replied; it carries no authz
 * weight by itself — the cloud independently verifies run ownership/RLS scope
 * before trusting it (never trust client-declared state, 07 §Handling rules),
 * exactly as it does for `run_status`/`needs_input`.
 */
export const ChatReplyMessageSchema = wireVariant("chat_reply", {
  /** The run whose executor session this reply comes from (D4: run-bound
   *  only). SESSION-scoping key — see the turn-identity note above. */
  run_id: z.string().min(1),
  /** REQUIRED echo of the originating `chat_send.message_id` (review B1) —
   *  every chunk of a turn's stream carries the same value. */
  message_id: z.string().min(1),
  /** This chunk's reply text. May be empty on a pure completion or error
   *  sentinel frame (`done: true` with no additional text). Bounded by
   *  {@link CHAT_MESSAGE_MAX_CHARS} (`./server.ts`, review A1). */
  message: z.string().max(CHAT_MESSAGE_MAX_CHARS),
  /** `false` ⇒ more chunks follow this one; `true` ⇒ the final chunk of this
   *  reply (success OR failure — see `error` below). A non-streaming runner
   *  always sends a single `done: true` frame. */
  done: z.boolean(),
  /** OPTIONAL terminal-failure marker (review B2) — see the doc above. Present
   *  ⇒ this is the FINAL chunk of a turn that did not complete normally;
   *  absent/null ⇒ ordinary content. */
  error: ChatReplyErrorSchema.nullable().optional(),
  /** ISO-8601 UTC time this chunk was emitted. Producer-stamped, DISPLAY-ONLY
   *  (review A2): reassembly and delivery order follow stream/arrival order,
   *  never a sort by `ts` — clock skew and same-millisecond chunks are both
   *  realistic on this channel. */
  ts: z.string().datetime({ offset: true }),
});
export type ChatReplyMessage = z.infer<typeof ChatReplyMessageSchema>;

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
  /**
   * Terminal outcome for `completed` (e.g. "completed" | "depth-exhausted") —
   * mirrors `RunCompletedData.outcome`. Null/absent while `started`.
   *
   * ALSO carries the BLOCKED signal on a `halted` phase (`pipeline-ui-v2`
   * task `a1-protocol-run-state`, `02-target-architecture.md` §"Unified
   * status model" wire note): a runner reports `phase:"halted",
   * outcome:"blocked"` for an exit-3/blocker-delegated classification.
   * `phase` (above) is a CLOSED enum that cannot grow additively (rule 1,
   * `ADDITIVE-POLICY.md`), so `"blocked"` rides this already-OPEN string
   * field instead of a new phase value — see {@link RUN_STATUS_OUTCOME_BLOCKED}
   * for the literal. An old cloud that doesn't know this value degrades to
   * today's plain-halted handling; a new cloud maps it to the public
   * `"blocked"` run state (`../common/run-state.ts`, `deriveRunState`).
   */
  outcome: z.string().nullable().optional(),
  /** Halt reason for `halted` — mirrors `RunHaltedData.halt_reason`. */
  halt_reason: z.string().nullable().optional(),
});
export type RunStatusMessage = z.infer<typeof RunStatusMessageSchema>;

/**
 * The documented `outcome` value that carries the BLOCKED signal on a
 * `phase:"halted"` `run_status` frame (see the field's doc comment above).
 * Exported so the runner (which sets it) and the cloud API (which reads it)
 * both reference the one literal instead of each hard-coding `"blocked"`
 * (review of task `a1-protocol-run-state`, finding B4).
 */
export const RUN_STATUS_OUTCOME_BLOCKED = "blocked" as const;
