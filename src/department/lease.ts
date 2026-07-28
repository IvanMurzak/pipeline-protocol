import { z } from "zod";
import { wireVariant } from "../wire/envelope.js";

/**
 * `department.lease_renew` (runner → cloud) / `department.lease_revoked`
 * (cloud → runner) — `08-protocol-delta.md` §4/§5, `07-runtime-contract.md`
 * §6.
 */

/**
 * `department.lease_renew` (runner → cloud) — sent at TTL/3 on the existing
 * heartbeat cadence (07 §6: "rather than adding a second timer"). Missing
 * two renewals expires the lease cloud-side on the sweeper tick.
 */
export const DeptLeaseRenewMessageSchema = wireVariant("department.lease_renew", {
  execution_id: z.string().min(1),
  lease_token: z.string().min(1),
});
export type DeptLeaseRenewMessage = z.infer<typeof DeptLeaseRenewMessageSchema>;

/**
 * `department.lease_revoked` (cloud → runner) — stop work; do NOT report
 * further state for this execution (07 §6).
 */
export const DeptLeaseRevokedMessageSchema = wireVariant("department.lease_revoked", {
  execution_id: z.string().min(1),
  reason: z.string().min(1),
});
export type DeptLeaseRevokedMessage = z.infer<typeof DeptLeaseRevokedMessageSchema>;
