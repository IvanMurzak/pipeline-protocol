import { describe, expect, test } from "bun:test";
import { parseEvent, safeParseEvent } from "../index.js";
import { AnyEventEnvelope } from "./envelope.js";
import {
  AnyShippableEnvelope,
  EVENT_TYPES,
  EventEnvelope,
  isShippableEvent,
  ShippableEventEnvelope,
} from "./types.js";

/** A valid v4 envelope shell around a given type + data. */
function envelope(type: string, data: unknown, overrides: Record<string, unknown> = {}) {
  return {
    schema: 4,
    ts: "2026-05-21T18:42:11.342Z",
    type,
    project_root: "/abs/project",
    worktree: null,
    run_id: "run-123",
    parent_run_id: null,
    session_id: "sess-1",
    data,
    ...overrides,
  };
}

describe("envelope common fields", () => {
  test("valid envelope parses and keeps its fields", () => {
    const ev = parseEvent(envelope("pipeline.completed", { pipeline_name: "release" }));
    expect(ev.type).toBe("pipeline.completed");
    expect(ev.run_id).toBe("run-123");
    expect(ev.schema).toBe(4);
  });

  test("rejects a non-ISO ts", () => {
    expect(safeParseEvent(envelope("pipeline.completed", { pipeline_name: "x" }, { ts: "not-a-date" })).success).toBe(false);
  });

  test("rejects a non-positive schema version", () => {
    expect(safeParseEvent(envelope("pipeline.completed", { pipeline_name: "x" }, { schema: 0 })).success).toBe(false);
    expect(safeParseEvent(envelope("pipeline.completed", { pipeline_name: "x" }, { schema: "4" })).success).toBe(false);
  });

  test("accepts v1/v2/v3 schema integers (backward-parse)", () => {
    for (const schema of [1, 2, 3]) {
      expect(safeParseEvent(envelope("pipeline.completed", { pipeline_name: "x" }, { schema })).success).toBe(true);
    }
  });

  test("rejects a missing required envelope field (project_root)", () => {
    const bad = envelope("pipeline.completed", { pipeline_name: "x" });
    delete (bad as Record<string, unknown>).project_root;
    expect(safeParseEvent(bad).success).toBe(false);
  });

  test("parseEvent throws on an unknown event type; AnyEventEnvelope tolerates it", () => {
    const future = envelope("future.thing", { anything: 1 });
    expect(() => parseEvent(future)).toThrow();
    // Forward-tolerance: an unknown-but-well-formed envelope still validates.
    const any = AnyEventEnvelope.parse(future);
    expect(any.type).toBe("future.thing");
  });
});

describe("v4 per-type data schemas", () => {
  test("session.opened", () => {
    expect(safeParseEvent(envelope("session.opened", { claude_pid: 4242 }, { run_id: null })).success).toBe(true);
  });

  test("iteration.completed valid + rejects an out-of-enum outcome", () => {
    expect(
      safeParseEvent(
        envelope("iteration.completed", {
          iteration_path: "/abs/02.md",
          outcome: "completed",
          next_iteration_path: null,
          has_improvement_brief: false,
          has_blocker_delegation: false,
          halt_reason: null,
          terminal: true,
        }),
      ).success,
    ).toBe(true);

    expect(
      safeParseEvent(
        envelope("iteration.completed", {
          iteration_path: "/abs/02.md",
          outcome: "bogus-outcome",
          next_iteration_path: null,
        }),
      ).success,
    ).toBe(false);
  });

  test("parallel/DAG (layer-mode) iteration.completed parses: no next_iteration_path, null iteration_path", () => {
    // The OSS layer branch (next.ts) omits next_iteration_path entirely and sets
    // iteration_path to `step?.path ?? null`. A strict parse must accept it.
    const layer = safeParseEvent(
      envelope("iteration.completed", {
        iteration_path: null,
        outcome: "completed",
        halt_reason: null,
        terminal: false,
        step_id: "build",
      }),
    );
    expect(layer.success).toBe(true);
  });

  test("iteration.started rejects a non-integer index", () => {
    expect(safeParseEvent(envelope("iteration.started", { iteration_path: "/a", index: 1.5 })).success).toBe(false);
  });

  test("worktree.created failure variant (ok:false, no success fields)", () => {
    expect(safeParseEvent(envelope("worktree.created", { ok: false, detail: "hook failed" })).success).toBe(true);
  });

  test("turn.usage requires integer token counts", () => {
    expect(
      safeParseEvent(
        envelope("turn.usage", {
          assistant_turns: 1,
          input_tokens: 10,
          output_tokens: 5,
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
        }),
      ).success,
    ).toBe(true);
    expect(
      safeParseEvent(envelope("turn.usage", { assistant_turns: 1, input_tokens: "x", output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 }))
        .success,
    ).toBe(false);
  });
});

