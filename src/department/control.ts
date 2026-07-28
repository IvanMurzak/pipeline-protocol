import { z } from "zod";
import { wireVariant } from "../wire/envelope.js";
import { DeptMessageSchema } from "./task.js";

/**
 * `department.config_update` / `department.message` / `department.cancel`
 * (cloud → runner) and `department.ready` (runner → cloud) —
 * `08-protocol-delta.md` §4/§5. Grouped here as the "control" frames that
 * aren't offer/lease/event/artifact traffic (08 §2's module layout does not
 * name a separate home for `department.message`; it is a small
 * control-shaped frame like `cancel`, so it lives alongside it here).
 */

/**
 * A department's declared execution limits, echoed down on
 * `department.config_update.limits` from its manifest (06: `taskTimeout`,
 * `parkExpiry`, `maxArtifactBytes`, `retrySafe`). All optional — a
 * manifest that hasn't declared one simply omits it.
 */
export const DeptLimitsSchema = z
  .object({
    /** Wall-clock task timeout (duration string, e.g. `"2h"`). */
    taskTimeout: z.string().min(1).optional(),
    /** How long a parked (input-required) task stays claimable (e.g. `"7d"`). */
    parkExpiry: z.string().min(1).optional(),
    /** Per-artifact byte cap this department declares (≤ the D9 1 MiB hard cap). */
    maxArtifactBytes: z.number().int().positive().optional(),
    /** Whether a failed task is safe to re-offer to another runner. */
    retrySafe: z.boolean().optional(),
  })
  .passthrough();
export type DeptLimits = z.infer<typeof DeptLimitsSchema>;

/**
 * `department.config_update` (cloud → runner) — sent on install approval and
 * on reconnect. `runtime_profile` is an open, manifest-sourced config bag (no
 * fixed shape is specified beyond the department manifest itself), so it
 * validates as an open record rather than a fixed nested object — the
 * "inherently open by construction" carve-out in ADDITIVE-POLICY rule 3.
 */
export const DeptConfigUpdateMessageSchema = wireVariant("department.config_update", {
  department_id: z.string().min(1),
  /** Digest of the installed manifest version (`dept_installs.manifest_digest`). */
  manifest_digest: z.string().min(1),
  /** Open, manifest-sourced runtime configuration bag. */
  runtime_profile: z.record(z.unknown()),
  limits: DeptLimitsSchema,
});
export type DeptConfigUpdateMessage = z.infer<typeof DeptConfigUpdateMessageSchema>;

/**
 * `department.message` (cloud → runner) — mid-task input, delivered ONLY to
 * runtimes that declared the `midTaskInput` capability (07 §3: "a process
 * that declares `midTaskInput: false` will never receive `task.message`
 * while working").
 */
export const DeptControlMessageSchema = wireVariant("department.message", {
  task_id: z.string().min(1),
  execution_id: z.string().min(1),
  message: DeptMessageSchema,
});
export type DeptControlMessage = z.infer<typeof DeptControlMessageSchema>;

/**
 * `department.cancel` (cloud → runner) — cancel a department task. Distinct
 * from the existing run-scoped `cancel` (`../wire/server.ts`) — this cancels
 * ONE task within a department execution, not a whole pipeline run.
 */
export const DeptCancelMessageSchema = wireVariant("department.cancel", {
  task_id: z.string().min(1),
  execution_id: z.string().min(1),
  reason: z.string().nullable().optional(),
});
export type DeptCancelMessage = z.infer<typeof DeptCancelMessageSchema>;

/**
 * A department runtime's advertised capabilities on `department.ready`.
 * Names mirror the manifest's `communication` block (06: `acceptsMidTaskInput`,
 * `supportsCancellation`, `supportsStreaming`, `supportsCheckpoint`,
 * `maxMessageBytes`) — the same shape the A2A Agent Card capabilities project
 * from (06: `communication.supportsStreaming` → Agent Card
 * `capabilities.streaming`).
 */
export const DeptCapabilitiesSchema = z
  .object({
    acceptsMidTaskInput: z.boolean().optional(),
    supportsCancellation: z.boolean().optional(),
    supportsStreaming: z.boolean().optional(),
    supportsCheckpoint: z.boolean().optional(),
    maxMessageBytes: z.number().int().positive().optional(),
  })
  .passthrough();
export type DeptCapabilities = z.infer<typeof DeptCapabilitiesSchema>;

/**
 * `department.ready` (runner → cloud) — sent after a department's runtime
 * adapter installs and probes successfully. `adapter_health` is an open,
 * lenient string (ADDITIVE-POLICY rule 5) rather than a closed enum — no
 * fixed health-value set is specified yet.
 */
export const DeptReadyMessageSchema = wireVariant("department.ready", {
  department_id: z.string().min(1),
  /** Runtime adapter id — open value space, see `DeptOfferMessageSchema.adapter`. */
  adapter: z.string().min(1),
  capabilities: DeptCapabilitiesSchema,
  /** Adapter/probe health signal — open, lenient string (see doc above). */
  adapter_health: z.string().min(1),
});
export type DeptReadyMessage = z.infer<typeof DeptReadyMessageSchema>;
