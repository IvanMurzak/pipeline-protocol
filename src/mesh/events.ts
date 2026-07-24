import { z } from "zod";
import { wireVariant } from "../wire/envelope.js";
import { DeptPartSchema, DeptQuestionSchema, DeptTaskStateSchema } from "./task.js";

/**
 * `department.event` (runner → cloud) — the normalized runtime event union
 * from `07-runtime-contract.md` §2 (`RuntimeEvent`), EXCLUDING `artifact`
 * (which has its own dedicated frame, `./artifact.ts` — artifacts are
 * first-class task data, not telemetry, per 07 §8). 08 §2 groups the
 * remaining kinds as `status | message | input_required | progress |
 * terminal`; `terminal` below is the two concrete kinds `completed` and
 * `failed`.
 *
 * Discriminant field name is `type`, mirroring `RuntimeEvent`'s own field
 * name in 07 §2 (nested — distinct from the outer wire envelope's `type`).
 * Each member is a plain `.passthrough()` `ZodObject` (ADDITIVE-POLICY rule
 * 3), never `.refine()`d, since they are `z.discriminatedUnion` members.
 */

/** A runtime status transition. `state` generalizes 07 §2's `'WORKING'`-only
 *  example to the full {@link DeptTaskStateSchema} enum, since a status
 *  event is the natural carrier for any non-terminal, non-input-required
 *  state transition a runtime reports. */
export const DeptStatusEventSchema = z
  .object({
    type: z.literal("status"),
    state: DeptTaskStateSchema,
    message: z.string().optional(),
  })
  .passthrough();

/** A message part emitted mid-task (e.g. incremental findings). */
export const DeptMessageEventSchema = z
  .object({
    type: z.literal("message"),
    parts: z.array(DeptPartSchema).min(1),
  })
  .passthrough();

/** The runtime needs input to continue — reuses {@link DeptQuestionSchema}
 *  (`./task.ts`) unchanged, per 08 §3. */
export const DeptInputRequiredEventSchema = z
  .object({
    type: z.literal("input_required"),
    question_id: z.string().min(1),
    question: DeptQuestionSchema,
  })
  .passthrough();

/** A free-text progress note (e.g. "12/40 scripts analysed"). */
export const DeptProgressEventSchema = z
  .object({
    type: z.literal("progress"),
    note: z.string().min(1),
  })
  .passthrough();

/** Terminal: the task finished successfully. */
export const DeptCompletedEventSchema = z
  .object({
    type: z.literal("completed"),
    summary: z.string().optional(),
  })
  .passthrough();

/** Terminal: the task failed. `retry_safe` tells the cloud whether a
 *  re-offer is safe (mirrors `RuntimeEvent`'s `retrySafe`, snake_cased for
 *  wire-naming consistency with the rest of this package). */
export const DeptFailedEventSchema = z
  .object({
    type: z.literal("failed"),
    reason: z.string().min(1),
    retry_safe: z.boolean(),
  })
  .passthrough();

/** The full runtime-event union carried by `department.event.event`. */
export const DeptRuntimeEventSchema = z.discriminatedUnion("type", [
  DeptStatusEventSchema,
  DeptMessageEventSchema,
  DeptInputRequiredEventSchema,
  DeptProgressEventSchema,
  DeptCompletedEventSchema,
  DeptFailedEventSchema,
]);
export type DeptRuntimeEvent = z.infer<typeof DeptRuntimeEventSchema>;

/**
 * `department.event` (runner → cloud) — carries an explicit `seq` scoped to
 * the execution so the cloud can enforce `PRIMARY KEY (task_id,
 * task_version)` idempotently and detect gaps — the same discipline the
 * shipper already applies with `(run_id, seq)`
 * (`public/pipeline-runner/src/shipper/wire-ingest.ts:21-25`).
 *
 * PRIVACY (07 §8): every new `department.*` event `type` MUST be added to
 * the runner shipper's `DATA_ALLOWLISTS` (`shipper/privacy.ts`) in the same
 * change that starts emitting it — an unlisted type ships `data: {}`, not a
 * schema-level concern but load-bearing for the runner-side wiring task.
 */
export const DeptEventMessageSchema = wireVariant("department.event", {
  execution_id: z.string().min(1),
  task_id: z.string().min(1),
  seq: z.number().int().nonnegative(),
  event: DeptRuntimeEventSchema,
});
export type DeptEventMessage = z.infer<typeof DeptEventMessageSchema>;
