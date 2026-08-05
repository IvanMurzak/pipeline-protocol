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

describe("IngestBatchContext (ux-v2 e3): comprehensive verification", () => {
  test("nullish behavior: both undefined and null are accepted (derive.ts:73-121)", () => {
    // All fields accept undefined (field absent)
    expect(IngestBatchContextSchema.safeParse({}).success).toBe(true);

    // All fields accept null (field present but null)
    expect(IngestBatchContextSchema.safeParse({ pipeline_version: null }).success).toBe(true);
    expect(IngestBatchContextSchema.safeParse({ project_id: null }).success).toBe(true);
    expect(IngestBatchContextSchema.safeParse({ runner_os: null }).success).toBe(true);
    expect(IngestBatchContextSchema.safeParse({ harness_version: null }).success).toBe(true);
    expect(IngestBatchContextSchema.safeParse({ trigger_meta: null }).success).toBe(true);
  });

  test("trigger_type enum: accepts all 5 server-defined values (types.ts:50)", () => {
    // The server validates against ["manual", "cron", "webhook", "api", "matrix"]
    expect(IngestBatchContextSchema.safeParse({ trigger_type: "manual" }).success).toBe(true);
    expect(IngestBatchContextSchema.safeParse({ trigger_type: "cron" }).success).toBe(true);
    expect(IngestBatchContextSchema.safeParse({ trigger_type: "webhook" }).success).toBe(true);
    expect(IngestBatchContextSchema.safeParse({ trigger_type: "api" }).success).toBe(true);
    expect(IngestBatchContextSchema.safeParse({ trigger_type: "matrix" }).success).toBe(true);

    // Rejects values outside the enum
    expect(IngestBatchContextSchema.safeParse({ trigger_type: "nonsense" }).success).toBe(false);
    expect(IngestBatchContextSchema.safeParse({ trigger_type: "scheduled" }).success).toBe(false);
  });

  test("UUID validation: project_id and runner_id must be valid UUIDs when non-null", () => {
    const validUuid = "550e8400-e29b-41d4-a716-446655440000";
    expect(IngestBatchContextSchema.safeParse({ project_id: validUuid }).success).toBe(true);
    expect(IngestBatchContextSchema.safeParse({ runner_id: validUuid }).success).toBe(true);

    // Non-UUID strings rejected
    expect(IngestBatchContextSchema.safeParse({ project_id: "not-a-uuid" }).success).toBe(false);
    expect(IngestBatchContextSchema.safeParse({ runner_id: "also-invalid" }).success).toBe(false);
  });

  test("string length: non-null strings must be 1–4000 chars (derive.ts:91)", () => {
    const emptyString = "";
    const singleChar = "x";
    const maxString = "x".repeat(4000);
    const oversizeString = "x".repeat(4001);

    // Empty rejected
    expect(IngestBatchContextSchema.safeParse({ runner_os: emptyString }).success).toBe(false);

    // Min 1 char accepted
    expect(IngestBatchContextSchema.safeParse({ runner_os: singleChar }).success).toBe(true);
    expect(IngestBatchContextSchema.safeParse({ harness_id: singleChar }).success).toBe(true);

    // Max 4000 accepted
    expect(IngestBatchContextSchema.safeParse({ pipeline_version: maxString }).success).toBe(true);

    // Over 4000 rejected
    expect(IngestBatchContextSchema.safeParse({ orchestrator_model: oversizeString }).success).toBe(false);
  });

  test("trigger_meta: must be object (not string, number, array)", () => {
    expect(IngestBatchContextSchema.safeParse({ trigger_meta: { key: "value" } }).success).toBe(true);
    expect(IngestBatchContextSchema.safeParse({ trigger_meta: {} }).success).toBe(true);

    // Reject non-objects
    expect(IngestBatchContextSchema.safeParse({ trigger_meta: "string" }).success).toBe(false);
    expect(IngestBatchContextSchema.safeParse({ trigger_meta: 123 }).success).toBe(false);
    expect(IngestBatchContextSchema.safeParse({ trigger_meta: [1, 2, 3] }).success).toBe(false);
  });

  test("passthrough: unknown fields are preserved (forward compat)", () => {
    const result = IngestBatchContextSchema.safeParse({
      runner_os: "linux",
      future_field: "will-be-added-later",
      another_unknown: { nested: "data" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as Record<string, unknown>;
      expect(data.future_field).toBe("will-be-added-later");
      expect(data.another_unknown).toEqual({ nested: "data" });
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

  test("accepts request with context=null (nullish fields match server parsing)", () => {
    const req = {
      run_id: "run-null",
      events: [],
      context: null,
    };
    const result = IngestBatchRequestSchema.safeParse(req);
    // context: null is accepted because the field itself is optional().
    // Nullish fields inside context accept null to match derive.ts:73-121 behavior.
    expect(result.success).toBe(true);
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

  test("backward compatibility verification table (derive.ts matching)", () => {
    // Build a verification table of payloads to prove backward compatibility
    // Matches the coordinator's testing approach: accept/reject per payload
    const testCases = [
      {
        name: "no context (baseline)",
        payload: { run_id: "test-run", events: [] },
        expect: "accept",
      },
      {
        name: "context.pipeline_version = null (derive.ts:91 skips nulls)",
        payload: { run_id: "test-run", events: [], context: { pipeline_version: null } },
        expect: "accept",
      },
      {
        name: "context.project_id = valid UUID",
        payload: { run_id: "test-run", events: [], context: { project_id: "550e8400-e29b-41d4-a716-446655440000" } },
        expect: "accept",
      },
      {
        name: "context.runner_os = non-empty string",
        payload: { run_id: "test-run", events: [], context: { runner_os: "linux" } },
        expect: "accept",
      },
      {
        name: "context.harness_version = string",
        payload: { run_id: "test-run", events: [], context: { harness_version: "1.2.3" } },
        expect: "accept",
      },
      {
        name: "context.trigger_type = 'manual' (enum value)",
        payload: { run_id: "test-run", events: [], context: { trigger_type: "manual" } },
        expect: "accept",
      },
      {
        name: "context.trigger_type = 'cron' (enum value)",
        payload: { run_id: "test-run", events: [], context: { trigger_type: "cron" } },
        expect: "accept",
      },
      {
        name: "context.trigger_type = 'webhook' (enum value)",
        payload: { run_id: "test-run", events: [], context: { trigger_type: "webhook" } },
        expect: "accept",
      },
      {
        name: "context.trigger_type = 'api' (enum value)",
        payload: { run_id: "test-run", events: [], context: { trigger_type: "api" } },
        expect: "accept",
      },
      {
        name: "context.trigger_type = 'matrix' (enum value)",
        payload: { run_id: "test-run", events: [], context: { trigger_type: "matrix" } },
        expect: "accept",
      },
      {
        name: "context.trigger_meta = object",
        payload: { run_id: "test-run", events: [], context: { trigger_meta: { user: "alice" } } },
        expect: "accept",
      },
      {
        name: "context with only unknown fields",
        payload: { run_id: "test-run", events: [], context: { future_field: "data" } },
        expect: "accept",
      },
      {
        name: "project_id NOT a UUID",
        payload: { run_id: "test-run", events: [], context: { project_id: "not-uuid" } },
        expect: "reject",
      },
      {
        name: "runner_os empty string",
        payload: { run_id: "test-run", events: [], context: { runner_os: "" } },
        expect: "reject",
      },
      {
        name: "harness_version = number (wrong type)",
        payload: { run_id: "test-run", events: [], context: { harness_version: 123 } },
        expect: "reject",
      },
      {
        name: "trigger_meta = string (not object)",
        payload: { run_id: "test-run", events: [], context: { trigger_meta: "string" } },
        expect: "reject",
      },
      {
        name: "trigger_type = 'invalid' (not in enum)",
        payload: { run_id: "test-run", events: [], context: { trigger_type: "invalid" } },
        expect: "reject",
      },
    ];

    // Verify all test cases
    const results: string[] = [];
    for (const testCase of testCases) {
      const result = IngestBatchRequestSchema.safeParse(testCase.payload);
      const verdict = result.success ? "accept" : "reject";
      const match = verdict === testCase.expect ? "✓" : "✗ MISMATCH";
      results.push(`${match}  ${verdict.padEnd(6)}  ${testCase.name}`);
      expect(result.success).toBe(testCase.expect === "accept");
    }

    // Print verification table for inspection
    console.log("\n=== IngestBatchRequest verification table ===");
    results.forEach((r) => console.log(r));
    console.log("=== end table ===\n");
  });
});
