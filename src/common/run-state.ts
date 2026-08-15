/**
 * The single 7-state PUBLIC run vocabulary (D12, `pipeline-ui-v2` design task
 * `a1-protocol-run-state`) and its canonical mapper, `deriveRunState`, so every
 * consumer — CLI, runner, cloud API, web — derives the SAME state from the
 * same underlying signal instead of redefining it (01 §6 documents the
 * 12-vocabulary sprawl this collapses; ADDITIVE-POLICY.md governs how this
 * package versions). Source of truth for the mapping: `02-target-
 * architecture.md` §"Unified status model" (the pipeline-ui-v2 taskflow) —
 * `deriveRunState` implements that table exactly, one branch per column.
 *
 * ADDITIVE: a brand-new module, nothing existing changes shape.
 * `PROTOCOL_VERSION` stays `1`, `EVENT_SCHEMA_VERSION` stays `4` — see
 * `../version.ts` and `ADDITIVE-POLICY.md`.
 */

/** The public, CLOSED 7-state vocabulary every consumer renders against (D12).
 *  Sub-state detail — the web fold's `improving`/`scripting`/blocker-polling
 *  distinctions — survives only as a secondary label, never a top-level state
 *  (02 M5): this list must never grow past these seven. */
export const RUN_STATES = [
  "queued",
  "running",
  "needs-input",
  "needs-approval",
  "blocked",
  "failed",
  "done",
] as const;
export type RunState = (typeof RUN_STATES)[number];

// ── Column 1 — cloud DB run status/outcome + awaiting_kind ───────────────────
// (01 §6.1 #7-8: `cloud/apps/api/src/db/migrations/003_runs.sql:163-166`,
// `runs/types.ts:17,24-31`. `"blocked"` and the `awaiting_kind` column are the
// additive migration 02 describes — accepted here ahead of that migration
// landing, since this mapper is the additive-first contract other tasks build
// against.)

/** Cloud DB `runs.status` values, including the target-architecture additive
 *  `"blocked"` value (02 §Changes per repository, migration TBD). */
export const CLOUD_RUN_STATUSES = ["created", "running", "awaiting_input", "ended", "blocked"] as const;
export type CloudRunStatus = (typeof CLOUD_RUN_STATUSES)[number];

/** Cloud DB `runs.outcome` values — the terminal detail recorded alongside
 *  `status: "ended"`. */
export const CLOUD_RUN_OUTCOMES = ["success", "failed", "crashed", "stopped", "abandoned-needs-input"] as const;
export type CloudRunOutcome = (typeof CLOUD_RUN_OUTCOMES)[number];

/** The target-architecture `awaiting_kind` column distinguishing a plain
 *  question from an approval gate while `status: "awaiting_input"`. NULL on
 *  every historical row (the column predates 02) — the mapper treats
 *  NULL/absent as `"question"`, never as a guessed approval (M1/R7, and the
 *  DoD's NULL-`awaiting_kind` rule). */
export const AWAITING_KINDS = ["question", "approval"] as const;
export type AwaitingKind = (typeof AWAITING_KINDS)[number];

export interface CloudRunStateInput {
  source: "cloud";
  status: CloudRunStatus;
  /** Only meaningful when `status: "ended"`. */
  outcome?: CloudRunOutcome | null;
  /** Only meaningful when `status: "awaiting_input"`. NULL/absent ⇒ a plain
   *  question (M1/R7) — historical rows predating this column read the same
   *  way as an explicit `"question"`. */
  awaiting_kind?: AwaitingKind | null;
}

// ── Column 2 — CLI `drive` final-JSON status ──────────────────────────────────
// (01 §6.1 #3: `pipeline/src/commands/drive.ts:2911,2962,3095,3107,3121-3129,
// 3149,3160`.) The CLI JSON is only ever emitted once a run has left the
// queued/running phase, so those two table cells are unreachable from this
// source ("—" in the canonical table) — `deriveRunState` never receives a
// `CliDriveStateInput` claiming either.

