import { describe, expect, test } from "bun:test";
import {
  AWAITING_KINDS,
  CLOUD_RUN_OUTCOMES,
  deriveRunState,
  JOURNAL_BLOCKED_EVENTS,
  JOURNAL_DONE_EVENTS,
  JOURNAL_FAILED_EVENTS,
  JOURNAL_RUNNING_EVENTS,
  RUN_STATE_FALLBACK,
  RUN_STATES,
  type RunState,
} from "./run-state.js";

/**
 * Every row/cell of the 02 §"Unified status model" canonical table, exercised
 * against `deriveRunState` for all three input sources it accepts (cloud DB,
 * CLI `drive` final-JSON, journal/drive-snapshot) — plus the unknown-input
 * fallback and the NULL/absent-`awaiting_kind` rule (DoD, 04 §4.7).
 */

describe("RUN_STATES — the closed 7-state public vocabulary (D12)", () => {
  test("is exactly the 7 states from the design doc, in the documented order", () => {
    expect(RUN_STATES).toEqual([
      "queued",
      "running",
      "needs-input",
      "needs-approval",
      "blocked",
      "failed",
      "done",
    ]);
  });

  test("the fallback state is itself a member of the closed vocabulary", () => {
    expect(RUN_STATES).toContain(RUN_STATE_FALLBACK);
  });
});

describe("deriveRunState — cloud DB (status/outcome + awaiting_kind)", () => {
  test("created -> queued", () => {
    expect(deriveRunState({ source: "cloud", status: "created" })).toBe("queued");
  });

  test("running -> running", () => {
    expect(deriveRunState({ source: "cloud", status: "running" })).toBe("running");
  });

  test("awaiting_input + awaiting_kind:'question' -> needs-input", () => {
    expect(
      deriveRunState({ source: "cloud", status: "awaiting_input", awaiting_kind: "question" }),
    ).toBe("needs-input");
  });

  test("awaiting_input + awaiting_kind: null (historical row, M1/R7) -> needs-input", () => {
    expect(
      deriveRunState({ source: "cloud", status: "awaiting_input", awaiting_kind: null }),
    ).toBe("needs-input");
  });

  test("awaiting_input + awaiting_kind ABSENT (M1/R7) -> needs-input", () => {
    expect(deriveRunState({ source: "cloud", status: "awaiting_input" })).toBe("needs-input");
  });

  test("awaiting_input + awaiting_kind:'approval' -> needs-approval", () => {
    expect(
      deriveRunState({ source: "cloud", status: "awaiting_input", awaiting_kind: "approval" }),
    ).toBe("needs-approval");
  });

  test("blocked -> blocked", () => {
    expect(deriveRunState({ source: "cloud", status: "blocked" })).toBe("blocked");
  });

  test("ended + outcome:'success' -> done", () => {
    expect(deriveRunState({ source: "cloud", status: "ended", outcome: "success" })).toBe("done");
  });

  test("every non-success terminal outcome -> failed", () => {
    const failingOutcomes = CLOUD_RUN_OUTCOMES.filter((o) => o !== "success");
    expect(failingOutcomes).toEqual(["failed", "crashed", "stopped", "abandoned-needs-input"]);
    for (const outcome of failingOutcomes) {
      expect(deriveRunState({ source: "cloud", status: "ended", outcome })).toBe("failed");
    }
  });

  test("every AWAITING_KINDS member round-trips through its own row", () => {
    const expected: Record<(typeof AWAITING_KINDS)[number], RunState> = {
      question: "needs-input",
      approval: "needs-approval",
    };
    for (const kind of AWAITING_KINDS) {
      expect(
        deriveRunState({ source: "cloud", status: "awaiting_input", awaiting_kind: kind }),
      ).toBe(expected[kind]);
    }
  });
});

