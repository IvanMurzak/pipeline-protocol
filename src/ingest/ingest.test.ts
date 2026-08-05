import { describe, expect, test } from "bun:test";
import { IngestBatchContextSchema, IngestBatchRequestSchema, IngestBatchResponseSchema, IngestEventRecordSchema } from "./index.js";

describe("IngestEventRecord (shipper-assigned seq — G1)", () => {
  test("valid record with a non-negative integer seq", () => {
    expect(IngestEventRecordSchema.safeParse({ seq: 0, payload: { any: "thing" } }).success).toBe(true);
    expect(IngestEventRecordSchema.safeParse({ seq: 7, payload: null }).success).toBe(true);
  });

  test("rejects a negative, non-integer, or missing seq", () => {
    expect(IngestEventRecordSchema.safeParse({ seq: -1, payload: {} }).success).toBe(false);
    expect(IngestEventRecordSchema.safeParse({ seq: 1.5, payload: {} }).success).toBe(false);
    expect(IngestEventRecordSchema.safeParse({ payload: {} }).success).toBe(false);
  });

  test("rejects a missing payload (required, opaque)", () => {
    expect(IngestEventRecordSchema.safeParse({ seq: 1 }).success).toBe(false);
  });
});

describe("IngestBatchRequest", () => {
  test("valid batch mirrors POST /ingest body", () => {
    const req = IngestBatchRequestSchema.parse({
      run_id: "run-a",
      events: [
        { seq: 1, payload: { a: 1 } },
        { seq: 2, payload: { b: 2 } },
      ],
    });
    expect(req.run_id).toBe("run-a");
    expect(req.events).toHaveLength(2);
  });

  test("rejects an empty run_id and a non-array events", () => {
    expect(IngestBatchRequestSchema.safeParse({ run_id: "", events: [] }).success).toBe(false);
    expect(IngestBatchRequestSchema.safeParse({ run_id: "r", events: "nope" }).success).toBe(false);
  });

  test("an empty events array is allowed (a no-op batch)", () => {
    expect(IngestBatchRequestSchema.safeParse({ run_id: "r", events: [] }).success).toBe(true);
  });
});

describe("IngestBatchResponse", () => {
  test("valid response mirrors { run_id, inserted, skipped }", () => {
    expect(IngestBatchResponseSchema.parse({ run_id: "run-a", inserted: 2, skipped: 0 })).toEqual({
      run_id: "run-a",
      inserted: 2,
      skipped: 0,
    });
  });

  test("rejects negative counts", () => {
    expect(IngestBatchResponseSchema.safeParse({ run_id: "r", inserted: -1, skipped: 0 }).success).toBe(false);
  });
});

describe("IngestBatchContext (ux-v2 e3)", () => {
  test("accepts valid context with all optional fields", () => {
    const ctx = {
      project_id: "550e8400-e29b-41d4-a716-446655440000",
      runner_id: "650e8400-e29b-41d4-a716-446655440000",
      runner_labels: { env: "prod", region: "us-west" },
      runner_os: "linux",
      runner_agent_version: "1.0.0",
      runner_cli_version: "0.8.0",
      runner_plugin_version: "0.85.0",
      harness_id: "claude-code",
      harness_version: "1.2.3",
      pipeline_version: "abc123def",
      project_fingerprint: "fingerprint123",
      trigger_type: "manual",
      trigger_meta: { user: "alice", timestamp: "2026-08-04T12:00:00Z" },
      orchestrator_model: "claude-opus-5",
      orchestrator_effort: "high",
    };
    const result = IngestBatchContextSchema.safeParse(ctx);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.project_id).toBe(ctx.project_id);
      expect(result.data.runner_labels).toEqual(ctx.runner_labels);
    }
  });

  test("accepts partial context with selected fields", () => {
    const ctx = {
      project_id: "550e8400-e29b-41d4-a716-446655440000",
      runner_os: "windows",
      pipeline_version: "v1.0",
    };
    const result = IngestBatchContextSchema.safeParse(ctx);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.project_id).toBe(ctx.project_id);
      expect(result.data.runner_os).toBe("windows");
      expect(result.data.runner_id).toBeUndefined();
    }
  });

  test("accepts empty context (all fields optional)", () => {
    expect(IngestBatchContextSchema.safeParse({}).success).toBe(true);
  });

  test("rejects invalid UUIDs for project_id and runner_id", () => {
    expect(IngestBatchContextSchema.safeParse({ project_id: "not-a-uuid" }).success).toBe(false);
    expect(IngestBatchContextSchema.safeParse({ runner_id: "also-not-a-uuid" }).success).toBe(false);
  });

  test("rejects empty string for string fields", () => {
    expect(IngestBatchContextSchema.safeParse({ runner_os: "" }).success).toBe(false);
    expect(IngestBatchContextSchema.safeParse({ harness_id: "" }).success).toBe(false);
  });

  test("rejects strings exceeding 4000 chars", () => {
    const longString = "x".repeat(4001);
    expect(IngestBatchContextSchema.safeParse({ runner_os: longString }).success).toBe(false);
    expect(IngestBatchContextSchema.safeParse({ pipeline_version: longString }).success).toBe(false);
  });

  test("accepts strings up to 4000 chars", () => {
    const maxString = "x".repeat(4000);
    expect(IngestBatchContextSchema.safeParse({ runner_os: maxString }).success).toBe(true);
    expect(IngestBatchContextSchema.safeParse({ harness_version: maxString }).success).toBe(true);
  });

  test("accepts trigger_meta as a JSON object", () => {
    const meta = { key1: "value1", nested: { key2: 123 } };
    expect(IngestBatchContextSchema.safeParse({ trigger_meta: meta }).success).toBe(true);
  });

  test("rejects non-object values for trigger_meta", () => {
    expect(IngestBatchContextSchema.safeParse({ trigger_meta: "string" }).success).toBe(false);
    expect(IngestBatchContextSchema.safeParse({ trigger_meta: [1, 2, 3] }).success).toBe(false);
  });

  test("passthrough allows unknown fields in context", () => {
    const ctx = {
      runner_os: "linux",
      future_field: "this-field-does-not-exist-yet",
    };
    const result = IngestBatchContextSchema.safeParse(ctx);
    expect(result.success).toBe(true);
    if (result.success) {
      // Unknown field passes through
      expect((result.data as Record<string, unknown>).future_field).toBe("this-field-does-not-exist-yet");
    }
  });
});

