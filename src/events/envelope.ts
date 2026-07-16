import { z } from "zod";

/**
 * The v4 event ENVELOPE — the common shell every journalled event shares
 * (mirrors OSS `apps/pipeline-ui/EVENTS.md` §"Common envelope"):
 *
 * ```jsonc
 * { schema, ts, type, project_root, worktree, run_id, parent_run_id,
 *   session_id, data }
 * ```
 *
 * The per-`type` `data` payloads and the discriminated union over `type` live
 * in `./types.ts`; this module owns the SHARED fields and the `run_id` rule.
 *
 * ── `run_id` nullability decision (spike-report G2) ─────────────────────────
 * v4 reality: `run_id` CAN be null — session-scoped events (`session.opened`,
 * ambient `tool.called`/`turn.usage` outside any run) carry `run_id: null`, and
 * the OSS fold simply does not attribute them to a run.
 *
 * DECISION for the protocol: the envelope keeps `run_id` **nullable** (so raw
 * journals — which legitimately contain session-scoped rows — still parse), but
 * a **shippable** event (anything the shipper uploads per-run to ingest) MUST
 * carry a non-null `run_id`. Session-scoped events (`run_id === null`) are a
 * SEPARATE concern: they belong to a per-session bucket, never the per-run
 * upload path. Enforced by {@link isShippableEvent} / `ShippableEventEnvelope`
 * in `./types.ts`. Rationale: a per-run shipper/consumer keyed on `(run_id,
 * seq)` (G1) cannot place a null-`run_id` row, and silently dropping it (the v4
 * behavior) is a data-loss hazard — so the contract makes the requirement
 * explicit at the boundary instead of leaving it implicit.
 */

/** Model value space (OSS `ModelValue`): a friendly alias, a canonical
 *  `claude-*` id, or null. Kept as a lenient `string | null` on purpose — the
 *  OSS daemon widened this value space (e.g. `fable`, exact canonical ids)
 *  WITHOUT a schema bump, so the wire must never reject a valid-but-unknown
 *  model string. */
export const ModelValue = z.string().nullable();

/** Reasoning-effort value space (`low|medium|high|xhigh|max` | null). Lenient
 *  `string | null` for the same reason as {@link ModelValue} — the OSS added
 *  this field's values additively without a schema bump. */
export const EffortValue = z.string().nullable();

/**
 * The shared envelope fields (WITHOUT `type`/`data`, which each per-type
 * variant supplies). Exported as a raw shape so `./types.ts` can spread it into
 * every discriminated-union member.
 */
export const eventEnvelopeBaseShape = {
  /** Wire event-schema version. Canonically `4` (v4 base + additive v5 delta);
   *  the parser accepts any positive integer so v1–v3 journals and a future
   *  explicit bump also parse. */
  schema: z.number().int().positive(),
  /** ISO-8601 UTC timestamp, e.g. `2026-05-21T18:42:11.342Z`. */
  ts: z.string().datetime({ offset: true }),
  /** Absolute path to the main repo working tree (never a worktree path). */
  project_root: z.string().min(1),
  /** Absolute worktree path, or null. */
  worktree: z.string().nullable(),
  /** Groups all events for one run. NULL only for session-scoped events, which
   *  are NOT shippable (see the G2 decision above). */
  run_id: z.string().min(1).nullable(),
  /** Set when this is a blocker-child run, else null. */
  parent_run_id: z.string().nullable(),
  /** The Claude session id, or null. */
  session_id: z.string().nullable(),
} as const;

/** The bare envelope (common fields only) as a standalone schema. */
export const EventEnvelopeBase = z.object(eventEnvelopeBaseShape);
export type EventEnvelopeBase = z.infer<typeof EventEnvelopeBase>;

/**
 * Build a discriminated-union member: the shared envelope + a `type` literal +
 * its `data` schema. `.passthrough()` keeps (and preserves) any envelope-level
 * field a newer peer adds — additive-forward compatibility.
 */
export function eventVariant<T extends string, D extends z.ZodTypeAny>(type: T, data: D) {
  return z
    .object({
      ...eventEnvelopeBaseShape,
      type: z.literal(type),
      data,
    })
    .passthrough();
}

/**
 * A TOLERANT envelope that accepts ANY `type` string with an opaque `data`.
 * Mirrors the OSS daemon's "unknown event types are tolerated" behavior — use
 * it to parse a raw journal / an event from a peer that may be a newer minor
 * (an unknown-to-us event type still validates as a well-formed envelope). The
 * strict, well-typed path is `EventEnvelope` + {@link parseEvent} in
 * `../index.ts`.
 */
export const AnyEventEnvelope = z
  .object({
    ...eventEnvelopeBaseShape,
    type: z.string().min(1),
    data: z.unknown(),
  })
  .passthrough();
export type AnyEvent = z.infer<typeof AnyEventEnvelope>;
