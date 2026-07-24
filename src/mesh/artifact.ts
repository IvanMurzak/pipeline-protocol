import { z } from "zod";
import { wireVariant } from "../wire/envelope.js";

/**
 * `department.artifact` (runner → cloud) / `department.artifact_ack`
 * (cloud → runner) — `08-protocol-delta.md` §4/§5/§6.
 *
 * Artifacts do NOT ride the event-ingest path (JSON-event-shaped,
 * tier-filtered); they use these dedicated frames with:
 *   - chunking at 256 KiB per frame;
 *   - a per-artifact cap of 1 MiB and a per-task cap of 8 MiB (D9), enforced
 *     on the RUNNER FIRST so oversize data never crosses the wire;
 *   - `checksum` (sha256, hex) for dedupe and integrity, checked cloud-side
 *     before insert;
 *   - an explicit `department.artifact_ack` per artifact — rejection is
 *     always explicit; silent truncation is forbidden.
 */

/**
 * `department.artifact` (runner → cloud) — one CHUNK of an artifact upload.
 * `size` is the TOTAL artifact byte size (not this chunk's size); `bytes` is
 * THIS chunk's payload, base64-encoded. `chunk_index` is 0-based.
 */
export const DeptArtifactMessageSchema = wireVariant("department.artifact", {
  execution_id: z.string().min(1),
  task_id: z.string().min(1),
  name: z.string().min(1),
  media_type: z.string().min(1),
  /** Total artifact size in bytes (across all chunks), NOT this chunk's size. */
  size: z.number().int().nonnegative(),
  /** sha256 checksum of the FULL artifact (hex), for dedupe + integrity. */
  checksum: z.string().min(1),
  /** 0-based index of this chunk. */
  chunk_index: z.number().int().nonnegative(),
  /** Total chunk count for this artifact. */
  chunk_total: z.number().int().positive(),
  /** This chunk's payload, base64-encoded. */
  bytes: z.string().min(1),
});
export type DeptArtifactMessage = z.infer<typeof DeptArtifactMessageSchema>;

/**
 * `department.artifact_ack` (cloud → runner) — explicit accept/reject of an
 * uploaded artifact, once all chunks are received and reassembled. Rejection
 * is always explicit, never silent truncation (08 §6).
 */
export const DeptArtifactAckMessageSchema = wireVariant("department.artifact_ack", {
  artifact_id: z.string().min(1),
  accepted: z.boolean(),
  /** Rejection reason; absent/null when `accepted: true`. */
  reason: z.string().nullable().optional(),
});
export type DeptArtifactAckMessage = z.infer<typeof DeptArtifactAckMessageSchema>;
