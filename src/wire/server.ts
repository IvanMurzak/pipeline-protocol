import { z } from "zod";
import { AnswerMessageSchema } from "../records/answer.js";
import { IngestBatchResponseSchema } from "../ingest/index.js";
import { wireVariant } from "./envelope.js";

/**
 * SERVER → AGENT messages on `/agent/v1` (the control plane speaks to the
 * runner). The handshake replies (`register_ack` / `register_reject`) live in
 * `./handshake.ts`; this module owns the steady-state server messages: `lease`,
 * `answer`, `cancel`, `heartbeat_ack`, `upload_ack`.
 *
 * REUSE (no divergent duplicates):
 *   - `answer`     embeds {@link AnswerMessageSchema} (`../records/answer`) verbatim.
 *   - `upload_ack` embeds {@link IngestBatchResponseSchema} (`../ingest/`) verbatim.
 */

/** An optional server directive piggy-backed on a `heartbeat_ack`. `reregister`
 *  asks the runner to re-handshake (e.g. after a control-plane deploy);
 *  `drain` asks it to stop accepting new leases. */
export const HEARTBEAT_DIRECTIVES = ["none", "reregister", "drain"] as const;
export type HeartbeatDirective = (typeof HEARTBEAT_DIRECTIVES)[number];

/**
 * The pipeline a lease points a runner at. Mirrors ARCHITECTURE §"Data flow"
 * ("git checkout at requested ref → pipeline drive") and the eval-dimension
 * `pipeline version` content hash (§Evaluation). Sources (PIPELINE.md + steps/**)
 * live in the user's git repo, NEVER the cloud (§"Where the files live"), so the
 * lease carries only a REFERENCE the runner resolves by checkout.
 */
export const PipelineRefSchema = z
  .object({
    /** Repo identity to fetch (git remote / `org/name`). */
    repo: z.string().min(1),
    /** Git ref to check out (branch / tag / sha). */
    ref: z.string().min(1),
    /** Pipeline name or path within the repo (under `.claude/pipeline/`). */
    pipeline: z.string().min(1),
    /** Pinned content hash (PIPELINE.md + steps/** + scripts/**) — the eval /
     *  registry version identity; lets the runner verify it checked out the
     *  exact pinned version. Null/absent for an unpinned "latest ref" lease. */
    content_hash: z.string().min(1).nullable().optional(),
  })
  .passthrough();
export type PipelineRef = z.infer<typeof PipelineRefSchema>;

/**
 * Sentinel `pipeline_ref.pipeline` value for a TASK-dispatch lease (T2-05):
 * the cloud knows the checkout target (repo/ref) but NOT the pipeline — the
 * runner resolves it locally by BM25-matching the lease's `task` text against
 * the project's own pipeline manifests (sources never live in the cloud —
 * ARCHITECTURE §"Where the files live"). A lease whose `pipeline_ref.pipeline`
 * equals this sentinel MUST also carry a `task` field; a runner MUST NOT try
 * to check out a pipeline by this name. Chosen non-empty so PipelineRefSchema's
 * `min(1)` stays intact (additive — old fixed-pipeline leases are unchanged),
 * and `@`-prefixed so it can never collide with a real path under
 * `.claude/pipeline/`.
 */
export const TASK_PIPELINE_UNRESOLVED = "@task" as const;

/**
 * The natural-language WORK ITEM a task-dispatch lease carries (T2-05): exactly
 * what the runner's deterministic BM25 matcher needs to pick a pipeline from
 * the checked-out project's local manifests — the task identity plus the text
 * (`title` + `body`) and `labels` it matches on. NO pipeline identity here by
 * design: the match happens ON THE RUNNER, inside the lease (privacy: pipeline
 * sources/manifests never reach the cloud).
 */
