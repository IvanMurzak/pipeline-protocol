import { z } from "zod";

/**
 * The `/agent/v1` WSS message ENVELOPE — the common shell every runner↔control-
 * plane message shares. Where the event journal (`../events/`) frames each row
 * with a rich envelope (`schema`, `ts`, `run_id`, …), a *wire message* is a
 * transient control-channel frame, so its envelope is deliberately minimal:
 *
 *   - `type` — the discriminant. `ClientMessage`/`ServerMessage` (see
 *     `./index.ts`) are discriminated unions over it, exactly as `EventEnvelope`
 *     is over the event `type`.
 *   - `id`  — an OPTIONAL correlation id. Set on a request that expects a reply
 *     (a `lease`, a `heartbeat`, an `upload`, a `needs_input`), and ECHOED on the
 *     reply (`accept`, `heartbeat_ack`, `upload_ack`, `answer`) so a peer can pair
 *     a response to its request over a single multiplexed socket. Fire-and-forget
 *     messages (e.g. `run_status`, `cancel`) may omit it. Kept optional — not
 *     hard-required per message — so the request/reply convention stays a routing
 *     aid, not a schema gate (a T1-06 gateway decision, see follow-ups).
 *
 * Additive-forward compatibility, like the event envelope: every variant is
 * `.passthrough()`, so a field a newer peer adds is preserved rather than
 * rejected. Version negotiation happens once on connect (`./handshake.ts`), not
 * per-message — matching ARCHITECTURE §"Format versioning" ("negotiate version
 * on connect").
 */

/**
 * The shared envelope fields (WITHOUT `type`, which each per-type variant
 * supplies as a literal discriminant). Exported as a raw shape so the direction
 * modules can spread it into every message.
 */
export const wireEnvelopeBaseShape = {
  /** Correlation id: set on a request expecting a reply, echoed on the reply.
   *  Optional — omit for fire-and-forget messages (see module doc). */
  id: z.string().min(1).optional(),
} as const;

/** The bare wire envelope (common fields only) as a standalone schema. */
export const WireMessageBase = z.object({
  ...wireEnvelopeBaseShape,
  type: z.string().min(1),
});
export type WireMessageBase = z.infer<typeof WireMessageBase>;

/**
 * Build a discriminated-union member: the shared envelope + a `type` literal +
 * the message's own fields (spread from `shape`). `.passthrough()` keeps (and
 * preserves) any field a newer peer adds — additive-forward, mirroring
 * `eventVariant` in `../events/envelope.ts`.
 *
 * A reused T1-01 schema is embedded as a NAMED field (e.g. `{ batch:
 * IngestBatchRequestSchema }`) rather than merged, so the reuse is explicit and
 * no shape is ever re-declared — see `./client.ts` / `./server.ts`.
 */
export function wireVariant<T extends string, S extends z.ZodRawShape>(type: T, shape: S) {
  return z
    .object({
      ...wireEnvelopeBaseShape,
      type: z.literal(type),
      ...shape,
    })
    .passthrough();
}

/**
 * A TOLERANT wire message that accepts ANY `type` string with arbitrary extra
 * fields. Mirrors `AnyEventEnvelope` (`../events/envelope.ts`): use it to parse a
 * frame from a peer that may be a newer minor — an unknown-to-us message `type`
 * (a future additive addition) still validates as a well-formed envelope instead
 * of being rejected. The strict, well-typed paths are `ClientMessage` /
 * `ServerMessage` + `parseClientMessage` / `parseServerMessage` in `./index.ts`.
 */
export const AnyWireMessage = z
  .object({
    ...wireEnvelopeBaseShape,
    type: z.string().min(1),
  })
  .passthrough();
export type AnyWireMessage = z.infer<typeof AnyWireMessage>;