/** CLI `drive` terminal/park status literals. */
export const CLI_DRIVE_STATUSES = ["completed", "halted", "depth-exhausted", "blocked", "awaiting-input"] as const;
export type CliDriveStatus = (typeof CLI_DRIVE_STATUSES)[number];

export interface CliDriveStateInput {
  source: "cli";
  status: CliDriveStatus;
  /** Only meaningful when `status: "awaiting-input"`. The shared
   *  `QuestionSchema`'s `approval` field (`./question.ts:59`) — its mere
   *  PRESENCE (non-null, non-undefined), not its content, distinguishes
   *  `needs-approval` from `needs-input` (M2: no new question type). */
  question?: { approval?: unknown } | null;
}

// ── Column 3 — journal / drive-snapshot signal ────────────────────────────────
// (02 canonical table + wire note: "Mid-run blocked-ness already has journal
// producers (`blocker.delegated`/`blocker.polling`/`blocker.resolved`,
// protocol `events/types.ts:276-278`, consumed by the web fold
// `lib/runs.ts:226-233`)". Cross-checked against that fold
// (`cloud/apps/web/src/lib/runs.ts`, not part of this repo):
// `pipeline.started`/`iteration.started`/`iteration.resumed`/`blocker.resolved`
// all set the fold to `"running"`; `improver.started` sets `"improving"`;
// `script_creator.started` sets `"scripting"` — all three collapse to the
// PUBLIC `"running"` state (M5). `iteration.completed`'s own outcome-dependent
// transition is a stateful fold concern the 02 table does not enumerate as a
// distinct journal signal, so it is deliberately not modeled as its own input
// case here — the table's "fold running/improving/scripting" cell is fully
// covered by the *_STARTED / resolved events below.)

/** Journal event types that put a run's public state at `"running"`
 *  (the fold's `running`/`improving`/`scripting` sub-states collapse here). */
export const JOURNAL_RUNNING_EVENTS = [
  "run.started",
  "pipeline.started",
  "iteration.started",
  "iteration.resumed",
  "improver.started",
  "script_creator.started",
  "blocker.resolved",
] as const;
export type JournalRunningEvent = (typeof JOURNAL_RUNNING_EVENTS)[number];

/** Journal event types that put a run's public state at `"blocked"`. */
export const JOURNAL_BLOCKED_EVENTS = ["blocker.delegated", "blocker.polling"] as const;
export type JournalBlockedEvent = (typeof JOURNAL_BLOCKED_EVENTS)[number];

/** Journal event types that put a run's public state at `"failed"`. */
export const JOURNAL_FAILED_EVENTS = ["pipeline.halted", "run.halted"] as const;
export type JournalFailedEvent = (typeof JOURNAL_FAILED_EVENTS)[number];

/** Journal event types that put a run's public state at `"done"`. */
export const JOURNAL_DONE_EVENTS = ["pipeline.completed", "run.completed"] as const;
export type JournalDoneEvent = (typeof JOURNAL_DONE_EVENTS)[number];

export interface JournalRunStateInput {
  source: "journal";
  /** `null`/absent ⇒ no `run.started` observed yet for this run — the
   *  canonical table's `queued` row ("`run.started` absent"). Otherwise the
   *  latest state-relevant journal/drive-snapshot event type observed. */
  event?: JournalRunningEvent | "awaiting_input" | JournalBlockedEvent | JournalFailedEvent | JournalDoneEvent | null;
  /** Only meaningful when `event: "awaiting_input"`. Mirrors the journalled
   *  `AwaitingInputData.question.approval` field's presence (see
   *  `CliDriveStateInput.question` above) — `true` ⇒ the approval gate
   *  distinguishes `needs-approval` from the default `needs-input`. */
  approval?: boolean;
}

// ── The mapper ────────────────────────────────────────────────────────────────

export type RunStateInput = CloudRunStateInput | CliDriveStateInput | JournalRunStateInput;

