import { z } from "zod";

/**
 * The `stats.run_record` PAYLOAD — the wire contract for the runner
 * shipper's per-run measurement snapshot (design `08-cloud-sync.md` D12).
 * Mirrors the OSS plugin's `RunRecord` / `StepStat` / `TokenStats`
 * (`apps/pipeline-cli/src/lib/stats.ts:127-202`) field-for-field, PLUS two
 * sync-mechanics fields the wire needs that the on-disk `runs.jsonl` record
 * does not carry:
 *
 *  - `revision` (D13) — incremented each time the shipper re-ships a
 *    superseding record (late token enrichment, `tokens: null` → non-null,
 *    within the 14-day rescan window). The cloud's `stats_revision` guard
 *    column (D14) makes an at-least-once replay of an older revision a
 *    no-op at both run- and step-granularity.
 *  - `origin` (D18) — `"dispatched" | "local"`. Distinguishes a
 *    cloud-dispatched run from a locally-started run on a
 *    runner-registered machine (which also syncs by default, gated by the
 *    runner's `sync_local_stats` flag + registration-time consent).
 *
 * ADDITIVE-POLICY conformance (see `../../ADDITIVE-POLICY.md`): `.passthrough()`
 * on every object here (unknown future fields survive a relay unchanged);
 * every field beyond the run's identity/shape minimum is optional or
 * nullable, matching the OSS `RunRecord`'s own optionality (e.g. `llm_steps`
 * is absent on pre-0.71 records); open value spaces (`outcome`,
 * `halt_reason`, `runner`, `mode`, `model`, `effort`, `failure_class`) are
 * validated as lenient `string` / `string | null` rather than closed enums,
 * per rule 4 — a newer plugin build's new outcome/model/effort value is
 * never rejected by an older protocol build. This is a NEW file; it does
 * NOT change `PROTOCOL_VERSION` (stays 1) or `EVENT_SCHEMA_VERSION` (stays
 * 4) — additive within the major. Package version 0.1.1 → 0.2.0.
 */

/** One step's measurement (mirrors OSS `StepStat`, `stats.ts:127-146`). */
export const StepStatSchema = z
  .object({
    id: z.string().min(1),
    /** ISO of the step.started line — null when only a completion was seen
     *  (lets enrichment attribute a tool failure's timestamp to a step). */
    started_at: z.string().nullable(),
    seconds: z.number().nullable(),
    outcome: z.string().min(1),
    model: z.string().nullable(),
    /** Resolved reasoning effort the step ran with; null = inherited. */
    effort: z.string().nullable(),
    /** `'script'` for a `type: script` step executed in-process (zero LLM
     *  tokens) — ABSENT means an ordinary agent step (the default). */
    step_type: z.literal("script").optional(),
    /** Failure class of a FAILED script step (transient|binding|env|crash|
     *  contract|bug) — ABSENT on success and on every agent step. Validated
     *  as an open string per the file-header additive-policy note. */
    failure_class: z.string().optional(),
  })
  .passthrough();
export type StepStat = z.infer<typeof StepStatSchema>;

/** Aggregate token/tool measurement (mirrors OSS `TokenStats`, `stats.ts:148-162`). */
export const TokenStatsSchema = z
  .object({
    input: z.number(),
    output: z.number(),
    cache_read: z.number(),
    cache_creation: z.number(),
    tools_called: z.number().optional(),
    tools_failed: z.number().optional(),
    /** Per-tool failure counts, e.g. {"Bash": 3, "Edit": 1} — only present
     *  when the run had failures. */
    failed_tools: z.record(z.number()).optional(),
    agents_spawned: z.number().optional(),
    /** Total API cost in USD; absent for manager-transcript folds. */
    cost_usd: z.number().optional(),
  })
  .passthrough();
export type TokenStats = z.infer<typeof TokenStatsSchema>;

/**
 * The `stats.run_record` payload (mirrors OSS `RunRecord`, `stats.ts:175-202`)
 * PLUS the sync-mechanics fields `revision` (D13) and `origin` (D18). See the
 * file header for the additive-policy rationale.
 */
export const RunRecordStatsSchema = z
  .object({
    /** The on-disk `runs.jsonl` record's own schema tag (plugin-side);
     *  currently always 1. */
    schema: z.literal(1),
    run_id: z.string().min(1),
    pipeline: z.string().min(1),
    started_at: z.string().nullable(),
    ended_at: z.string(),
    duration_s: z.number().nullable(),
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
    /** Count of AGENT-type step dispatches (untagged `step.started` lines).
     *  Optional so records written BEFORE plugin 0.71 (which lack it) still
     *  parse — an absent value is "unknown". */
    llm_steps: z.number().optional(),
    /** null until the stats relay hook folds the transcripts. A finished
     *  run with `llm_steps === 0` finalizes this as explicit zeros instead. */
    tokens: TokenStatsSchema.nullable(),
    /** Sync-mechanics (D13): incremented each time the shipper re-ships a
     *  superseding record (late token enrichment within the 14-day rescan
     *  window). The cloud's `stats_revision` guard column makes an
     *  at-least-once replay of an older revision a no-op. */
    revision: z.number().int().nonnegative(),
    /** Sync-mechanics (D18): `"dispatched"` for a cloud-dispatched run,
     *  `"local"` for a run started locally on a runner-registered machine
     *  (synced by default, gated by the runner's `sync_local_stats` flag +
     *  registration-time consent). */
    origin: z.enum(["dispatched", "local"]),
  })
  .passthrough();
export type RunRecordStats = z.infer<typeof RunRecordStatsSchema>;
