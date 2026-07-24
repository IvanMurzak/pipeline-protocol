import { z } from "zod";
import { wireVariant } from "../wire/envelope.js";
import { DeptMessageSchema } from "./task.js";

/**
 * `department.offer` (cloud → runner) / `department.accept` /
 * `department.reject` (runner → cloud) — `08-protocol-delta.md` §4/§5.
 *
 * `department.offer` mirrors `LeaseMessageSchema` (`../wire/server.ts`):
 * `lease_token` + `lease_ttl_s` play the same role as `job_jwt` +
 * `lease_ttl_s` there, and `event_seq_base` follows the SAME attempt-fencing
 * convention (`attempt × 1_000_000`, `jobs/service.ts:193,453`) so a retried
 * execution's events cannot collide with its predecessor's sequence numbers.
 *
 * **No execution token rides this frame.** An earlier draft had the
 * authorization server mint one and deliver it here; the corrected design
 * (13 §12) has the runner exchange its own client credentials for the MCP
 * execution token at the OAuth token endpoint, naming the `execution_id` it
 * was just offered — that keeps a bearer credential off a frame that is
 * logged, spooled, and persisted to the runner's job record (the same reason
 * `secret_slugs` carries names and never values). See 08 §8 — asserted by
 * the "no bearer token" sweep in `mesh.test.ts`.
 */
export const DeptOfferMessageSchema = wireVariant("department.offer", {
  execution_id: z.string().min(1),
  task_id: z.string().min(1),
  context_id: z.string().min(1),
  department_id: z.string().min(1),
  /** 1-based attempt number (mirrors the cloud's per-run attempt bookkeeping). */
  attempt: z.number().int().positive(),
  /** Lease-scoped renewal/revocation credential — NOT the MCP execution
   *  bearer token (see doc above); mirrors `job_jwt` on `LeaseMessageSchema`. */
  lease_token: z.string().min(1),
  lease_ttl_s: z.number().int().positive(),
  /** Runtime adapter id (e.g. `pipeline-drive` | `jsonl-process` |
   *  `container` | `native-a2a`, 07 §2.1). Open value space (ADDITIVE-POLICY
   *  rule 5) — a lenient string, not a closed enum, so a new adapter kind
   *  never requires a protocol bump. */
  adapter: z.string().min(1),
  messages: z.array(DeptMessageSchema).min(1),
  /** MIME types the caller accepts for output parts, e.g. `["text/markdown"]`. */
  accepted_output_modes: z.array(z.string()),
  deadline_at: z.string().datetime({ offset: true }),
  /** Starting shipper sequence number for this attempt's `department.event`s
   *  (the `attempt × 1_000_000` convention) — see doc above. */
  event_seq_base: z.number().int().nonnegative(),
});
export type DeptOfferMessage = z.infer<typeof DeptOfferMessageSchema>;

/**
 * `department.accept` (runner → cloud) — the runner accepts a
 * `department.offer`. Echo the offer's correlation `id`. Validated
 * cloud-side with the same four anti-spoof checks as `handleAccept`
 * (`jobs/service.ts:499-539`).
 */
export const DeptAcceptMessageSchema = wireVariant("department.accept", {
  execution_id: z.string().min(1),
  task_id: z.string().min(1),
});
export type DeptAcceptMessage = z.infer<typeof DeptAcceptMessageSchema>;

/** Why a runner declined a `department.offer` — a closed enum (08 §5). */
export const DEPT_REJECT_REASONS = ["busy", "capability", "policy", "broken_runtime"] as const;
export type DeptRejectReason = (typeof DEPT_REJECT_REASONS)[number];

/**
 * `department.reject` (runner → cloud) — the runner declines a
 * `department.offer` with an explicit reason. NEW BEHAVIOUR vs. the existing
 * fixed-pipeline lease path: today a decline sends nothing
 * (`public/pipeline-runner/src/jobs/manager.ts:31-33`) and the cloud burns
 * the 45s offer timeout learning that; this frame shortcuts it.
 */
export const DeptRejectMessageSchema = wireVariant("department.reject", {
  execution_id: z.string().min(1),
  reason: z.enum(DEPT_REJECT_REASONS),
});
export type DeptRejectMessage = z.infer<typeof DeptRejectMessageSchema>;
