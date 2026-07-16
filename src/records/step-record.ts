import { z } from "zod";
import { RECORD_OUTCOMES } from "../common/outcomes.js";
import { QuestionSchema } from "../common/question.js";

/**
 * The STEP RECORD — what a step-executor reports (mirrors OSS
 * `STEP_RECORD_SCHEMA` in `apps/pipeline-cli/src/lib/step-schema.ts`). It is the
 * `structured_output` of the Claude envelope AND what an executor writes to its
 * step-record file. Only `outcome` is required; everything else is optional.
 *
 * The `question` uses the shared {@link QuestionSchema}, which carries the v5
 * additive `question_id` (G3).
 */

// Outcome value spaces live in `../common/outcomes` (shared with the
// `iteration.completed` event); re-exported below for convenient import.
export { ENGINE_OUTCOMES, RECORD_OUTCOMES } from "../common/outcomes.js";
export type { EngineOutcome, RecordOutcome } from "../common/outcomes.js";

export const StepRecordSchema = z
  .object({
    outcome: z.enum(RECORD_OUTCOMES),
    /** One-line human summary of what the step did. */
    summary: z.string().nullable().optional(),
    /** Absolute path of the next iteration, or "PIPELINE_COMPLETE"; null/absent
     *  in graph/DAG modes where the engine routes. */
    next_iteration: z.string().nullable().optional(),
    halt_reason: z.string().nullable().optional(),
    has_improvement_brief: z.boolean().optional(),
    /** Graph-mode routing flags. */
    flags: z.record(z.unknown()).nullable().optional(),
    worktree_branch: z.string().nullable().optional(),
    worktree_path: z.string().nullable().optional(),
    /** blocked-delegating: the blocker brief. */
    blocker_delegation: z.record(z.unknown()).nullable().optional(),
    /** Optional structured step output persisted to the run's outputs store. */
    output: z.record(z.unknown()).nullable().optional(),
    /** needs-input: the question for the caller (with v5 `question_id`, G3). */
    question: QuestionSchema.nullable().optional(),
  })
  .passthrough();
export type StepRecord = z.infer<typeof StepRecordSchema>;

/** Re-export the shared question shape under the OSS name for parity. */
export { QuestionSchema as StepQuestionSchema } from "../common/question.js";
export type { Question as StepQuestion } from "../common/question.js";
