/**
 * The pipeline outcome value spaces — shared by the `iteration.completed` event
 * (`events/types.ts`) and the step record (`records/step-record.ts`) so the
 * contract has ONE source of truth. Mirrors OSS `ENGINE_OUTCOMES` /
 * `RECORD_OUTCOMES` (`apps/pipeline-cli/src/lib/step-schema.ts`).
 */

/** Outcomes the `pipeline next` ENGINE accepts on a step record. */
export const ENGINE_OUTCOMES = ["completed", "halted", "blocked-delegating", "depth-exhausted"] as const;

/** Everything a headless executor may report — the engine outcomes plus
 *  `needs-input`, which `pipeline drive` intercepts BEFORE the engine (the run
 *  parks awaiting an answer; the engine never sees a needs-input record). */
export const RECORD_OUTCOMES = [...ENGINE_OUTCOMES, "needs-input"] as const;

export type EngineOutcome = (typeof ENGINE_OUTCOMES)[number];
export type RecordOutcome = (typeof RECORD_OUTCOMES)[number];