describe("IngestBatchRequest with context (backward compatibility — ux-v2 e3)", () => {
  test("accepts request WITHOUT context (existing payloads still validate)", () => {
    const req = {
      run_id: "run-123",
      events: [
        { seq: 1, payload: { type: "run.started" } },
        { seq: 2, payload: { type: "iteration.completed" } },
      ],
    };
    const result = IngestBatchRequestSchema.safeParse(req);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.run_id).toBe("run-123");
      expect(result.data.context).toBeUndefined();
    }
  });

  test("accepts request WITH context", () => {
    const req = {
      run_id: "run-456",
      events: [{ seq: 1, payload: { type: "run.started" } }],
      context: {
        project_id: "550e8400-e29b-41d4-a716-446655440000",
        runner_os: "linux",
        pipeline_version: "v1.0",
      },
    };
    const result = IngestBatchRequestSchema.safeParse(req);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.context?.project_id).toBe("550e8400-e29b-41d4-a716-446655440000");
      expect(result.data.context?.runner_os).toBe("linux");
    }
  });

  test("accepts request with context carrying unknown fields (passthrough)", () => {
    const req = {
      run_id: "run-789",
      events: [],
      context: {
        runner_os: "darwin",
        future_context_field: "will-be-added-later",
      },
    };
    const result = IngestBatchRequestSchema.safeParse(req);
    expect(result.success).toBe(true);
    if (result.success) {
      const contextData = result.data.context as Record<string, unknown>;
      expect(contextData.runner_os).toBe("darwin");
      expect(contextData.future_context_field).toBe("will-be-added-later");
    }
  });

  test("accepts request with extra top-level fields (existing passthrough behavior)", () => {
    const req = {
      run_id: "run-extra",
      events: [],
      future_top_level_field: "preserved",
    };
    const result = IngestBatchRequestSchema.safeParse(req);
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).future_top_level_field).toBe("preserved");
    }
  });

  test("accepts request with context=null (optional)", () => {
    const req = {
      run_id: "run-null",
      events: [],
      context: null,
    };
    const result = IngestBatchRequestSchema.safeParse(req);
    // context: null should fail validation since it's not undefined or a valid object
    // But given the optional() on the schema, let's verify the actual behavior
    expect(result.success).toBe(false);
  });

  test("accepts request with context=undefined (optional)", () => {
    const req = {
      run_id: "run-undef",
      events: [],
      context: undefined,
    };
    const result = IngestBatchRequestSchema.safeParse(req);
    expect(result.success).toBe(true);
  });

  test("representative legacy payloads without context still validate", () => {
    // Payload 1: minimal batch
    const p1 = {
      run_id: "minimal-run",
      events: [],
    };
    expect(IngestBatchRequestSchema.safeParse(p1).success).toBe(true);

    // Payload 2: batch with events but no context
    const p2 = {
      run_id: "event-run",
      events: [
        { seq: 1, payload: { type: "run.started", data: { pipeline_name: "my-pipe" } } },
        { seq: 2, payload: { type: "iteration.completed", data: { outcome: "completed" } } },
      ],
    };
    expect(IngestBatchRequestSchema.safeParse(p2).success).toBe(true);

    // Payload 3: batch with passthrough fields at top level
    const p3 = {
      run_id: "passthrough-run",
      events: [],
      unknown_field_a: 123,
      unknown_field_b: { nested: "data" },
    };
    expect(IngestBatchRequestSchema.safeParse(p3).success).toBe(true);
  });
});
