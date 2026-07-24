import { describe, expect, test } from "bun:test";
import {
  DeptCompletedEventSchema,
  DeptEventMessageSchema,
  DeptFailedEventSchema,
  DeptInputRequiredEventSchema,
  DeptMessageEventSchema,
  DeptProgressEventSchema,
  DeptRuntimeEventSchema,
  DeptStatusEventSchema,
} from "./events.js";

describe("DeptRuntimeEventSchema union members", () => {
  test("status: round-trips and rejects a missing required field", () => {
    expect(DeptStatusEventSchema.parse({ type: "status", state: "WORKING" }).state).toBe("WORKING");
    expect(DeptStatusEventSchema.safeParse({ type: "status" }).success).toBe(false);
    expect(DeptStatusEventSchema.safeParse({ type: "status", state: "bogus" }).success).toBe(false);
  });

  test("message: round-trips and rejects a missing/empty parts array", () => {
    const parsed = DeptMessageEventSchema.parse({ type: "message", parts: [{ text: "hi" }] });
    expect(parsed.parts).toHaveLength(1);
    expect(DeptMessageEventSchema.safeParse({ type: "message" }).success).toBe(false);
    expect(DeptMessageEventSchema.safeParse({ type: "message", parts: [] }).success).toBe(false);
  });

  test("input_required: round-trips and reuses DeptQuestionSchema", () => {
    const parsed = DeptInputRequiredEventSchema.parse({
      type: "input_required",
      question_id: "q-1",
      question: { text: "Android or iOS?", options: ["Android", "iOS"] },
    });
    expect(parsed.question_id).toBe("q-1");
    expect(parsed.question.text).toBe("Android or iOS?");
    expect(DeptInputRequiredEventSchema.safeParse({ type: "input_required", question_id: "q-1" }).success).toBe(
      false,
    );
  });

  test("progress: round-trips and rejects a missing note", () => {
    expect(DeptProgressEventSchema.parse({ type: "progress", note: "12/40" }).note).toBe("12/40");
    expect(DeptProgressEventSchema.safeParse({ type: "progress" }).success).toBe(false);
  });

  test("completed: round-trips with and without an optional summary", () => {
    expect(DeptCompletedEventSchema.parse({ type: "completed" }).summary).toBeUndefined();
    expect(DeptCompletedEventSchema.parse({ type: "completed", summary: "done" }).summary).toBe("done");
  });

  test("failed: round-trips and rejects a missing required field", () => {
    const parsed = DeptFailedEventSchema.parse({ type: "failed", reason: "unity not installed", retry_safe: false });
    expect(parsed.retry_safe).toBe(false);
    expect(DeptFailedEventSchema.safeParse({ type: "failed", reason: "x" }).success).toBe(false);
    expect(DeptFailedEventSchema.safeParse({ type: "failed", retry_safe: true }).success).toBe(false);
  });

  test("every union member is additive-forward: an unknown extra field survives a parse", () => {
    expect((DeptStatusEventSchema.parse({ type: "status", state: "WORKING", x: 1 }) as Record<string, unknown>).x).toBe(1);
    expect((DeptMessageEventSchema.parse({ type: "message", parts: [{ text: "hi" }], x: 1 }) as Record<string, unknown>).x).toBe(1);
    expect(
      (
        DeptInputRequiredEventSchema.parse({
          type: "input_required",
          question_id: "q-1",
          question: { text: "?" },
          x: 1,
        }) as Record<string, unknown>
      ).x,
    ).toBe(1);
    expect((DeptProgressEventSchema.parse({ type: "progress", note: "n", x: 1 }) as Record<string, unknown>).x).toBe(1);
    expect((DeptCompletedEventSchema.parse({ type: "completed", x: 1 }) as Record<string, unknown>).x).toBe(1);
    expect(
      (DeptFailedEventSchema.parse({ type: "failed", reason: "r", retry_safe: true, x: 1 }) as Record<string, unknown>).x,
    ).toBe(1);
  });

  test("DeptRuntimeEventSchema routes each kind by its `type` discriminant", () => {
    expect(DeptRuntimeEventSchema.parse({ type: "status", state: "WORKING" }).type).toBe("status");
    expect(DeptRuntimeEventSchema.parse({ type: "progress", note: "n" }).type).toBe("progress");
    expect(DeptRuntimeEventSchema.safeParse({ type: "artifact", name: "x" }).success).toBe(false); // artifact has its own frame
  });
});

describe("department.event (runner → cloud)", () => {
  test("round-trips wrapping each event kind, with `seq`", () => {
    const parsed = DeptEventMessageSchema.parse({
      type: "department.event",
      execution_id: "exec-1",
      task_id: "dtask_1",
      seq: 1_000_001,
      event: { type: "progress", note: "12/40 scripts analysed" },
    });
    expect(parsed.seq).toBe(1_000_001);
    expect(parsed.event.type).toBe("progress");
    const again = DeptEventMessageSchema.parse(JSON.parse(JSON.stringify(parsed)));
    expect(again).toEqual(parsed);
  });

  test("rejects a missing required field", () => {
    const base = {
      type: "department.event",
      execution_id: "exec-1",
      task_id: "dtask_1",
      seq: 1,
      event: { type: "progress", note: "n" },
    };
    for (const key of ["execution_id", "task_id", "seq", "event"]) {
      const bad = { ...base };
      delete (bad as Record<string, unknown>)[key];
      expect(DeptEventMessageSchema.safeParse(bad).success).toBe(false);
    }
  });

  test("rejects a malformed nested event (missing its own required field)", () => {
    expect(
      DeptEventMessageSchema.safeParse({
        type: "department.event",
        execution_id: "exec-1",
        task_id: "dtask_1",
        seq: 1,
        event: { type: "failed" }, // missing reason/retry_safe
      }).success,
    ).toBe(false);
  });

  test("an unknown extra field survives a parse at the envelope AND the nested event level", () => {
    const parsed = DeptEventMessageSchema.parse({
      type: "department.event",
      execution_id: "exec-1",
      task_id: "dtask_1",
      seq: 1,
      event: { type: "progress", note: "n", future_event_field: "y" },
      future_envelope_field: "z",
    });
    expect((parsed as Record<string, unknown>).future_envelope_field).toBe("z");
    expect((parsed.event as Record<string, unknown>).future_event_field).toBe("y");
  });
});
