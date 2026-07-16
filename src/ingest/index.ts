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

/** The batched-upload REQUEST body. */
export const IngestBatchRequestSchema = z
  .object({
    run_id: z.string().min(1),
    events: z.array(IngestEventRecordSchema),
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