export const LeaseTaskSchema = z
  .object({
    /** The control-plane task id (tasks.id) — echoes through run provenance. */
    task_id: z.string().min(1),
    /** Short human title (part of the BM25 match input). */
    title: z.string().min(1),
    /** The full natural-language task text the runner BM25-matches. May be
     *  empty when the title says it all. */
    body: z.string(),
    /** Task labels (routing/BM25 hints) — the same values the job was
     *  label-matched on. */
    labels: z.array(z.string()),
  })
  .passthrough();
export type LeaseTask = z.infer<typeof LeaseTaskSchema>;

/**
 * OPTIONAL per-run EXECUTION OVERRIDE a lease may carry (T3-06 prerequisite,
 * ADDITIVE). Present ⇒ the runner MUST override the pipeline's own DECLARED
 * model and/or effort for THIS run — it passes `model` to `computePlan`'s
 * `modelOverride` and `effort` to its `effortOverrides` (the runner-side
 * consumption is a SEPARATE follow-up; this schema is only the wire carrier).
 * ABSENT ⇒ the pipeline's own model/effort apply, byte-for-byte the lease of
 * today. Both fields are independently optional: a lease may override only the
 * model, only the effort, or both. This is the plumbing T3-06 (matrix runs)
 * uses to sweep the SAME pipeline across a grid of model/effort values — the
 * matrix module that SETS these per run is itself a follow-up.
 *
 * `.passthrough()` so a newer peer's additive override dimension is preserved,
 * not rejected — the same additive-forward rule the rest of the wire uses.
 * Additive-only within protocol major 1 — NO version bump (mirrors the T2-05
 * optional `task` addition exactly).
 */
export const ExecutionOverridesSchema = z
  .object({
    /** Exact model id to force for this run (e.g. an Anthropic model id). Maps
     *  to computePlan `modelOverride`. Omitted ⇒ the pipeline's own model. */
    model: z.string().min(1).optional(),
    /** Effort level to force for this run. Maps to computePlan
     *  `effortOverrides`. Omitted ⇒ the pipeline's own effort. */
    effort: z.string().min(1).optional(),
  })
  .passthrough();
export type ExecutionOverrides = z.infer<typeof ExecutionOverridesSchema>;

/**
 * OPTIONAL per-run VARIABLES map a lease may carry (env-variables design, task
 * `b1-protocol-lease-variables`, P6·protocol). Present ⇒ the runner maps each
 * entry to one `--var NAME=value` flag on the pipeline's `${PP_*}` substitution
 * engine — and ONLY on the START `pipeline drive` invocation, never on a
 * resume/answer invocation (D11 runner corollary: a run whose `next.json`
 * already froze a variables map at init rejects a repeated `--var`, mirroring
 * that `execution_overrides` re-rides every invocation while `variables` does
 * NOT). ABSENT ⇒ the pipeline's own declared defaults apply and the lease is
 * byte-identical to a lease with no `variables` key — the load-bearing dispatch
 * path is untouched for every run that predates this field.
 *
 * Keys are constrained to the `PP_[A-Z0-9_]+` grammar (D9 defense-in-depth) by
 * THIS schema's own key predicate. Values are opaque, non-secret strings (D4) —
 * `PP_*` values are contractually non-secret configuration (names, versions,
 * URLs, flags), never masked or encrypted on this channel; secrets continue to
 * use the existing job-JWT secrets-delivery path and never ride the lease.
 *
 * **Zod key-schema verdict — PIN, don't assume (recorded 2026-07-16, pinned
 * `zod@3.25.76`, this package's exact dependency):** the two-argument
 * `z.record(keySchema, valueSchema)` form in this pinned version DOES enforce
 * the key schema — a key failing the `PP_` regex (e.g. `NOT_PP`) is REJECTED by
 * `safeParse`/`parse`, not silently admitted. This is pinned by an explicit test
 * in `server.test.ts` ("RunVariablesSchema key-regex verdict") so a future zod
 * bump that regresses this behavior fails CI loudly instead of silently. This
 * verdict does NOT excuse the cloud API boundary (task c1) from validating
 * every variable name explicitly server-side before persisting/relaying a
 * dispatch — defense-in-depth (D9) is deliberate, independent of what any one
 * layer's schema library happens to enforce today. No entry-count / byte-size
 * cap is expressed in this schema (64 entries / 4 KiB per the design) — that
 * cap is enforced at the cloud API boundary, not in this wire-schema hot path.
 */