describe("deriveRunState — CLI `drive` final-JSON status", () => {
  test("awaiting-input, question WITHOUT approval -> needs-input", () => {
    expect(
      deriveRunState({ source: "cli", status: "awaiting-input", question: { text: "ok?" } }),
    ).toBe("needs-input");
  });

  test("awaiting-input, question ABSENT -> needs-input", () => {
    expect(deriveRunState({ source: "cli", status: "awaiting-input" })).toBe("needs-input");
  });

  test("awaiting-input, question: null -> needs-input", () => {
    expect(deriveRunState({ source: "cli", status: "awaiting-input", question: null })).toBe(
      "needs-input",
    );
  });

  test("awaiting-input, question WITH approval present -> needs-approval", () => {
    expect(
      deriveRunState({
        source: "cli",
        status: "awaiting-input",
        question: { text: "deploy?", approval: { required_role: "admin" } },
      }),
    ).toBe("needs-approval");
  });

  test("blocked (exit 3) -> blocked", () => {
    expect(deriveRunState({ source: "cli", status: "blocked" })).toBe("blocked");
  });

  test("halted -> failed", () => {
    expect(deriveRunState({ source: "cli", status: "halted" })).toBe("failed");
  });

  test("depth-exhausted -> failed", () => {
    expect(deriveRunState({ source: "cli", status: "depth-exhausted" })).toBe("failed");
  });

  test("completed -> done", () => {
    expect(deriveRunState({ source: "cli", status: "completed" })).toBe("done");
  });
});

describe("deriveRunState — journal / drive-snapshot signal", () => {
  test("run.started absent (event: undefined) -> queued", () => {
    expect(deriveRunState({ source: "journal" })).toBe("queued");
  });

  test("event: null -> queued", () => {
    expect(deriveRunState({ source: "journal", event: null })).toBe("queued");
  });

  test("every running-fold event (running/improving/scripting collapse) -> running", () => {
    for (const event of JOURNAL_RUNNING_EVENTS) {
      expect(deriveRunState({ source: "journal", event })).toBe("running");
    }
  });

  test("awaiting_input event, no approval -> needs-input", () => {
    expect(deriveRunState({ source: "journal", event: "awaiting_input" })).toBe("needs-input");
    expect(deriveRunState({ source: "journal", event: "awaiting_input", approval: false })).toBe(
      "needs-input",
    );
  });

  test("awaiting_input event, with approval -> needs-approval", () => {
    expect(deriveRunState({ source: "journal", event: "awaiting_input", approval: true })).toBe(
      "needs-approval",
    );
  });

  test("blocker.delegated / blocker.polling -> blocked", () => {
    for (const event of JOURNAL_BLOCKED_EVENTS) {
      expect(deriveRunState({ source: "journal", event })).toBe("blocked");
    }
  });

  test("pipeline.halted / run.halted -> failed", () => {
    for (const event of JOURNAL_FAILED_EVENTS) {
      expect(deriveRunState({ source: "journal", event })).toBe("failed");
    }
  });

  test("pipeline.completed / run.completed -> done", () => {
    for (const event of JOURNAL_DONE_EVENTS) {
      expect(deriveRunState({ source: "journal", event })).toBe("done");
    }
  });
});

describe("deriveRunState — unknown-input fallback (documented, tested)", () => {
  test("null / undefined / non-object input -> RUN_STATE_FALLBACK", () => {
    expect(deriveRunState(null)).toBe(RUN_STATE_FALLBACK);
    expect(deriveRunState(undefined)).toBe(RUN_STATE_FALLBACK);
    expect(deriveRunState("not an object")).toBe(RUN_STATE_FALLBACK);
    expect(deriveRunState(42)).toBe(RUN_STATE_FALLBACK);
  });

  test("object with no `source` / an unrecognized `source` -> RUN_STATE_FALLBACK", () => {
    expect(deriveRunState({})).toBe(RUN_STATE_FALLBACK);
    expect(deriveRunState({ source: "some-future-peer" })).toBe(RUN_STATE_FALLBACK);
  });

  test("recognized source, unrecognized status -> RUN_STATE_FALLBACK", () => {
    expect(deriveRunState({ source: "cloud", status: "some-future-status" })).toBe(
      RUN_STATE_FALLBACK,
    );
    expect(deriveRunState({ source: "cli", status: "some-future-status" })).toBe(
      RUN_STATE_FALLBACK,
    );
    expect(deriveRunState({ source: "journal", event: "some.future.event" })).toBe(
      RUN_STATE_FALLBACK,
    );
  });

  test("cloud row: status 'ended' with an unrecognized/absent outcome -> RUN_STATE_FALLBACK", () => {
    expect(deriveRunState({ source: "cloud", status: "ended" })).toBe(RUN_STATE_FALLBACK);
    expect(deriveRunState({ source: "cloud", status: "ended", outcome: "not-a-real-outcome" })).toBe(
      RUN_STATE_FALLBACK,
    );
  });

  test("RUN_STATE_FALLBACK constant is 'running'", () => {
    expect(RUN_STATE_FALLBACK).toBe("running");
  });
});
