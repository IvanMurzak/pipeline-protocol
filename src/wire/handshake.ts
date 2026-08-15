import { z } from "zod";
import { isCompatible, PROTOCOL_VERSION } from "../version.js";
import { wireVariant } from "./envelope.js";

/**
 * HANDSHAKE / version negotiation for the `/agent/v1` WSS channel.
 *
 * The first frame a runner sends on connect is `register`; the control plane
 * replies with exactly one of `register_ack` (connection established, protocol
 * version negotiated) or `register_reject` (refused — bad/revoked token, or an
 * incompatible protocol major → "upgrade required").
 *
 * Negotiation encodes the ADDITIVE-WITHIN-A-MAJOR policy (ARCHITECTURE
 * §"Format versioning": "Additive-only within a major; runner and control plane
 * negotiate version on connect"). The load-bearing rule is `isCompatible`
 * (`../version.ts`) — REUSED here, not re-implemented: two peers speak iff they
 * share the protocol MAJOR. A same-major peer may emit new optional fields / new
 * message types the other harmlessly ignores; a differing major is rejected with
 * `upgrade_required`.
 */

/** Why the control plane refused a `register`. */
export const REGISTER_REJECT_REASONS = ["upgrade_required", "invalid_token", "revoked", "capacity"] as const;
export type RegisterRejectReason = (typeof REGISTER_REJECT_REASONS)[number];

/**
 * `register` (agent → server) — the opening frame. Advertises the runner's
 * identity token, matchable labels, environment, and the three independently
 * versioned engine surfaces (agent / CLI / plugin), plus the negotiated
 * `protocol_version`. Mirrors ARCHITECTURE §1 ("registers with runner token;
 * heartbeats; advertises labels + capacity") and the eval-dimension capture of
 * "Runner labels, OS, agent/CLI/plugin versions" (§Evaluation).
 *
 * The runner has no server-assigned id yet — the `runner_token` (scoped, hashed
 * at rest, revocable per ARCHITECTURE §Security) is the sole credential; the
 * server returns a stable `runner_id` on `register_ack`.
 */
export const RegisterMessageSchema = wireVariant("register", {
  /** Scoped runner token (org/project-scoped, revocable). The ONLY credential on
   *  this frame — Claude/BYOK credentials never ride the wire (§Security). */
  runner_token: z.string().min(1),
  /** Matchable labels: `os:windows`, `repo:acme/api`, `gpu`, custom (§1). */
  labels: z.array(z.string()),
  /** Operating system, e.g. "windows" | "linux" | "darwin". */
  os: z.string().min(1),
  /** `pipeline-runner` version. */
  agent_version: z.string().min(1),
  /** `pipeline` CLI (execution engine) version — skews independently of the wire
   *  protocol; the control plane tracks it for the pre-migration fleet check
   *  (ARCHITECTURE §"version-skew matrix"). */
  cli_version: z.string().min(1),
  /** `pipeline` plugin version, or null if not installed. */
  plugin_version: z.string().min(1).nullable().optional(),
  /** The runner's advertised protocol MAJOR — the input to negotiation below. */
  protocol_version: z.number().int().positive(),
  /** Max parallel runs this runner will accept (§1 "N parallel runs"). */
  capacity: z.number().int().positive().optional(),
  /** OPTIONAL installed department slugs (`08-protocol-delta.md` §7).
   *  Absent ⇒ this runner has no departments installed / predates department
   *  support — registers unchanged. */
  departments: z.array(z.string()).optional(),
  /** OPTIONAL mesh protocol capability version this runner speaks (08 §7).
   *  Independent of `protocol_version` below — mesh support is a
   *  CAPABILITY, not a version gate ({@link isRegisterCompatible} is
   *  deliberately untouched by the mesh addition). */
  mesh_protocol: z.number().int().positive().optional(),
  /**
   * OPTIONAL capability flag (`a3-protocol-chat-frames`, ADDITIVE, review
   * B3): `true` ⇒ this runner supports the P2.5 chat channel (`chat_send` /
   * `chat_reply`, `./server.ts` / `./client.ts`) and will route an inbound
   * `chat_send` into the run's executor session. CAPABILITY-KEYED, not
   * version-inferred — the SAME posture this package already took twice for
   * exactly this problem: `mesh_protocol` above ("a CAPABILITY, not a
   * version gate") and `heartbeat.runs_authoritative`
   * (`./client.ts`, "CAPABILITY-KEYED, not presence-keyed"). The nearest
   * analogue — mid-task text delivered into a running process — is
   * `department.message`, gated on a runtime's declared `midTaskInput`
   * capability (`../department/control.ts`) rather than inferred from a
   * version. The cloud MUST NOT infer chat support from `agent_version` or
   * `protocol_version`: an old runner that has never heard of `chat_send`
   * still parses it via the tolerant `AnyWireMessage` path
   * (`pipeline-runner/src/core/wire.ts`) and silently drops it — the SAME
   * observable failure as a rejected turn (review B2), with no trace at all.
   * Absent/`false` ⇒ the cloud must not send `chat_send` to this runner
   * (enforced d6-side); this is also the signal d6/e9 need to tell "chat
   * unavailable — old runner" apart from "chat unavailable — offline"
   * (`tasks/e9`).
   */
  chat_capable: z.boolean().optional(),
});
export type RegisterMessage = z.infer<typeof RegisterMessageSchema>;

