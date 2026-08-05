/**
 * @baizor/pipeline-protocol — the wire-protocol contract shared between the
 * closed-source control-plane api and the open-source runner agent.
 *
 * Versioned ADDITIVE-ONLY within a major (see ADDITIVE-POLICY.md and
 * `docs/spike-report.md`). Exports: zod schemas + inferred TS types +
 * validators for every event, record, and ingest shape, plus the protocol
 * version constants.
 */
import { z } from "zod";
import { EventEnvelope, type Event } from "./events/types.js";

// ── Re-exports: schemas, inferred types, constants ───────────────────────────
// (outcome constants reach the barrel via `./records/index.js`; the shared
// question shape via `./common/question.js`.)
export * from "./version.js";
export * from "./common/question.js";
export * from "./events/index.js";
export * from "./records/index.js";
export * from "./ingest/index.js";
export * from "./wire/index.js";
export * from "./department/index.js";
// The privacy-tier filter (ux-v2 `e1`): the canonical copy of the agent-side
// trust boundary every shipper must run BEFORE anything is spooled or
// uploaded. See `./privacy/index.ts` for why the runner and the CLI still
// carry their own byte-identical copies, and how drift is guarded.
export * from "./privacy/index.js";
// The shared id mint point (ux-v2 `e2`): UUIDv7 generation promoted from the
// CLI (`newId`, `createIdGenerator`), plus the deterministic UUIDv5
// derivation (`uuidv5`) the server uses for its two derived step classes. See
// `./ids/index.ts`.
export * from "./ids/index.js";

// ── Event validators ─────────────────────────────────────────────────────────

/**
 * Parse an unknown value as a known, well-typed event. THROWS a `ZodError` on a
 * malformed known event or an unknown `type`. For tolerant parsing of an
 * unknown-but-well-formed envelope (a newer peer's new event type), use
 * `AnyEventEnvelope.parse` from `./events/envelope.ts`.
 *
 * FORWARD-COMPAT: "additive-only within a major" means a same-major peer may
 * emit an event `type` this build doesn't know yet. A strict `parseEvent`
 * REJECTS it — so a data-FORWARDING consumer (the ingest boundary, the mirror,
 * SSE fan-out) that must not drop a valid future event should validate with the
 * tolerant `AnyEventEnvelope`/`AnyShippableEnvelope` and treat the payload as
 * opaque, using `parseEvent` only where a fully-typed, known event is required.
 */
export function parseEvent(input: unknown): Event {
  return EventEnvelope.parse(input);
}

/** Non-throwing {@link parseEvent}: returns a zod `SafeParseReturnType`. */
export function safeParseEvent(input: unknown): z.SafeParseReturnType<unknown, Event> {
  return EventEnvelope.safeParse(input);
}
