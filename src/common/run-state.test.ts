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
  type RunStateInput,
} from "./run-state.js";

/**
 * Every row/cell of the 02 §"Unified status model" canonical table, exercised
 * against `deriveRunState` for all three input sources it accepts (cloud DB,
 * CLI `drive` final-JSON, journal/drive-snapshot) — plus the unknown-input
 * fallback and the NULL/absent-`awaiting_kind` rule (DoD, 04 §4.7).
 *
 * Also covers the fix-round-1 findings from the high-depth PR review (#18):
 * B1 (journal `approval` is an object, never a boolean), B2 (`ended` with a
 * missing/unrecognized `outcome` is terminal `"failed"`, not the fallback),
 * B3 (`manager.stopped` agrees with the cloud column), and A1 (the typed
 * `RunStateInput` overload).
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

describe("deriveRunState — the typed RunStateInput overload (review A1)", () => {
  test("a properly-shaped RunStateInput type-checks and derives correctly", () => {
    const typed: RunStateInput = { source: "cloud", status: "created" };
    expect(deriveRunState(typed)).toBe("queued");
  });

  test("an unvalidated `unknown` value still derives correctly via the second overload", () => {
    const fromWire: unknown = JSON.parse('{"source":"cloud","status":"running"}');
    expect(deriveRunState(fromWire)).toBe("running");
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

  test("ended + outcome ABSENT -> failed, matching the cloud's own `outcome ?? \"failed\"` default (review B2)", () => {
    expect(deriveRunState({ source: "cloud", status: "ended" })).toBe("failed");
  });

  test("ended + an unrecognized future outcome -> failed, never a live/fallback state (review B2)", () => {
    expect(
      deriveRunState({ source: "cloud", status: "ended", outcome: "not-a-real-outcome" }),
    ).toBe("failed");
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

  // ── B1: the journal `approval` marker is the real wire OBJECT shape
  // (`AwaitingInputData.question.approval`, an `ApprovalSchema`), never a
  // boolean — a prior revision typed it `boolean` and checked `=== true`,
  // which silently read a genuine approval-gate object as falsy.

  test("awaiting_input event, question WITHOUT approval -> needs-input", () => {
    expect(
      deriveRunState({ source: "journal", event: "awaiting_input", question: { text: "ok?" } }),
    ).toBe("needs-input");
  });

  test("awaiting_input event, question ABSENT -> needs-input", () => {
    expect(deriveRunState({ source: "journal", event: "awaiting_input" })).toBe("needs-input");
  });

  test("awaiting_input event, question: null -> needs-input", () => {
    expect(
      deriveRunState({ source: "journal", event: "awaiting_input", question: null }),
    ).toBe("needs-input");
  });

  test("awaiting_input event, question.approval an EMPTY object (still present) -> needs-approval", () => {
    // Presence, not content, is the signal — an approval object with no
    // populated fields yet still means "this is a gate" (mirrors the CLI
    // variant's identical presence check).
    expect(
      deriveRunState({
        source: "journal",
        event: "awaiting_input",
        question: { text: "ok?", approval: {} },
      }),
    ).toBe("needs-approval");
  });

  test("awaiting_input event, question.approval a real ApprovalSchema object -> needs-approval", () => {
    expect(
      deriveRunState({
        source: "journal",
        event: "awaiting_input",
        question: { text: "deploy to prod?", approval: { required_role: "admin" } },
      }),
    ).toBe("needs-approval");
  });

  test("blocker.delegated / blocker.polling -> blocked", () => {
    for (const event of JOURNAL_BLOCKED_EVENTS) {
      expect(deriveRunState({ source: "journal", event })).toBe("blocked");
    }
  });

  test("pipeline.halted / run.halted / manager.stopped -> failed", () => {
    expect(JOURNAL_FAILED_EVENTS).toEqual(["pipeline.halted", "run.halted", "manager.stopped"]);
    for (const event of JOURNAL_FAILED_EVENTS) {
      expect(deriveRunState({ source: "journal", event })).toBe("failed");
    }
  });

  test("manager.stopped -> failed, agreeing with the cloud column's outcome:'stopped' -> failed (review B3)", () => {
    // Cloud ingest ends a `manager.stopped` run with `outcome: "stopped"`,
    // which the cloud-DB column above maps to `"failed"` — the journal
    // column must give the SAME public state for the SAME underlying run.
    expect(deriveRunState({ source: "journal", event: "manager.stopped" })).toBe(
      deriveRunState({ source: "cloud", status: "ended", outcome: "stopped" }),
    );
    expect(deriveRunState({ source: "journal", event: "manager.stopped" })).toBe("failed");
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

  test("the fallback does NOT apply to a recognized terminal status with missing detail (review B2)", () => {
    // `status: "ended"` positively asserts the run is over — it must resolve
    // to a terminal state (`"failed"`), never RUN_STATE_FALLBACK. Covered in
    // depth in the cloud describe block above; asserted here too so the
    // fallback's own boundary is pinned next to its other edge cases.
    expect(deriveRunState({ source: "cloud", status: "ended" })).not.toBe(RUN_STATE_FALLBACK);
    expect(deriveRunState({ source: "cloud", status: "ended" })).toBe("failed");
  });

  test("RUN_STATE_FALLBACK constant is 'running'", () => {
    expect(RUN_STATE_FALLBACK).toBe("running");
  });
});
