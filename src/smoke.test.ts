import { describe, expect, test } from "bun:test";
// Import from the PACKAGE ENTRY (src/index.ts — what `@baizor/pipeline-protocol`
// compiles to) to prove the public surface works.
import { isShippableEvent, parseEvent, PROTOCOL_VERSION, safeParseEvent } from "./index.js";

describe("smoke: package entry", () => {
  test("validates a real v4 envelope (from EVENTS.md) and a v5 awaiting_input event", () => {
    // A real v4 pipeline.started envelope, shaped like EVENTS.md §Common envelope.
    const v4 = {
      schema: 4,
      ts: "2026-05-21T18:42:11.342Z",
      type: "pipeline.started",
      project_root: "/abs/path/to/project",
      worktree: null,
      run_id: "01J8ZQ9K",
      parent_run_id: null,
      session_id: "claude-sess-xyz",
      data: {
        pipeline_name: "workflows/implement-task",
        first_iteration_path: "/abs/path/to/steps/01-plan.md",
        pipeline_root: "/abs/path/to/.claude/pipeline",
        default_model: "opus",
      },
    };
    const evV4 = parseEvent(v4);
    expect(evV4.type).toBe("pipeline.started");
    expect(isShippableEvent(evV4)).toBe(true);

    // A v5 additive awaiting_input event.
    const v5 = {
      schema: 4,
      ts: "2026-05-21T18:43:00.000Z",
      type: "awaiting_input",
      project_root: "/abs/path/to/project",
      worktree: null,
      run_id: "01J8ZQ9K",
      parent_run_id: null,
      session_id: "claude-sess-xyz",
      data: {
        run_id: "01J8ZQ9K",
        iteration: 3,
        question_id: "q-01J8ZR",
        question: { text: "Merge the release PR?", context: "all checks green", options: ["merge", "hold"] },
      },
    };
    const res = safeParseEvent(v5);
    expect(res.success).toBe(true);
    if (res.success && res.data.type === "awaiting_input") {
      expect(res.data.data.question.text).toBe("Merge the release PR?");
    }

    expect(PROTOCOL_VERSION).toBe(1);
  });
});
