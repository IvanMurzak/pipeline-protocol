import { z } from "zod";

/**
 * The `stats.run_record` PAYLOAD — the wire contract for the runner
 * shipper's per-run measurement snapshot (design `08-cloud-sync.md` D12).
 * Mirrors the OSS plugin's `RunRecord` / `StepStat` / `TokenStats`
 * (`apps/pipeline-cli/src/lib/stats.ts:127-202`) field-for-field, PLUS two
 * OPTIONAL sync-mechanics fields the wire needs that the on-disk
 * `runs.jsonl` record does not carry: `revision` (D13) and `origin` (D18).
 * Both are optional with defined absent-semantics because already-deployed
 * runners ship the bare on-disk record — a required field would reject
 * every current-fleet payload (old runner + new cloud must keep working).
 *
 * ADDITIVE-POLICY conformance (see `../../ADDITIVE-POLICY.md`):
 * `.passthrough()` on every object here (unknown future fields survive a
 * relay unchanged); open value spaces (`outcome`, `halt_reason`, `runner`,
 * `mode`, `model`, `effort`, `failure_class`, `origin`) are validated as
 * lenient strings rather than closed enums, per policy rule 4 — a newer
 * emitter's new value is never rejected by an older protocol build (the
 * same reasoning as `ModelValue`/`EffortValue` in `../events/envelope.ts`).
 * This is a NEW file; `PROTOCOL_VERSION` stays 1 and
 * `EVENT_SCHEMA_VERSION` stays 4 — additive within the major. Package
 * version 0.1.1 → 0.2.0.
 */

/** The known `origin` value space (D18) — documented vocabulary, NOT a
 *  closed validation enum (policy rule 4; the space already widened once,
 *  D15 → D18). Absent on the wire ⇒ `"dispatched"`. */
export const RUN_RECORD_ORIGINS = ["dispatched", "local"] as const;
export type RunRecordOrigin = (typeof RUN_RECORD_ORIGINS)[number];

/** One step's measurement (mirrors OSS `StepStat`). */
export const StepStatSchema = z
  .object({
    id: z.string().min(1),
    /** ISO of the step.started line — null when only a completion was seen. */
    started_at: z.string().datetime({ offset: true }).nullable(),
    seconds: z.number().nullable(),
    /** Known space: `RECORD_OUTCOMES` (`../common/outcomes.js`) — lenient. */
    outcome: z.string().min(1),
    model: z.string().nullable(),
    /** Resolved reasoning effort the step ran with; null = inherited. */
    effort: z.string().nullable(),
    /** `'script'` for a `type: script` step executed in-process (zero LLM
     *  tokens) — ABSENT means an ordinary agent step (the default). */
    step_type: z.literal("script").optional(),
    /** Failure class of a FAILED script step (known space today:
     *  transient|binding|env|crash|contract|bug) — ABSENT on success and on
     *  every agent step. Lenient string. */
    failure_class: z.string().optional(),
  })
  .passthrough();
export type StepStat = z.infer<typeof StepStatSchema>;

/**
 * Aggregate token/tool measurement (mirrors OSS `TokenStats`). The four
 * required counters share the normalized-usage vocabulary of
 * `EnvelopeUsageSchema` (`./claude-envelope.js`) but the two shapes track
 * different upstreams (claude CLI envelope vs the plugin's stats fold) and
 * evolve independently, so they are deliberately NOT coupled.
 */
export const TokenStatsSchema = z
  .object({
    input: z.number(),
    output: z.number(),
    cache_read: z.number(),
    cache_creation: z.number(),
    tools_called: z.number().optional(),
    tools_failed: z.number().optional(),
    /** Per-tool failure counts, e.g. {"Bash": 3} — only present when the
     *  run had failures. The wire does not enforce consistency with
     *  `tools_failed`; consumers wanting one number should prefer summing
     *  `failed_tools` when present. */
    failed_tools: z.record(z.number()).optional(),
    agents_spawned: z.number().optional(),
    /** Total API cost in USD; absent for manager-transcript folds. */
    cost_usd: z.number().optional(),
  })
  .passthrough();
export type TokenStats = z.infer<typeof TokenStatsSchema>;

/**
 * The `stats.run_record` payload (mirrors OSS `RunRecord`) plus the
 * optional sync-mechanics fields `revision` (D13) and `origin` (D18). See
 * the file header for the additive-policy and compat rationale.
 */
export const RunRecordStatsSchema = z
  .object({
    /** The on-disk `runs.jsonl` record's own schema tag (plugin-side).
     *  Canonically `1` today; validated leniently as any positive integer —
     *  same policy as the event envelope's `schema` field — so a future
     *  additive plugin bump still parses. */
    schema: z.number().int().positive(),
    run_id: z.string().min(1),
    pipeline: z.string().min(1),
    started_at: z.string().datetime({ offset: true }).nullable(),
    ended_at: z.string().datetime({ offset: true }),
    duration_s: z.number().nullable(),
    /** Known space: `RECORD_OUTCOMES` (`../common/outcomes.js`) — lenient. */
    outcome: z.string().min(1),
    halt_reason: z.string().nullable(),
    runner: z.string(),
    mode: z.string().nullable(),
    steps_run: z.number(),
    steps: z.array(StepStatSchema),
    improver_runs: z.number(),
    improver_applied: z.number(),
    scripts_created: z.number(),
    merges: z.number(),
    merge_conflicts: z.number(),
    /** Count of AGENT-type step dispatches. Optional so records written
     *  BEFORE plugin 0.71 (which lack it) still parse — absent = "unknown". */
    llm_steps: z.number().optional(),
    /** null until the stats relay hook folds the transcripts. A finished
     *  run with `llm_steps === 0` finalizes this as explicit zeros instead. */
    tokens: TokenStatsSchema.nullable(),
    /** Sync-mechanics (D13): monotonic ship counter — incremented each time
     *  the shipper re-ships a superseding record (late token enrichment
     *  within the 14-day rescan window). ABSENT ⇒ `1` (a first ship from a
     *  runner that predates this field). The cloud's `stats_revision` guard
     *  makes an at-least-once replay of an older revision a no-op. */
    revision: z.number().int().nonnegative().optional(),
    /** Sync-mechanics (D18): how the run was started. Known space:
     *  {@link RUN_RECORD_ORIGINS} (`"dispatched"` = cloud-dispatched,
     *  `"local"` = started locally on a runner-registered machine, synced by
     *  default via the `sync_local_stats` flag + registration-time consent).
     *  Lenient string (policy rule 4). ABSENT ⇒ `"dispatched"`. */
    origin: z.string().optional(),
  })
  .passthrough();
export type RunRecordStats = z.infer<typeof RunRecordStatsSchema>;