export const RunVariablesSchema = z.record(
  z.string().regex(/^PP_[A-Z0-9_]+$/),
  z.string(),
);
export type RunVariables = z.infer<typeof RunVariablesSchema>;

/**
 * `lease` (server → agent) — offer a queued run to a runner whose labels match.
 * Carries the job/run identity, the pipeline reference, the label set the match
 * was made on, a SHORT-LIVED per-job JWT, and the SLUGS of the secrets the
 * pipeline declared. Set the envelope `id` as the correlation id the runner
 * echoes on `accept`.
 *
 * ── Task-dispatch leases (T2-05, ADDITIVE) ──────────────────────────────────
 * An OPTIONAL `task` field ({@link LeaseTaskSchema}) turns a lease into a
 * task-dispatch: `pipeline_ref` then carries the checkout target only (repo +
 * ref, `pipeline` = {@link TASK_PIPELINE_UNRESOLVED}, `content_hash` null) and
 * the runner resolves the actual pipeline by BM25 over its local manifests
 * before driving. ABSENT ⇒ the fixed-pipeline lease of T2-03, byte-for-byte
 * unchanged (additive-only within protocol major 1 — no version bump).
 *
 * ── Execution overrides (T3-06 prerequisite, ADDITIVE) ──────────────────────
 * An OPTIONAL `execution_overrides` field ({@link ExecutionOverridesSchema})
 * instructs the runner to override the pipeline's declared model and/or effort
 * for this run (matrix runs sweep a grid of these). ABSENT ⇒ the pipeline's
 * own model/effort, and the lease is byte-identical to a lease with no
 * override — the load-bearing dispatch path is untouched for every normal run.
 *
 * ── Variables (env-variables design task b1, P6·protocol, ADDITIVE) ────────
 * An OPTIONAL `variables` field ({@link RunVariablesSchema}) carries a per-run
 * `PP_*` map the runner applies via `--var NAME=value` on the START invocation
 * only (see the schema doc above for the resume/answer exclusion). ABSENT ⇒ no
 * dispatched variables — the pipeline's own manifest defaults / declared
 * variables apply, and the lease is byte-identical to a lease predating this
 * field.
 *
 * ── Secrets (ARCHITECTURE §Security) ────────────────────────────────────────
 * Only `secret_slugs` (the NAMES of declared secrets) ride this message — never
 * the values. Secret VALUES are envelope-encrypted at rest and decrypted only at
 * job-lease time for the declared keys, and MUST NOT be logged; whether they are
 * delivered inside a later secured frame or injected at job start is a T1-06
 * decision (see follow-ups). Fork-PR runs receive NO secrets at all (§Security).
 *
 * The `job_jwt` is a placeholder token slot here (the protocol package does not
 * mint or verify JWTs) — issuance/verification is the control plane's job.
 */
