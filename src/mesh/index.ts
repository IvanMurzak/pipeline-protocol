import { DeptAcceptMessageSchema, DeptOfferMessageSchema, DeptRejectMessageSchema } from "./offer.js";
import { DeptLeaseRenewMessageSchema, DeptLeaseRevokedMessageSchema } from "./lease.js";
import { DeptEventMessageSchema } from "./events.js";
import { DeptArtifactAckMessageSchema, DeptArtifactMessageSchema } from "./artifact.js";
import {
  DeptCancelMessageSchema,
  DeptConfigUpdateMessageSchema,
  DeptControlMessageSchema,
  DeptReadyMessageSchema,
} from "./control.js";

/**
 * The `department.*` mesh wire vocabulary — assembled. Mirrors `../wire/
 * index.ts`'s `CLIENT_MESSAGE_VARIANTS` / `SERVER_MESSAGE_VARIANTS` pattern:
 * two variant tuples, one per direction, meant to be APPENDED to those
 * arrays (not a separate union) so `ClientMessage` / `ServerMessage` stay the
 * ONE discriminated union each side parses against (08 §2).
 */

// ── Re-export every schema, type, and constant from the mesh submodules ────
export * from "./task.js";
export * from "./offer.js";
export * from "./lease.js";
export * from "./events.js";
export * from "./artifact.js";
export * from "./control.js";

/** Every RUNNER → CLOUD (agent→server) mesh variant, keyed by `type`. */
export const DEPT_CLIENT_VARIANTS = [
  DeptReadyMessageSchema,
  DeptAcceptMessageSchema,
  DeptRejectMessageSchema,
  DeptLeaseRenewMessageSchema,
  DeptEventMessageSchema,
  DeptArtifactMessageSchema,
] as const;

/** Every CLOUD → RUNNER (server→agent) mesh variant, keyed by `type`. */
export const DEPT_SERVER_VARIANTS = [
  DeptConfigUpdateMessageSchema,
  DeptOfferMessageSchema,
  DeptControlMessageSchema,
  DeptCancelMessageSchema,
  DeptLeaseRevokedMessageSchema,
  DeptArtifactAckMessageSchema,
] as const;