/**
 * Returned for any input this mapper does not recognize: a value that isn't
 * one of the three tagged shapes above, or a recognized `source` paired with a
 * status/outcome combination the canonical table does not define (e.g. a
 * cloud row with `status: "ended"` and no/unknown `outcome`). Documented and
 * unit-tested (DoD, 04 §4.7) rather than thrown: `deriveRunState` is a pure,
 * total function over `unknown` so a boundary that hasn't validated its input
 * yet can still call it safely.
 *
 * `"running"` is the deliberate choice: it is the only one of the 7 states
 * that is both non-terminal (never claims a definitive success/failure the
 * data didn't establish) and un-alarming (never demands the attention
 * `needs-input`/`needs-approval`/`blocked` badges imply for a signal that may
 * simply be from a newer, not-yet-understood peer) — additive-forward, in the
 * same spirit as `.passthrough()` elsewhere in this package.
 */
export const RUN_STATE_FALLBACK: RunState = "running";

function deriveFromCloud(input: CloudRunStateInput): RunState {
  switch (input.status) {
    case "created":
      return "queued";
    case "running":
      return "running";
    case "awaiting_input":
      // NULL/absent `awaiting_kind` ⇒ needs-input (M1/R7) — historical rows
      // read identically to an explicit "question", never guessed as approval.
      return input.awaiting_kind === "approval" ? "needs-approval" : "needs-input";
    case "blocked":
      return "blocked";
    case "ended":
      if (input.outcome === "success") return "done";
      if (input.outcome != null && (CLOUD_RUN_OUTCOMES as readonly string[]).includes(input.outcome)) {
        return "failed";
      }
      return RUN_STATE_FALLBACK;
    default:
      return RUN_STATE_FALLBACK;
  }
}

function deriveFromCli(input: CliDriveStateInput): RunState {
  switch (input.status) {
    case "awaiting-input":
      return input.question?.approval != null ? "needs-approval" : "needs-input";
    case "blocked":
      return "blocked";
    case "halted":
    case "depth-exhausted":
      return "failed";
    case "completed":
      return "done";
    default:
      return RUN_STATE_FALLBACK;
  }
}

function deriveFromJournal(input: JournalRunStateInput): RunState {
  const { event } = input;
  if (event == null) return "queued";
  if ((JOURNAL_RUNNING_EVENTS as readonly string[]).includes(event)) return "running";
  if (event === "awaiting_input") return input.approval === true ? "needs-approval" : "needs-input";
  if ((JOURNAL_BLOCKED_EVENTS as readonly string[]).includes(event)) return "blocked";
  if ((JOURNAL_FAILED_EVENTS as readonly string[]).includes(event)) return "failed";
  if ((JOURNAL_DONE_EVENTS as readonly string[]).includes(event)) return "done";
  return RUN_STATE_FALLBACK;
}

/**
 * The canonical mapper (02 §Unified status model): derive the one public
 * {@link RunState} from a cloud-DB row, a CLI `drive` final-JSON status, or a
 * journal/drive-snapshot signal — implementing every row of the canonical
 * table exactly. Pure and total: accepts `unknown` so a caller mid-parse can
 * call it before (or instead of) validating the input shape; anything that
 * doesn't match one of the three tagged `source` variants, or a
 * source/status combination the table leaves undefined, returns
 * {@link RUN_STATE_FALLBACK} (documented above).
 */
export function deriveRunState(input: unknown): RunState {
  if (input == null || typeof input !== "object") return RUN_STATE_FALLBACK;
  const source = (input as { source?: unknown }).source;
  switch (source) {
    case "cloud":
      return deriveFromCloud(input as CloudRunStateInput);
    case "cli":
      return deriveFromCli(input as CliDriveStateInput);
    case "journal":
      return deriveFromJournal(input as JournalRunStateInput);
    default:
      return RUN_STATE_FALLBACK;
  }
}
