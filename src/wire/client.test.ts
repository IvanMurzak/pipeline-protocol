import { describe, expect, test } from "bun:test";
import { IngestBatchRequestSchema } from "../ingest/index.js";
import {
  AcceptMessageSchema,
  HeartbeatMessageSchema,
  NeedsInputMessageSchema,
  RunStatusMessageSchema,
  UploadMessageSchema,
} from "./client.js";

describe("heartbeat (agent → server)", () => {
  test("valid heartbeat with active runs + pause state", () => {
    const hb = HeartbeatMessageSchema.parse({
      type: "heartbeat",
      id: "hb-1",
      runner_id: "runner-42",
      active_run_ids: ["run-a", "run-b"],
      status: "paused",
      paused_until: "2026-07-11T22:00:00.000Z",
    });
    expect(hb.type).toBe("heartbeat");
    expect(hb.status).toBe("paused");
    expect(hb.active_run_ids).toHaveLength(2);
  });

  test("minimal heartbeat (just runner_id) is valid; status enum is checked", () => {
    expect(HeartbeatMessageSchema.safeParse({ type: "heartbeat", runner_id: "r1" }).success).toBe(true);
    expect(HeartbeatMessageSchema.safeParse({ type: "heartbeat", runner_id: "r1", status: "bogus" }).success).toBe(false);
    expect(HeartbeatMessageSchema.safeParse({ type: "heartbeat" }).success).toBe(false);
  });

  // ── D13 capability flag (crash-resilience task d1, ADDITIVE `runs_authoritative`) ──

  test("runs_authoritative is OPTIONAL: a heartbeat without it still parses and has no key", () => {
    const hb = HeartbeatMessageSchema.parse({ type: "heartbeat", runner_id: "r1", active_run_ids: [] });
    expect(hb.runs_authoritative).toBeUndefined();
    expect("runs_authoritative" in hb).toBe(false);
  });

  test("a pre-d1 heartbeat (no runs_authoritative) round-trips byte-identical (old readers unaffected)", () => {
    const original = { type: "heartbeat", runner_id: "r1", active_run_ids: [], status: "online" };
    const parsed = HeartbeatMessageSchema.parse(original);
    expect(parsed as Record<string, unknown>).toEqual(original);
  });

  test("runs_authoritative: true is accepted and round-trips", () => {
    const hb = HeartbeatMessageSchema.parse({
      type: "heartbeat",
      runner_id: "r1",
      active_run_ids: ["run-a"],
      runs_authoritative: true,
    });
    expect(hb.runs_authoritative).toBe(true);
  });

  test("runs_authoritative rejects a non-boolean value", () => {
    expect(
      HeartbeatMessageSchema.safeParse({ type: "heartbeat", runner_id: "r1", runs_authoritative: "yes" }).success,
    ).toBe(false);
  });
});

describe("accept (lease acceptance)", () => {
  test("valid accept echoes job_id + run_id", () => {
    const acc = AcceptMessageSchema.parse({ type: "accept", id: "lease-7", runner_id: "r1", job_id: "job-7", run_id: "run-7" });
    expect(acc.job_id).toBe("job-7");
    expect(acc.run_id).toBe("run-7");
  });

  test("rejects a missing run_id", () => {
    expect(AcceptMessageSchema.safeParse({ type: "accept", runner_id: "r1", job_id: "job-7" }).success).toBe(false);
  });
});

describe("needs_input (surface a drive question — reuses Question)", () => {
  test("valid needs_input carries run_id + question_id + the shared Question shape", () => {
    const ni = NeedsInputMessageSchema.parse({
      type: "needs_input",
      id: "ni-1",
      run_id: "run-7",
      question_id: "q-abc",
      question: { text: "Deploy to prod?", context: "built + tested", options: ["yes", "no"], question_id: "q-abc" },
    });
    expect(ni.question_id).toBe("q-abc");
    expect(ni.question.text).toBe("Deploy to prod?");
  });

  test("question_id is REQUIRED on the message (v5-only), and empty question text is rejected", () => {
    expect(
      NeedsInputMessageSchema.safeParse({ type: "needs_input", run_id: "run-7", question: { text: "hi" } }).success,
    ).toBe(false); // missing question_id
    expect(
      NeedsInputMessageSchema.safeParse({ type: "needs_input", run_id: "run-7", question_id: "q1", question: { text: "" } }).success,
    ).toBe(false); // empty question text
  });
});

describe("upload (event upload — REUSES IngestBatchRequest, no duplicate)", () => {
  test("valid upload wraps the exact ingest batch shape", () => {
    const up = UploadMessageSchema.parse({
      type: "upload",
      id: "up-1",
      batch: { run_id: "run-7", events: [{ seq: 0, payload: { a: 1 } }, { seq: 1, payload: { b: 2 } }] },
    });
    expect(up.batch.run_id).toBe("run-7");
    expect(up.batch.events).toHaveLength(2);
  });

  test("the batch field IS the imported IngestBatchRequestSchema (single source of truth)", () => {
    // Structural proof of reuse: the message's `batch` field is the very same
    // schema object exported from `../ingest` — there is no forked copy.
    expect(UploadMessageSchema.shape.batch).toBe(IngestBatchRequestSchema);
  });

  test("a bad batch (negative seq) is rejected via the reused ingest rules", () => {
    expect(
      UploadMessageSchema.safeParse({ type: "upload", batch: { run_id: "run-7", events: [{ seq: -1, payload: {} }] } }).success,
    ).toBe(false);
    // Same payload validates directly against the ingest schema too (parity).
    expect(IngestBatchRequestSchema.safeParse({ run_id: "run-7", events: [{ seq: -1, payload: {} }] }).success).toBe(false);
  });
});

describe("run_status (mirrors run.started/completed/halted events)", () => {
  test("valid phases parse; terminal detail is optional", () => {
    expect(RunStatusMessageSchema.safeParse({ type: "run_status", run_id: "run-7", phase: "started" }).success).toBe(true);
    const done = RunStatusMessageSchema.parse({ type: "run_status", run_id: "run-7", phase: "completed", outcome: "completed" });
    expect(done.phase).toBe("completed");
    expect(done.outcome).toBe("completed");
    expect(RunStatusMessageSchema.parse({ type: "run_status", run_id: "run-7", phase: "halted", halt_reason: "depth exhausted" }).halt_reason).toBe(
      "depth exhausted",
    );
  });

  test("rejects an out-of-enum phase", () => {
    expect(RunStatusMessageSchema.safeParse({ type: "run_status", run_id: "run-7", phase: "running" }).success).toBe(false);
  });
});