describe("v5 additive events", () => {
  test("run.started / run.completed / run.halted", () => {
    expect(safeParseEvent(envelope("run.started", { orchestrator: "drive", pipeline_name: "release" })).success).toBe(true);
    expect(safeParseEvent(envelope("run.completed", { pipeline_name: "release", outcome: "completed" })).success).toBe(true);
    expect(safeParseEvent(envelope("run.halted", { pipeline_name: "release", halt_reason: "depth exhausted" })).success).toBe(true);
  });

  test("awaiting_input validates with question_id + question shape", () => {
    const ev = parseEvent(
      envelope("awaiting_input", {
        run_id: "run-123",
        iteration: 2,
        question_id: "q-abc",
        question: { text: "Deploy to prod?", context: "built + tested", options: ["yes", "no"] },
      }),
    );
    expect(ev.type).toBe("awaiting_input");
    if (ev.type === "awaiting_input") {
      expect(ev.data.question_id).toBe("q-abc");
      expect(ev.data.question.text).toBe("Deploy to prod?");
      expect(ev.data.iteration).toBe(2);
    }
  });

  test("awaiting_input rejects an empty question text and a missing question_id", () => {
    expect(
      safeParseEvent(envelope("awaiting_input", { run_id: "run-123", iteration: 1, question_id: "q1", question: { text: "" } })).success,
    ).toBe(false);
    expect(
      safeParseEvent(envelope("awaiting_input", { run_id: "run-123", iteration: 1, question: { text: "hi" } })).success,
    ).toBe(false);
  });

  test("iteration.started carries the resumed marker + emission counter (G5)", () => {
    const ev = parseEvent(envelope("iteration.started", { iteration_path: "/a", index: 3, resumed: true, emission: 2 }));
    if (ev.type === "iteration.started") {
      expect(ev.data.resumed).toBe(true);
      expect(ev.data.emission).toBe(2);
      expect(ev.data.index).toBe(3); // index stays STEP IDENTITY, not the emission count
    }
  });
});

describe("backward compatibility (v4 payload under v5)", () => {
  test("an old v4 iteration.started (no resumed/emission/step_id) still parses", () => {
    const v4 = envelope("iteration.started", { iteration_path: "/abs/01.md", index: 1, resolved_model: "sonnet" });
    const ev = parseEvent(v4);
    expect(ev.type).toBe("iteration.started");
    if (ev.type === "iteration.started") {
      expect(ev.data.resumed).toBeUndefined();
      expect(ev.data.emission).toBeUndefined();
    }
  });

  test("a v1-style iteration.completed (no terminal / has_* fields) still parses", () => {
    const v1 = envelope("iteration.completed", { iteration_path: "/abs/01.md", outcome: "completed", next_iteration_path: "/abs/02.md" });
    expect(parseEvent(v1).type).toBe("iteration.completed");
  });

  test("a future additive data field is preserved (passthrough), not rejected", () => {
    const withFuture = envelope("pipeline.completed", { pipeline_name: "x", future_field: 99 });
    const ev = parseEvent(withFuture);
    expect((ev.data as Record<string, unknown>).future_field).toBe(99);
  });
});

describe("shippable-event rule (G2)", () => {
  test("a non-null run_id event is shippable", () => {
    const ev = parseEvent(envelope("pipeline.completed", { pipeline_name: "x" }));
    expect(isShippableEvent(ev)).toBe(true);
    expect(ShippableEventEnvelope.safeParse(envelope("pipeline.completed", { pipeline_name: "x" })).success).toBe(true);
  });

  test("a null run_id (session-scoped) event is NOT shippable", () => {
    const sessionScoped = envelope("session.opened", { claude_pid: 1 }, { run_id: null });
    const ev = parseEvent(sessionScoped);
    expect(isShippableEvent(ev)).toBe(false);
    expect(ShippableEventEnvelope.safeParse(sessionScoped).success).toBe(false);
    expect(AnyShippableEnvelope.safeParse(sessionScoped).success).toBe(false);
  });
});

describe("event catalogue", () => {
  test("EVENT_TYPES lists every discriminated-union member exactly once", () => {
    expect(EVENT_TYPES.length).toBe(EventEnvelope.options.length);
    expect(new Set(EVENT_TYPES).size).toBe(EVENT_TYPES.length);
    const additive = ["run.started", "run.completed", "run.halted", "awaiting_input"] as const;
    for (const t of additive) {
      expect(EVENT_TYPES).toContain(t);
    }
  });
});
