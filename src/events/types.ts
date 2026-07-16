import { z } from "zod";
import { ENGINE_OUTCOMES } from "../common/outcomes.js";
import { QuestionSchema } from "../common/question.js";
import { AnyEventEnvelope, EffortValue, eventVariant, ModelValue } from "./envelope.js";

/**
 * Per-`type` event `data` schemas + the discriminated union over `type`.
 *
 * Faithfully mirrors the v4 event types in OSS `apps/pipeline-ui/EVENTS.md`,
 * PLUS the v5 ADDITIVE delta from `docs/spike-report.md` §4 (all new event
 * types / new optional fields — old consumers ignore them, new consumers gain
 * the signal):
 *   - run-lifecycle events `run.started` / `run.completed` / `run.halted`  (G4/G6)
 *   - `awaiting_input`                                                     (G7)
 *   - `question_id` on questions                                          (G3)
 *   - `resumed` + an `emission` counter on iteration events, `index` frozen
 *     as STABLE STEP IDENTITY                                             (G5)
 *
 * Each `data` object is `.passthrough()`: a field a newer peer adds is
 * preserved rather than rejected (additive-forward). Fields the OSS documents
 * as optional / version-added stay `.optional()` so v1–v4 journals all parse.
 */

// ── Closed value spaces this protocol OWNS. `ENGINE_OUTCOMES` (used on
// `iteration.completed`) is shared with the step record via `../common/outcomes`
// — `drive` intercepts `needs-input` before the engine, so it never appears on
// this event. The two below are events-only. ──────────────────────────────────

/** Script-step failure taxonomy (OSS frozen `FailureClass`). */
export const FAILURE_CLASSES = ["transient", "binding", "env", "crash", "contract", "bug"] as const;

/** `script_creator.completed.outcome`. */
export const SCRIPT_CREATOR_OUTCOMES = ["created", "updated", "refused"] as const;

// ── v4 event `data` schemas ──────────────────────────────────────────────────

export const SessionOpenedData = z.object({ claude_pid: z.number().int() }).passthrough();

export const PipelineStartedData = z
  .object({
    pipeline_name: z.string(),
    first_iteration_path: z.string(),
    pipeline_root: z.string(),
    default_model: ModelValue.optional(),
  })
  .passthrough();

export const IterationStartedData = z
  .object({
    iteration_path: z.string(),
    /** STABLE STEP IDENTITY (G5). NEVER an emission/attempt counter — see
     *  `emission` below. */
    index: z.number().int(),
    resolved_model: ModelValue.optional(),
    resolved_effort: EffortValue.optional(),
    step_id: z.string().optional(),
    step_type: z.literal("script").optional(),
    // ── v5 additive (G5) ──
    /** True when this `iteration.started` is a resume after a needs-input
     *  answer (vs. a fresh first run). Absent on v4 journals. */
    resumed: z.boolean().optional(),
    /** Attempt/emission counter for THIS step: 1 = first emit, 2 = re-emitted
     *  on resume, … Distinct from `index` (which stays the step's identity), so
     *  a consumer can tell "resumed after answer" from "ran twice". */
    emission: z.number().int().positive().optional(),
  })
  .passthrough();

export const IterationResumedData = z
  .object({
    iteration_path: z.string(),
    index: z.number().int(),
    resolved_model: ModelValue.optional(),
    resolved_effort: EffortValue.optional(),
    step_id: z.string().optional(),
    // v5 additive (G5)
    resumed: z.boolean().optional(),
    emission: z.number().int().positive().optional(),
  })
  .passthrough();

export const IterationCompletedData = z
  .object({
    // In parallel/DAG (`layer`) mode the OSS emitter sets iteration_path to
    // `step?.path ?? null` — nullable, not always a string (next.ts layer branch).
    iteration_path: z.string().nullable(),
    outcome: z.enum(ENGINE_OUTCOMES),
    // ABSENT in parallel/DAG (`layer`) emissions — the layer branch omits it
    // entirely (only the sequential/daemon branches include it). Optional so a
    // strict parse accepts a real parallel-run iteration.completed.
    next_iteration_path: z.string().nullable().optional(),
    // has_*/terminal are v2/v4 fields — optional so v1–v3 journals still parse
    // (OSS: a v4 daemon MUST parse v1/v2/v3; absent terminal derives from
    // next_iteration_path === null).
    has_improvement_brief: z.boolean().optional(),
    has_blocker_delegation: z.boolean().optional(),
    halt_reason: z.string().nullable().optional(),
    terminal: z.boolean().optional(),
    step_id: z.string().optional(),
    step_type: z.literal("script").optional(),
    failure_class: z.enum(FAILURE_CLASSES).optional(),
  })
  .passthrough();