/**
 * `register_ack` (server → agent) — connection accepted. Carries the NEGOTIATED
 * protocol major both sides will speak (always `PROTOCOL_VERSION` here, since a
 * mismatch is rejected, not degraded — additive-within-major has no minor to
 * negotiate down to yet), the server-assigned stable `runner_id`, and the
 * heartbeat cadence the server expects.
 */
export const RegisterAckMessageSchema = wireVariant("register_ack", {
  /** The negotiated protocol MAJOR. */
  protocol_version: z.number().int().positive(),
  /** Server-assigned stable runner identity (used on every later message). */
  runner_id: z.string().min(1),
  /** Expected heartbeat cadence in seconds (the lease/liveness TTL basis). */
  heartbeat_interval_s: z.number().int().positive().optional(),
  /** OPTIONAL: `true` when the cloud's mesh is enabled, so a mesh-capable
   *  runner knows whether to expect `department.offer`s; absent/`false` on a
   *  cloud without the mesh (mesh, `08-protocol-delta.md` §7). */
  mesh_enabled: z.boolean().optional(),
});
export type RegisterAckMessage = z.infer<typeof RegisterAckMessageSchema>;

/**
 * `register_reject` (server → agent) — connection refused. For
 * `upgrade_required` the server states the `min_protocol_version` it will speak,
 * so the runner can surface a precise "update the agent" message rather than a
 * blind reconnect loop.
 */
export const RegisterRejectMessageSchema = wireVariant("register_reject", {
  reason: z.enum(REGISTER_REJECT_REASONS),
  /** The minimum protocol MAJOR the server accepts — set on `upgrade_required`. */
  min_protocol_version: z.number().int().positive().optional(),
  /** Optional human-readable detail for logs / the runner console. */
  message: z.string().nullable().optional(),
});
export type RegisterRejectMessage = z.infer<typeof RegisterRejectMessageSchema>;

/**
 * The version half of the register handshake, as a pure predicate the T1-06
 * gateway can call before it decides `register_ack` vs `register_reject`. REUSES
 * `isCompatible` (`../version.ts`) — the single source of the additive-within-a-
 * major rule — rather than re-deriving it, so the policy lives in exactly one
 * place. (Token validity / capacity are the gateway's separate concern; this
 * only answers "can we speak the same protocol major?".)
 *
 * @returns true when the runner's advertised `protocol_version` shares this
 *   package's major, i.e. the connection may be `register_ack`-ed on version
 *   grounds; false ⇒ the gateway should `register_reject` with `upgrade_required`
 *   and `min_protocol_version: PROTOCOL_VERSION`.
 */
export function isRegisterCompatible(register: Pick<RegisterMessage, "protocol_version">): boolean {
  return isCompatible(register.protocol_version);
}

/** Re-export the negotiated major for gateway convenience (`min_protocol_version`
 *  on an `upgrade_required` reject is this value). */
export { PROTOCOL_VERSION } from "../version.js";
