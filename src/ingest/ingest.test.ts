import { describe, expect, test } from "bun:test";
import { IngestBatchRequestSchema, IngestBatchResponseSchema, IngestEventRecordSchema } from "./index.js";

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
