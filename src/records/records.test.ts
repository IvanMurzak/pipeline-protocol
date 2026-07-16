import { describe, expect, test } from "bun:test";
import { AnswerMessageSchema, ClaudeEnvelopeSchema, StepRecordSchema } from "./index.js";

describe("ClaudeEnvelope", () => {
  test("a real result envelope parses", () => {
    const parsed = ClaudeEnvelopeSchema.parse({
      is_error: false,
      subtype: "success",
      result: '{"outcome":"completed"}',
      session_id: "sess-1",
      structured_output: { outcome: "completed" },
      total_cost_usd: 0.0123,
      usage: { input: 100, output: 50, cache_read: 10, cache_creation: 5 },
      num_turns: 3,
    });
    expect(parsed.structured_output).toEqual({ outcome: "completed" });
    expect(parsed.usage?.input).toBe(100);
  });

  test("null usage / structured_output are allowed", () => {
    expect(
      ClaudeEnvelopeSchema.safeParse({
        is_error: true,
        subtype: null,
        result: null,
        session_id: null,
        structured_output: null,
        total_cost_usd: null,
        usage: null,
        num_turns: null,
      }).success,
    ).toBe(true);
  });

  test("rejects a non-boolean is_error", () => {
    expect(ClaudeEnvelopeSchema.safeParse({ is_error: "no", subtype: null, result: null, session_id: null, structured_output: null, total_cost_usd: null, usage: null, num_turns: null }).success).toBe(
      false,
    );
  });
});

describe("StepRecord", () => {
  test("minimal record (only outcome) parses", () => {
    expect(StepRecordSchema.parse({ outcome: "completed" }).outcome).toBe("completed");
  });

  test("needs-input record with a question carrying question_id (G3)", () => {
    const rec = StepRecordSchema.parse({
      outcome: "needs-input",
      question: { text: "Which region?", context: "provisioning", options: ["eu", "us"], question_id: "q-42" },
    });
    expect(rec.question?.question_id).toBe("q-42");
  });

  test("a v4 question without question_id still parses (additive)", () => {
    const rec = StepRecordSchema.parse({ outcome: "needs-input", question: { text: "Which region?" } });
    expect(rec.question?.question_id).toBeUndefined();
  });

  test("rejects an out-of-enum outcome and a question with empty text", () => {
    expect(StepRecordSchema.safeParse({ outcome: "nope" }).success).toBe(false);
    expect(StepRecordSchema.safeParse({ outcome: "needs-input", question: { text: "" } }).success).toBe(false);
  });
});

describe("AnswerMessage (G8)", () => {
  test("structured answer parses", () => {
    const ans = AnswerMessageSchema.parse({
      run_id: "run-123",
      question_id: "q-42",
      answer: "eu",
      answered_by: "user:mrbaizor@gmail.com",
      ts: "2026-07-11T10:00:00.000Z",
    });
    expect(ans.question_id).toBe("q-42");
    expect(ans.answered_by).toContain("mrbaizor");
  });

  test("rejects missing question_id, empty answer, and non-ISO ts", () => {
    const base = { run_id: "run-123", question_id: "q-42", answer: "eu", answered_by: "u", ts: "2026-07-11T10:00:00.000Z" };
    expect(AnswerMessageSchema.safeParse({ ...base, question_id: undefined }).success).toBe(false);
    expect(AnswerMessageSchema.safeParse({ ...base, answer: "" }).success).toBe(false);
    expect(AnswerMessageSchema.safeParse({ ...base, ts: "yesterday" }).success).toBe(false);
  });
});