export const ImproverStartedData = z.object({ iteration_path: z.string() }).passthrough();

export const ImproverCompletedData = z
  .object({
    iteration_path: z.string(),
    applied: z.boolean(),
    has_script_brief: z.boolean(),
  })
  .passthrough();

export const ScriptCreatorStartedData = z.object({ iteration_path: z.string() }).passthrough();

export const ScriptCreatorCompletedData = z
  .object({
    iteration_path: z.string(),
    script_path: z.string().nullable(),
    outcome: z.enum(SCRIPT_CREATOR_OUTCOMES),
  })
  .passthrough();

export const BlockerDelegatedData = z
  .object({
    parent_iteration_path: z.string(),
    blocker_issue_url: z.string(),
    child_run_id: z.string(),
    blocker_target_repo: z.string(),
  })
  .passthrough();

export const BlockerPollingData = z
  .object({ blocker_issue_url: z.string(), pr_state: z.string() })
  .passthrough();

export const BlockerResolvedData = z
  .object({ blocker_issue_url: z.string(), merged_pr_url: z.string() })
  .passthrough();

export const PipelineCompletedData = z.object({ pipeline_name: z.string() }).passthrough();

export const PipelineHaltedData = z
  .object({
    pipeline_name: z.string(),
    iteration_path: z.string(),
    halt_reason: z.string().nullable(),
  })
  .passthrough();

export const ManagerStoppedData = z
  .object({ run_id: z.string(), agent_id: z.string().nullable() })
  .passthrough();

export const WorktreeCreatedData = z
  .object({
    // On hook FAILURE the CLI emits `{ ok: false, detail }` with the success
    // fields absent — so everything but `ok` is optional.
    worktree_path: z.string().optional(),
    branch: z.string().optional(),
    env_file: z.string().nullable().optional(),
    port_base: z.number().nullable().optional(),
    ok: z.boolean(),
    hook_dir: z.string().optional(),
    detail: z.string().nullable().optional(),
  })
  .passthrough();

/** Shared shape for `worktree.finalized` / `worktree.destroyed`. `outcome` is a
 *  free string — the OSS never enumerated its value space. */
export const WorktreeTeardownData = z
  .object({
    worktree_path: z.string().nullable(),
    ok: z.boolean(),
    outcome: z.string(),
    detail: z.string().nullable(),
  })
  .passthrough();

export const ToolCalledData = z
  .object({
    tool_name: z.string(),
    success: z.boolean(),
    agent_spawn: z.boolean(),
    tool_use_id: z.string(),
  })
  .passthrough();

export const TurnUsageData = z
  .object({
    assistant_turns: z.number().int(),
    input_tokens: z.number().int(),
    output_tokens: z.number().int(),
    cache_read_tokens: z.number().int(),
    cache_creation_tokens: z.number().int(),
  })
  .passthrough();

// ── v5 ADDITIVE event `data` schemas ─────────────────────────────────────────

/**
 * Run-lifecycle events (G4/G6) — emitted by ANY orchestrator (`drive`
 * included), so pipeline-level framing does not depend on which orchestrator
 * ran the chain. `run.completed`/`run.halted` double as the END-OF-RUN signal
 * (G6) that lets the shipper bound its per-run `seq` state. Distinct from the
 * supervisor-only `pipeline.*` events. All fields optional/nullable so any
 * orchestrator can emit a minimal framing event.
 */
export const RunStartedData = z
  .object({
    pipeline_name: z.string().nullable().optional(),
    pipeline_root: z.string().nullable().optional(),
    first_iteration_path: z.string().nullable().optional(),
    /** Which orchestrator emitted this framing, e.g. "drive" | "pipeline-run". */
    orchestrator: z.string().nullable().optional(),
    default_model: ModelValue.optional(),
  })
  .passthrough();

export const RunCompletedData = z
  .object({
    pipeline_name: z.string().nullable().optional(),
    /** Terminal outcome, e.g. "completed" | "depth-exhausted". */
    outcome: z.string().nullable().optional(),
  })
  .passthrough();

export const RunHaltedData = z
  .object({
    pipeline_name: z.string().nullable().optional(),
    iteration_path: z.string().nullable().optional(),
    // Optional/nullable like the other run.* fields, so any orchestrator can
    // emit a minimal framing event (matches the module's stated design).
    halt_reason: z.string().nullable().optional(),
  })
  .passthrough();

