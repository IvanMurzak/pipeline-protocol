import { describe, expect, test } from "bun:test";
import { DeptArtifactAckMessageSchema, DeptArtifactMessageSchema } from "./artifact.js";

function anArtifactChunk(overrides: Record<string, unknown> = {}) {
  return {
    type: "department.artifact",
    execution_id: "exec-1",
    task_id: "dtask_1",
    name: "review.md",
    media_type: "text/markdown",
    size: 12,
    checksum: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    chunk_index: 0,
    chunk_total: 1,
    bytes: "aGVsbG8gd29ybGQ=",
    ...overrides,
  };
}

describe("department.artifact (runner → cloud)", () => {
  test("round-trips a single-chunk artifact", () => {
    const parsed = DeptArtifactMessageSchema.parse(anArtifactChunk());
    expect(parsed.name).toBe("review.md");
    expect(parsed.chunk_index).toBe(0);
    expect(parsed.chunk_total).toBe(1);
    const again = DeptArtifactMessageSchema.parse(JSON.parse(JSON.stringify(parsed)));
    expect(again).toEqual(parsed);
  });

  test("round-trips a later chunk of a multi-chunk artifact", () => {
    const parsed = DeptArtifactMessageSchema.parse(
      anArtifactChunk({ chunk_index: 2, chunk_total: 5, size: 1_048_576 }),
    );
    expect(parsed.chunk_index).toBe(2);
    expect(parsed.chunk_total).toBe(5);
  });

  test("rejects a missing required field", () => {
    for (const key of [
      "execution_id",
      "task_id",
      "name",
      "media_type",
      "size",
      "checksum",
      "chunk_index",
      "chunk_total",
      "bytes",
    ]) {
      const bad = anArtifactChunk();
      delete (bad as Record<string, unknown>)[key];
      expect(DeptArtifactMessageSchema.safeParse(bad).success).toBe(false);
    }
  });

  test("an unknown extra field survives a parse", () => {
    const parsed = DeptArtifactMessageSchema.parse(anArtifactChunk({ future_field: "x" }));
    expect((parsed as Record<string, unknown>).future_field).toBe("x");
  });
});

describe("department.artifact_ack (cloud → runner)", () => {
  test("round-trips an accept and an explicit reject", () => {
    const accepted = DeptArtifactAckMessageSchema.parse({
      type: "department.artifact_ack",
      artifact_id: "art-1",
      accepted: true,
    });
    expect(accepted.accepted).toBe(true);

    const rejected = DeptArtifactAckMessageSchema.parse({
      type: "department.artifact_ack",
      artifact_id: "art-1",
      accepted: false,
      reason: "checksum mismatch",
    });
    expect(rejected.accepted).toBe(false);
    expect(rejected.reason).toBe("checksum mismatch");
  });

  test("rejects a missing required field", () => {
    expect(
      DeptArtifactAckMessageSchema.safeParse({ type: "department.artifact_ack", accepted: true }).success,
    ).toBe(false);
    expect(
      DeptArtifactAckMessageSchema.safeParse({ type: "department.artifact_ack", artifact_id: "art-1" }).success,
    ).toBe(false);
  });

  test("an unknown extra field survives a parse", () => {
    const parsed = DeptArtifactAckMessageSchema.parse({
      type: "department.artifact_ack",
      artifact_id: "art-1",
      accepted: true,
      future_field: 1,
    });
    expect((parsed as Record<string, unknown>).future_field).toBe(1);
  });
});
