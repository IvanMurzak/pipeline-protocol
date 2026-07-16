/**
 * Protocol versioning.
 *
 * Two INDEPENDENT version numbers ride the wire (see `docs/spike-report.md` §4
 * and ARCHITECTURE.md §"Format versioning & migrations"):
 *
 *  - {@link EVENT_SCHEMA_VERSION} — the integer stamped in each event
 *    envelope's `schema` field. The v4 journal is the base; the v5 delta this
 *    package ships is **purely additive** (new event types + new optional
 *    fields), which by the project's own policy does NOT bump the on-wire
 *    `schema` integer — exactly as EVENTS.md kept `schema: 4` across every
 *    additive addition (`step_id`, `manager.stopped`, `worktree.*`, …). So the
 *    canonical emitted value stays `4`, and older readers parse it unchanged.
 *
 *  - {@link PROTOCOL_VERSION} — the negotiated wire-protocol MAJOR for this
 *    `@baizor/pipeline-protocol` package (package version `0.1.0`, protocol major
 *    `1`). Runner and control plane exchange this on connect. Additive changes
 *    within a major stay compatible; a breaking change bumps the major.
 */

/** Negotiated wire-protocol MAJOR (this package). Additive within a major. */
export const PROTOCOL_VERSION = 1 as const;

/**
 * The integer written to each event envelope's `schema` field. The v4 base +
 * the additive v5 delta both emit `4` (additive changes do not bump it). The
 * parser still ACCEPTS any positive integer version (v1–v4 journals and a
 * future explicit bump) — see `EventEnvelope` in `events/envelope.ts`.
 */
export const EVENT_SCHEMA_VERSION = 4 as const;

/**
 * Additive-within-a-major compatibility check (STUB).
 *
 * Full version negotiation — capability flags, min-common-minor, graceful
 * degradation — is T1-02's job. Here we only encode the load-bearing policy
 * rule: two peers are wire-compatible iff they share the protocol MAJOR. A peer
 * on the same major may emit new optional fields / new event types that this
 * peer harmlessly ignores (additive-only); a differing major requires an
 * explicit negotiated bridge and is treated as incompatible.
 *
 * @param remoteMajor the remote peer's advertised {@link PROTOCOL_VERSION}.
 */
export function isCompatible(remoteMajor: number): boolean {
  return Number.isInteger(remoteMajor) && remoteMajor === PROTOCOL_VERSION;
}