/**
 * `awaiting_input` (G7) — the JOURNALLED needs-input signal (observability /
 * mirror). The v4 journal carried NO awaiting-input signal at all (the question
 * lived only in drive's exit-4 stdout). Shape per spike-report §4.3:
 * `{ run_id, iteration, question_id, question:{text,context,options} }`.
 *
 * NOTE (EVENTS.md v4 ambiguity resolved): the spike names the field `iteration`
 * without saying index-vs-path. We model it as the iteration INDEX (a number)
 * to correlate directly with `iteration.started.index` (the stable step
 * identity, G5). Flagged for follow-up if the emitter chooses the path instead.
 */
export const AwaitingInputData = z
  .object({
    run_id: z.string(),
    /** The iteration INDEX the run parked at (correlates with
     *  `iteration.started.index`). */
    iteration: z.number().int().nonnegative(),
    /** Stable question identity (G3), echoed by the answer. */
    question_id: z.string().min(1),
    question: QuestionSchema,
  })
  .passthrough();

// ── The discriminated union over `type` ──────────────────────────────────────

/** Every known event variant (envelope + typed `data`), keyed by `type`. */
export const EVENT_VARIANTS = [
  // v4
  eventVariant("session.opened", SessionOpenedData),
  eventVariant("pipeline.started", PipelineStartedData),
  eventVariant("iteration.started", IterationStartedData),
  eventVariant("iteration.resumed", IterationResumedData),
  eventVariant("iteration.completed", IterationCompletedData),
  eventVariant("improver.started", ImproverStartedData),
  eventVariant("improver.completed", ImproverCompletedData),
  eventVariant("script_creator.started", ScriptCreatorStartedData),
  eventVariant("script_creator.completed", ScriptCreatorCompletedData),
  eventVariant("blocker.delegated", BlockerDelegatedData),
  eventVariant("blocker.polling", BlockerPollingData),
  eventVariant("blocker.resolved", BlockerResolvedData),
  eventVariant("pipeline.completed", PipelineCompletedData),
  eventVariant("pipeline.halted", PipelineHaltedData),
  eventVariant("manager.stopped", ManagerStoppedData),
  eventVariant("worktree.created", WorktreeCreatedData),
  eventVariant("worktree.finalized", WorktreeTeardownData),
  eventVariant("worktree.destroyed", WorktreeTeardownData),
  eventVariant("tool.called", ToolCalledData),
  eventVariant("turn.usage", TurnUsageData),
  // v5 additive
  eventVariant("run.started", RunStartedData),
  eventVariant("run.completed", RunCompletedData),
  eventVariant("run.halted", RunHaltedData),
  eventVariant("awaiting_input", AwaitingInputData),
] as const;

/**
 * The strict, well-typed event schema: a discriminated union over `type`.
 * Rejects a malformed KNOWN event and an UNKNOWN `type`. For tolerant parsing
 * of an unknown-but-well-formed envelope (a newer peer's new event type), use
 * `AnyEventEnvelope` from `./envelope.ts`.
 */
export const EventEnvelope = z.discriminatedUnion("type", EVENT_VARIANTS);
export type Event = z.infer<typeof EventEnvelope>;

/** The literal string union of every known event `type`. */
export const EVENT_TYPES = EVENT_VARIANTS.map((v) => v.shape.type.value) as readonly Event["type"][];
export type EventType = Event["type"];

// ── Shippable-event rule (G2) ────────────────────────────────────────────────

/**
 * A SHIPPABLE event carries a non-null `run_id`. Session-scoped events
 * (`run_id === null`) belong to the session bucket, never the per-run upload
 * (see the G2 decision in `./envelope.ts`).
 */
export type ShippableEvent = Event & { run_id: string };

/** Type guard: is this parsed event shippable (non-null `run_id`)? */
export function isShippableEvent(event: Event): event is ShippableEvent {
  return event.run_id !== null;
}

/** Apply the single shippable-`run_id` refinement (shared by the strict +
 *  tolerant shippable schemas below so the predicate and message never drift). */
function refineShippable<S extends z.ZodType<{ run_id: string | null }>>(schema: S) {
  return schema.refine((e) => e.run_id !== null, {
    message: "shippable events must carry a non-null run_id (session-scoped events are not shipped per-run) — spike-report G2",
    path: ["run_id"],
  });
}

/**
 * Strict schema that ALSO enforces the shippable rule — parse an event the
 * shipper is about to upload with this to reject a null-`run_id` row at the
 * boundary. (A tolerant variant over `AnyEventEnvelope` is
 * {@link AnyShippableEnvelope}.)
 */
export const ShippableEventEnvelope = refineShippable(EventEnvelope);

/** Tolerant shippable check over `AnyEventEnvelope` (unknown types allowed, but
 *  the non-null `run_id` rule still enforced). */
export const AnyShippableEnvelope = refineShippable(AnyEventEnvelope);
