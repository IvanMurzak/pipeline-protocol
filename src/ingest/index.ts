import { z } from "zod";

/**
 * The INGEST contract (spike-report G1) — the batched upload from the shipper to
 * the control-plane api, and its idempotency rule.
 *
 * ── The shipper-assigned `(run_id, seq)` idempotency contract ────────────────
 * Events on disk carry NO `seq` — ordering is positional (file byte order) and a
 * single journal interleaves many `run_id`s. The **shipper is the sequence
 * authority**: it assigns a per-run monotonic, non-negative `seq` (checkpointed
 * with a byte-offset so it stays contiguous across a drive park/resume process
 * boundary) and ingest is **idempotent on `(run_id, seq)`** — re-posting an
 * existing pair is a no-op (`INSERT … ON CONFLICT DO NOTHING`). Retries,
 * overlaps and duplicate batches are therefore safe.
 *
 * INVARIANT: exactly ONE shipper per journal. Two concurrent shippers on one
 * journal would assign conflicting seqs and is UNSUPPORTED (documented, not
 * defended against on the wire).
 *
 * The batch shape mirrors the Phase-0 spike ingest endpoint
 * (`apps/api/src/spike/server.ts`):
 *   POST /ingest  { run_id, events: [{ seq, payload }] }
 *              ->  { run_id, inserted, skipped }
 *
 * ── Batch-level execution context (ux-v2 e3) ────────────────────────────────
 * The optional `context` field carries run dimensions that exist outside the
 * event journal: runner environment, registered project, trigger attribution.
 * The cloud validates and derives run dimensions from `context` fields before
 * event-journal processing. See `cloud/apps/api/src/modules/runs/derive.ts` for
 * the validation and the IngestBatchContext interface it parses into.
 */

/**
 * One record in an ingest batch: the shipper-assigned `seq` + the opaque event
 * `payload`. `seq` is a non-negative integer (the store seeds its replay cursor
 * at -1, so a negative seq would be stored yet never replayed — rejected at the
 * boundary). `payload` is treated as opaque jsonb by the store; it is normally a
 * shippable event envelope (see `events/`), but the ingest wire does not
 * re-validate it, so it is typed `unknown` here.
 */
export const IngestEventRecordSchema = z
  .object({
    seq: z.number().int().nonnegative(),
    payload: z.unknown(),
  })
  // `payload` is REQUIRED (the spike endpoint 400s on a missing payload).
  // `z.unknown()` alone would let an omitted key through, so assert presence.
  .superRefine((rec, ctx) => {
    if (rec.payload === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "payload is required", path: ["payload"] });
    }
  });
export type IngestEventRecord = z.infer<typeof IngestEventRecordSchema>;

/**
 * Batch-level context: optional execution dimensions outside the event journal.
 * All fields are nullish (optional AND nullable), matching server parsing at
 * `cloud/apps/api/src/modules/runs/derive.ts:73-121`, which explicitly skips
 * both `undefined` and `null` on every field.
 *
 * Validation rules (per `derive.ts`):
 *  - `project_id`, `runner_id`: must be UUIDs if present and non-null (line 84)
 *  - String fields: non-empty, max 4000 chars if present and non-null (line 91)
 *  - `trigger_type`: must be one of the closed enum (line 99)
 *    ["manual", "cron", "webhook", "api", "matrix"] from runs/types.ts:50
 *  - `trigger_meta`: must be a JSON object if present and non-null (line 109)
 *  - `runner_labels`: accepts any value if present and non-null (line 117)
 * Both `undefined` and `null` skip validation in the server, so both must pass
 * schema validation to preserve backward compatibility with clients that
 * serialize absent fields as `null`.
 */
export const IngestBatchContextSchema = z
  .object({
    project_id: z.string().uuid().nullish(),
    runner_id: z.string().uuid().nullish(),
    runner_labels: z.unknown().nullish(),
    runner_os: z.string().min(1).max(4000).nullish(),
    runner_agent_version: z.string().min(1).max(4000).nullish(),
    runner_cli_version: z.string().min(1).max(4000).nullish(),
    runner_plugin_version: z.string().min(1).max(4000).nullish(),
    harness_id: z.string().min(1).max(4000).nullish(),
    harness_version: z.string().min(1).max(4000).nullish(),
    pipeline_version: z.string().min(1).max(4000).nullish(),
    project_fingerprint: z.string().min(1).max(4000).nullish(),
    trigger_type: z.enum(["manual", "cron", "webhook", "api", "matrix"]).nullish(),
    trigger_meta: z.record(z.unknown()).nullish(),
    orchestrator_model: z.string().min(1).max(4000).nullish(),
    orchestrator_effort: z.string().min(1).max(4000).nullish(),
  })
  .passthrough();
export type IngestBatchContext = z.infer<typeof IngestBatchContextSchema>;

/** The batched-upload REQUEST body. */
export const IngestBatchRequestSchema = z
  .object({
    run_id: z.string().min(1),
    events: z.array(IngestEventRecordSchema),
    context: IngestBatchContextSchema.nullish(),
  })
  .passthrough();
export type IngestBatchRequest = z.infer<typeof IngestBatchRequestSchema>;

/** The ingest RESPONSE: how many records were newly stored vs. deduped. */
export const IngestBatchResponseSchema = z
  .object({
    run_id: z.string().min(1),
    inserted: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
  })
  .passthrough();
export type IngestBatchResponse = z.infer<typeof IngestBatchResponseSchema>;
