import { describe, expect, test } from "bun:test";
import {
  DEPT_TASK_STATES,
  DeptMessageSchema,
  DeptPartSchema,
  DeptQuestionSchema,
  DeptTaskStateSchema,
} from "./task.js";

describe("DEPT_TASK_STATES", () => {
  test("pins the eight A2A v1.0 states, UNSPECIFIED dropped, prefix stripped", () => {
    // A2A v1.0 states minus TASK_STATE_UNSPECIFIED, TASK_STATE_ prefix stripped.
    expect(DEPT_TASK_STATES).toEqual([
      "SUBMITTED",
      "WORKING",
      "COMPLETED",
      "FAILED",
      "CANCELED",
      "INPUT_REQUIRED",
      "REJECTED",
      "AUTH_REQUIRED",
    ]);
    expect(DEPT_TASK_STATES.length).toBe(8);
    // Nothing carries the external spec's TASK_STATE_ prefix onto the wire.
    for (const state of DEPT_TASK_STATES) {
      expect(state.startsWith("TASK_STATE_")).toBe(false);
    }
  });

  test("DeptTaskStateSchema accepts every pinned state and rejects UNSPECIFIED / unknowns", () => {
    for (const state of DEPT_TASK_STATES) {
      expect(DeptTaskStateSchema.safeParse(state).success).toBe(true);
    }
    expect(DeptTaskStateSchema.safeParse("UNSPECIFIED").success).toBe(false);
    expect(DeptTaskStateSchema.safeParse("TASK_STATE_WORKING").success).toBe(false);
    expect(DeptTaskStateSchema.safeParse("bogus").success).toBe(false);
  });
});

describe("DeptPartSchema (A2A oneof {text|raw|url|data})", () => {
  test("accepts exactly one content member", () => {
    expect(DeptPartSchema.safeParse({ text: "hi" }).success).toBe(true);
    expect(DeptPartSchema.safeParse({ raw: "aGVsbG8=" }).success).toBe(true);
    expect(DeptPartSchema.safeParse({ url: "https://example.com/x" }).success).toBe(true);
    expect(DeptPartSchema.safeParse({ data: { a: 1 } }).success).toBe(true);
  });

  test("rejects ZERO content members", () => {
    expect(DeptPartSchema.safeParse({}).success).toBe(false);
    expect(DeptPartSchema.safeParse({ mediaType: "text/plain" }).success).toBe(false);
  });

  test("rejects TWO (or more) content members", () => {
    expect(DeptPartSchema.safeParse({ text: "hi", raw: "aGVsbG8=" }).success).toBe(false);
    expect(DeptPartSchema.safeParse({ text: "hi", url: "https://example.com" }).success).toBe(false);
    expect(
      DeptPartSchema.safeParse({ text: "hi", raw: "aGVsbG8=", url: "https://example.com", data: 1 }).success,
    ).toBe(false);
  });

  test("round-trips a `raw` base64 part with mediaType/filename/metadata", () => {
    const input = {
      raw: "aGVsbG8gd29ybGQ=",
      mediaType: "application/octet-stream",
      filename: "hello.bin",
      metadata: { source: "unit-test" },
    };
    const parsed = DeptPartSchema.parse(input);
    expect(parsed.raw).toBe(input.raw);
    expect(parsed.mediaType).toBe(input.mediaType);
    expect(parsed.filename).toBe(input.filename);
    expect(parsed.metadata).toEqual(input.metadata);
    // Full JSON round-trip is lossless too.
    const again = DeptPartSchema.parse(JSON.parse(JSON.stringify(parsed)));
    expect(again).toEqual(parsed);
  });

  test("is additive-forward: an unknown extra field survives a parse", () => {
    const parsed = DeptPartSchema.parse({ text: "hi", future_field: 42 });
    expect((parsed as Record<string, unknown>).future_field).toBe(42);
  });
});

describe("DeptMessageSchema", () => {
  function aMessage(overrides: Record<string, unknown> = {}) {
    return {
      message_id: "msg-1",
      role: "ROLE_USER",
      parts: [{ text: "Use Addressables." }],
      created_at: "2026-07-23T00:00:00.000Z",
      ...overrides,
    };
  }

  test("round-trips a valid message with optional fields", () => {
    const input = aMessage({
      context_id: "dctx_1",
      task_id: "dtask_1",
      reference_task_ids: ["dtask_0"],
      metadata: { origin: "cli" },
    });
    const parsed = DeptMessageSchema.parse(input);
    expect(parsed.message_id).toBe("msg-1");
    expect(parsed.role).toBe("ROLE_USER");
    expect(parsed.parts).toHaveLength(1);
    expect(parsed.reference_task_ids).toEqual(["dtask_0"]);
    const again = DeptMessageSchema.parse(JSON.parse(JSON.stringify(parsed)));
    expect(again).toEqual(parsed);
  });

  test("rejects a missing required field (message_id, role, parts, created_at)", () => {
    for (const key of ["message_id", "role", "parts", "created_at"]) {
      const bad = aMessage();
      delete (bad as Record<string, unknown>)[key];
      expect(DeptMessageSchema.safeParse(bad).success).toBe(false);
    }
  });

  test("rejects an empty `parts` array (min 1)", () => {
    expect(DeptMessageSchema.safeParse(aMessage({ parts: [] })).success).toBe(false);
  });

  test("rejects an out-of-enum role", () => {
    expect(DeptMessageSchema.safeParse(aMessage({ role: "ROLE_SYSTEM" })).success).toBe(false);
  });

  test("is additive-forward: an unknown extra field survives a parse (rule 3 passthrough)", () => {
    const parsed = DeptMessageSchema.parse(aMessage({ future_field: "x" }));
    expect((parsed as Record<string, unknown>).future_field).toBe("x");
  });
});

describe("DeptQuestionSchema (re-export of the shared QuestionSchema, 08 §3)", () => {
  test("parses an ordinary question and an approval-gated question unchanged", () => {
    expect(DeptQuestionSchema.safeParse({ text: "Android or iOS?" }).success).toBe(true);
    expect(
      DeptQuestionSchema.safeParse({
        text: "Ship it?",
        approval: { required_role: "admin" },
      }).success,
    ).toBe(true);
  });
});
