import { describe, expect, test } from "bun:test";
import { AnswerMessageSchema, ClaudeEnvelopeSchema, RunRecordStatsSchema, StepRecordSchema } from "./index.js";

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

describe("RunRecordStats (D12/D13/D18)", () => {
  // Anonymized shape of a real `.claude/pipeline/.stats/<rel>/runs.jsonl` line
  // BEFORE the SubagentStop stats-relay hook has folded the transcript.
  const freshRecord = {
    schema: 1,
    run_id: "run-8f2c1a9e",
    pipeline: "release-flow",
    started_at: "2026-07-16T10:00:00.000Z",
    ended_at: "2026-07-16T10:05:30.000Z",
    duration_s: 330,
    outcome: "completed",
    halt_reason: null,
    runner: "runner-alpha",
    mode: "sequential",
    steps_run: 2,
    steps: [
      {
        id: "01-plan",
        started_at: "2026-07-16T10:00:00.000Z",
        seconds: 120,
        outcome: "completed",
        model: "claude-sonnet-4-5",
        effort: null,
      },
      {
        id: "02-build",
        started_at: "2026-07-16T10:02:00.000Z",
        seconds: 90,
        outcome: "completed",
        model: null,
        effort: null,
        step_type: "script",
      },
    ],
    improver_runs: 0,
    improver_applied: 0,
    scripts_created: 0,
    merges: 1,
    merge_conflicts: 0,
    llm_steps: 1,
    tokens: null,
    // Sync-mechanics (D13/D18): first ship of a cloud-dispatched run.
    revision: 0,
    origin: "dispatched",
  };

  // Same run AFTER late token enrichment (D13 re-ship) — a locally-started
  // run (D18) that also picked up a step failure.
  const enrichedRecord = {
    ...freshRecord,
    steps: [
      freshRecord.steps[0],
      {
        id: "02-build",
        started_at: "2026-07-16T10:02:00.000Z",
        seconds: 90,
        outcome: "halted",
        model: null,
        effort: null,
        step_type: "script",
        failure_class: "transient",
      },
    ],
    tokens: {
      input: 12000,
      output: 3400,
      cache_read: 8000,
      cache_creation: 500,
      tools_called: 14,
      tools_failed: 1,
      failed_tools: { Bash: 1 },
      agents_spawned: 2,
      cost_usd: 0.42,
    },
    revision: 1,
    origin: "local",
  };

  test("a fresh record (tokens: null) round-trips", () => {
    const parsed = RunRecordStatsSchema.parse(freshRecord);
    expect(parsed.tokens).toBeNull();
    expect(parsed.revision).toBe(0);
    expect(parsed.origin).toBe("dispatched");
    expect(parsed.steps).toHaveLength(2);
  });

  test("an enriched, re-shipped local record round-trips", () => {
    const parsed = RunRecordStatsSchema.parse(enrichedRecord);
    expect(parsed.tokens?.cost_usd).toBe(0.42);
    expect(parsed.tokens?.failed_tools).toEqual({ Bash: 1 });
    expect(parsed.revision).toBe(1);
    expect(parsed.origin).toBe("local");
    expect(parsed.steps[1]?.failure_class).toBe("transient");
  });

  test("unknown future fields pass through (additive forward-compat)", () => {
    const parsed = RunRecordStatsSchema.parse({ ...freshRecord, future_field: "from-a-newer-peer" });
    expect((parsed as Record<string, unknown>).future_field).toBe("from-a-newer-peer");
  });

  test("rejects a missing sync-mechanics field and a bad origin", () => {
    const { revision: _revision, ...noRevision } = freshRecord;
    expect(RunRecordStatsSchema.safeParse(noRevision).success).toBe(false);
    expect(RunRecordStatsSchema.safeParse({ ...freshRecord, origin: "somewhere-else" }).success).toBe(false);
    expect(RunRecordStatsSchema.safeParse({ ...freshRecord, schema: 2 }).success).toBe(false);
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
