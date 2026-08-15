import { describe, expect, test } from "bun:test";
import { IngestBatchRequestSchema } from "../ingest/index.js";
import {
  AcceptMessageSchema,
  ChatReplyErrorSchema,
  ChatReplyMessageSchema,
  HeartbeatMessageSchema,
  NeedsInputMessageSchema,
  RUN_STATUS_OUTCOME_BLOCKED,
  RunStatusMessageSchema,
  UploadMessageSchema,
} from "./client.js";
import { CHAT_MESSAGE_MAX_CHARS } from "./server.js";

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

describe("chat_reply (a3-protocol-chat-frames — runner → cloud, streamed reply to chat_send)", () => {
  /** A representative valid `chat_reply` chunk. */
  function chatReply(overrides: Record<string, unknown> = {}) {
    return {
      type: "chat_reply",
      id: "chat-1",
      run_id: "run-7",
      message_id: "msg-abc",
      message: "Sure — here's the current status.",
      done: true,
      ts: "2026-08-15T21:00:00.000Z",
      ...overrides,
    };
  }

  test("a single non-streaming reply (done: true) parses and echoes run_id + message_id", () => {
    const r = ChatReplyMessageSchema.parse(chatReply());
    expect(r.run_id).toBe("run-7");
    expect(r.message_id).toBe("msg-abc");
    expect(r.done).toBe(true);
    expect(r.error).toBeUndefined();
  });

  test("a streamed reply may send an intermediate chunk with done: false, echoing the same message_id", () => {
    const chunk = ChatReplyMessageSchema.parse(chatReply({ message: "Sure — here's the ", done: false }));
    expect(chunk.done).toBe(false);
    expect(chunk.message_id).toBe("msg-abc");
  });

  test("an empty message is valid on a pure completion sentinel frame (done: true, no more text)", () => {
    expect(ChatReplyMessageSchema.safeParse(chatReply({ message: "" })).success).toBe(true);
  });

  test("rejects a missing run_id, missing/empty message_id, a missing done, or a non-boolean done", () => {
    const noRunId = chatReply();
    delete (noRunId as Record<string, unknown>).run_id;
    expect(ChatReplyMessageSchema.safeParse(noRunId).success).toBe(false);

    const noMessageId = chatReply();
    delete (noMessageId as Record<string, unknown>).message_id;
    expect(ChatReplyMessageSchema.safeParse(noMessageId).success).toBe(false); // B1: message_id is REQUIRED
    expect(ChatReplyMessageSchema.safeParse(chatReply({ message_id: "" })).success).toBe(false);

    const noDone = chatReply();
    delete (noDone as Record<string, unknown>).done;
    expect(ChatReplyMessageSchema.safeParse(noDone).success).toBe(false);

    expect(ChatReplyMessageSchema.safeParse(chatReply({ done: "yes" })).success).toBe(false); // non-boolean done
  });

  // ── B1: message_id pairs a reply's chunks to its chat_send ─────────────────

  test("message_id lets d6 pair a chat_reply stream to the RIGHT chat_send when two turns interleave", () => {
    const turnAChunk1 = ChatReplyMessageSchema.parse(chatReply({ message_id: "turn-a", message: "Part 1 of A", done: false }));
    const turnBChunk1 = ChatReplyMessageSchema.parse(chatReply({ message_id: "turn-b", message: "Part 1 of B", done: false }));
    const turnAChunk2 = ChatReplyMessageSchema.parse(chatReply({ message_id: "turn-a", message: "Part 2 of A", done: true }));
    expect(turnAChunk1.message_id).toBe(turnAChunk2.message_id);
    expect(turnAChunk1.message_id).not.toBe(turnBChunk1.message_id);
  });

  // ── B2: terminal failure is an explicit frame, never silence ────────────────

  test("a terminal-failure chat_reply carries done: true + a populated error", () => {
    const failed = ChatReplyMessageSchema.parse(
      chatReply({ message: "", done: true, error: { code: "not_owned", message: "run not owned by this runner" } }),
    );
    expect(failed.done).toBe(true);
    expect(failed.error).toEqual({ code: "not_owned", message: "run not owned by this runner" });
  });

  test("error is OPTIONAL: an ordinary reply has no error key at all", () => {
    const ok = ChatReplyMessageSchema.parse(chatReply());
    expect(ok.error).toBeUndefined();
    expect("error" in ok).toBe(false);
  });

  test("error rejects a malformed shape (missing code, missing message, empty code)", () => {
    expect(ChatReplyMessageSchema.safeParse(chatReply({ error: { message: "x" } })).success).toBe(false);
    expect(ChatReplyMessageSchema.safeParse(chatReply({ error: { code: "internal_error" } })).success).toBe(false);
    expect(ChatReplyMessageSchema.safeParse(chatReply({ error: { code: "", message: "x" } })).success).toBe(false);
  });

  test("error.code is an OPEN string, not a closed enum — an undocumented future code still parses (rule 5)", () => {
    const r = ChatReplyMessageSchema.parse(chatReply({ error: { code: "quota_exceeded", message: "future code" } }));
    expect(r.error?.code).toBe("quota_exceeded");
  });

  test("ChatReplyErrorSchema is passthrough (rule 3): a newer peer's additive field on error survives", () => {
    const r = ChatReplyMessageSchema.parse(
      chatReply({ error: { code: "internal_error", message: "x", retry_after_s: 30 } }),
    );
    expect((r.error as Record<string, unknown>).retry_after_s).toBe(30);
  });

  test("the error field IS ChatReplyErrorSchema", () => {
    expect(ChatReplyMessageSchema.shape.error.unwrap().unwrap()).toBe(ChatReplyErrorSchema);
  });

  // ── A1: message length bound (shared with chat_send) ───────────────────────

  test("message is bounded by the SAME CHAT_MESSAGE_MAX_CHARS chat_send uses", () => {
    expect(ChatReplyMessageSchema.safeParse(chatReply({ message: "x".repeat(CHAT_MESSAGE_MAX_CHARS) })).success).toBe(
      true,
    );
    expect(
      ChatReplyMessageSchema.safeParse(chatReply({ message: "x".repeat(CHAT_MESSAGE_MAX_CHARS + 1) })).success,
    ).toBe(false);
  });

  test("no attachment / history-backfill fields are part of the schema (R5b minimal channel) — passthrough still tolerates a newer peer's addition", () => {
    const r = ChatReplyMessageSchema.parse(chatReply({ attachments: ["from-a-newer-peer"] }));
    expect((r as Record<string, unknown>).attachments).toEqual(["from-a-newer-peer"]);
  });

  // ── B4-style rigor applied here too: individually assert no authz-shaped
  // field snuck onto the reply side either. ──────────────────────────────────

  test("chat_reply carries no role/permission/org claim either — run_id ownership is verified cloud-side, never trusted from the wire", () => {
    const shapeKeys = Object.keys(ChatReplyMessageSchema.shape);
    expect(shapeKeys).not.toContain("role");
    expect(shapeKeys).not.toContain("permission");
    expect(shapeKeys).not.toContain("org_id");
    expect(shapeKeys).not.toContain("authz");
    const forbidden = ["role", "permission", "org_id", "authz"];
    expect(forbidden.filter((k) => shapeKeys.includes(k))).toEqual([]);
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

  // ── pipeline-ui-v2 task a1-protocol-run-state (review B4): the closed
  // `phase` enum cannot grow, so a runner's blocker/exit-3 classification
  // rides the already-open `outcome` string field as `phase:"halted",
  // outcome:"blocked"` instead of a new phase value.

  test("phase:'halted' + outcome:RUN_STATUS_OUTCOME_BLOCKED parses (the documented blocked signal)", () => {
    expect(RUN_STATUS_OUTCOME_BLOCKED).toBe("blocked");
    const blocked = RunStatusMessageSchema.parse({
      type: "run_status",
      run_id: "run-7",
      phase: "halted",
      outcome: RUN_STATUS_OUTCOME_BLOCKED,
    });
    expect(blocked.phase).toBe("halted");
    expect(blocked.outcome).toBe("blocked");
  });
});