export const LeaseMessageSchema = wireVariant("lease", {
  /** The offered job. */
  job_id: z.string().min(1),
  /** The run this job executes. */
  run_id: z.string().min(1),
  pipeline_ref: PipelineRefSchema,
  /** The labels this offer was matched on. */
  labels: z.array(z.string()),
  /** Short-lived per-job JWT (opaque here — minted/verified by the control
   *  plane; §Security "short-lived per-job JWTs"). */
  job_jwt: z.string().min(1),
  /** Declared-secret SLUGS only — never values (see doc above). */
  secret_slugs: z.array(z.string()),
  /** Lease heartbeat TTL in seconds: if the runner misses it mid-run the run is
   *  marked interrupted (ARCHITECTURE §1). */
  lease_ttl_s: z.number().int().positive().optional(),
  /** OPTIONAL task-dispatch work item (T2-05) — see the schema doc above.
   *  Present ⇒ the runner BM25-resolves the pipeline locally; absent ⇒ the
   *  T2-03 fixed-pipeline lease, unchanged. */
  task: LeaseTaskSchema.optional(),
  /** OPTIONAL per-run execution override (T3-06 prerequisite) — see the schema
   *  doc above. Present ⇒ the runner overrides the pipeline's declared
   *  model/effort for this run; absent ⇒ the pipeline's own model/effort, and
   *  the lease is byte-identical to today's. */
  execution_overrides: ExecutionOverridesSchema.optional(),
  /** OPTIONAL per-run `PP_*` variables map (env-variables design task b1) — see
   *  the schema doc above. Present ⇒ the runner applies these via `--var` on
   *  the start invocation only; absent ⇒ no dispatched variables, and the
   *  lease is byte-identical to today's. */
  variables: RunVariablesSchema.optional(),
});
export type LeaseMessage = z.infer<typeof LeaseMessageSchema>;

/**
 * `answer` (server → agent) — deliver a needs-input answer down to the runner,
 * which feeds it to `drive`'s resume path (T1-13). The payload is
 * {@link AnswerMessageSchema} REUSED VERBATIM (`../records/answer`): `{ run_id,
 * question_id, answer, answered_by, ts }`. Its `question_id` echoes the
 * `needs_input` question (spike-report G3/G8) so the relay can reject an answer
 * to a superseded question; `answered_by` + `ts` feed the audit log (§Security).
 * Echo the `needs_input` correlation `id` on the envelope.
 */
export const AnswerDeliveryMessageSchema = wireVariant("answer", {
  /** The structured answer envelope — the exact `../records/answer` shape. */
  answer: AnswerMessageSchema,
});
export type AnswerDeliveryMessage = z.infer<typeof AnswerDeliveryMessageSchema>;

/**
 * `cancel` (server → agent) — cancel a run (user-requested, budget cap, or a
 * superseding trigger). The runner stops `drive` and reports a terminal
 * `run_status`. Fire-and-forget (no reply frame required).
 */
export const CancelMessageSchema = wireVariant("cancel", {
  run_id: z.string().min(1),
  /** The job to cancel, if the caller keys on job rather than run. */
  job_id: z.string().min(1).optional(),
  /** Optional human-readable reason (surfaced in the runner console / audit). */
  reason: z.string().nullable().optional(),
});
export type CancelMessage = z.infer<typeof CancelMessageSchema>;

/**
 * `heartbeat_ack` (server → agent) — the reply to a `heartbeat`. Echo the
 * heartbeat's correlation `id`. Carries the server time (so the runner can gauge
 * clock skew / RTT) and an optional directive.
 */
export const HeartbeatAckMessageSchema = wireVariant("heartbeat_ack", {
  /** Server ISO time at ack — lets the runner measure skew / round-trip. */
  ts: z.string().datetime({ offset: true }).optional(),
  /** Optional server directive; absent ⇒ `none`. */
  directive: z.enum(HEARTBEAT_DIRECTIVES).nullable().optional(),
});
export type HeartbeatAckMessage = z.infer<typeof HeartbeatAckMessageSchema>;

/**
 * `upload_ack` (server → agent) — the reply to an `upload`. The payload is
 * {@link IngestBatchResponseSchema} REUSED VERBATIM (`../ingest/`): `{ run_id,
 * inserted, skipped }`, letting the shipper confirm how many records were newly
 * stored vs. deduped under the `(run_id, seq)` idempotency rule. Echo the
 * `upload` correlation `id`. (On the HTTPS `/ingest` transport this same shape is
 * the HTTP response body — one contract, either transport.)
 */
export const UploadAckMessageSchema = wireVariant("upload_ack", {
  /** The ingest result — the exact `../ingest/` response shape. */
  ack: IngestBatchResponseSchema,
});
export type UploadAckMessage = z.infer<typeof UploadAckMessageSchema>;
