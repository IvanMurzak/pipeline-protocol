import { describe, expect, test } from "bun:test";
import { AnswerMessageSchema } from "../records/answer.js";
import { IngestBatchResponseSchema } from "../ingest/index.js";
import {
  AnswerDeliveryMessageSchema,
  CancelMessageSchema,
  CHAT_MESSAGE_MAX_CHARS,
  ChatSendMessageSchema,
  ExecutionOverridesSchema,
  HeartbeatAckMessageSchema,
  LeaseMessageSchema,
  LeaseTaskSchema,
  PipelineRefSchema,
  RunVariablesSchema,
  TASK_PIPELINE_UNRESOLVED,
  UploadAckMessageSchema,
} from "./server.js";

/** A representative valid `lease`. */
function lease(overrides: Record<string, unknown> = {}) {
  return {
    type: "lease",
    id: "lease-7",
    job_id: "job-7",
    run_id: "run-7",
    pipeline_ref: { repo: "acme/api", ref: "v43", pipeline: "workflows/release", content_hash: "sha256:abc" },
    labels: ["os:windows", "repo:acme/api"],
    job_jwt: "eyJ.placeholder.jwt",
    secret_slugs: ["OPENAI_API_KEY", "NPM_TOKEN"],
    lease_ttl_s: 120,
    ...overrides,
  };
}

describe("lease (server → agent job offer)", () => {
  test("valid lease carries job/run/pipeline_ref/jwt/secret slugs", () => {
    const l = LeaseMessageSchema.parse(lease());
    expect(l.job_id).toBe("job-7");
    expect(l.pipeline_ref.repo).toBe("acme/api");
    expect(l.pipeline_ref.content_hash).toBe("sha256:abc");
    expect(l.secret_slugs).toEqual(["OPENAI_API_KEY", "NPM_TOKEN"]);
  });

  test("content_hash is optional (unpinned latest-ref lease)", () => {
    const noHash = lease({ pipeline_ref: { repo: "acme/api", ref: "main", pipeline: "workflows/release" } });
    expect(LeaseMessageSchema.safeParse(noHash).success).toBe(true);
  });

  test("rejects a malformed lease (missing job_jwt, bad pipeline_ref)", () => {
    const noJwt = lease();
    delete (noJwt as Record<string, unknown>).job_jwt;
    expect(LeaseMessageSchema.safeParse(noJwt).success).toBe(false);
    expect(LeaseMessageSchema.safeParse(lease({ pipeline_ref: { repo: "acme/api" } })).success).toBe(false);
  });

  // ── T2-05 task-dispatch leases (ADDITIVE optional `task`) ───────────────────

  test("task is OPTIONAL: a lease without it still parses (T2-03 unchanged)", () => {
    const l = LeaseMessageSchema.parse(lease());
    expect(l.task).toBeUndefined();
  });

  test("a task-dispatch lease carries { task_id, title, body, labels } + the sentinel pipeline", () => {
    const l = LeaseMessageSchema.parse(
      lease({
        pipeline_ref: {
          repo: "acme/api",
          ref: "main",
          pipeline: TASK_PIPELINE_UNRESOLVED,
          content_hash: null,
        },
        task: {
          task_id: "task-9",
          title: "Fix the flaky release audit",
          body: "The nightly audit fails on Windows runners; investigate and fix.",
          labels: ["os:windows"],
        },
      }),
    );
    expect(l.task).toEqual({
      task_id: "task-9",
      title: "Fix the flaky release audit",
      body: "The nightly audit fails on Windows runners; investigate and fix.",
      labels: ["os:windows"],
    });
    expect(l.pipeline_ref.pipeline).toBe(TASK_PIPELINE_UNRESOLVED);
  });

  test("the task field IS LeaseTaskSchema; an empty body is allowed, an empty title is not", () => {
    expect(LeaseMessageSchema.shape.task.unwrap()).toBe(LeaseTaskSchema);
    const ok = { task_id: "t1", title: "Title only", body: "", labels: [] };
    expect(LeaseTaskSchema.safeParse(ok).success).toBe(true);
    expect(LeaseTaskSchema.safeParse({ ...ok, title: "" }).success).toBe(false);
  });

  test("a malformed task (missing task_id / bad labels) rejects the lease", () => {
    expect(
      LeaseMessageSchema.safeParse(lease({ task: { title: "x", body: "", labels: [] } })).success,
    ).toBe(false);
    expect(
      LeaseMessageSchema.safeParse(
        lease({ task: { task_id: "t1", title: "x", body: "", labels: "not-an-array" } }),
      ).success,
    ).toBe(false);
  });

  test("task passthrough preserves a newer peer's additive fields", () => {
    const l = LeaseMessageSchema.parse(
      lease({ task: { task_id: "t1", title: "x", body: "", labels: [], priority: 3 } }),
    );
    expect((l.task as Record<string, unknown>).priority).toBe(3);
  });

  // ── T3-06 execution overrides (ADDITIVE optional `execution_overrides`) ─────

  test("execution_overrides is OPTIONAL: a lease without it parses and has no key", () => {
    const l = LeaseMessageSchema.parse(lease());
    expect(l.execution_overrides).toBeUndefined();
    expect("execution_overrides" in l).toBe(false);
  });

  test("a lease carries execution_overrides with both model and effort", () => {
    const l = LeaseMessageSchema.parse(
      lease({ execution_overrides: { model: "claude-opus-4-8", effort: "high" } }),
    );
    expect(l.execution_overrides).toEqual({ model: "claude-opus-4-8", effort: "high" });
  });

  test("model-only and effort-only overrides are each valid (both fields optional)", () => {
    const modelOnly = LeaseMessageSchema.parse(lease({ execution_overrides: { model: "haiku" } }));
    expect(modelOnly.execution_overrides).toEqual({ model: "haiku" });
    const effortOnly = LeaseMessageSchema.parse(lease({ execution_overrides: { effort: "low" } }));
    expect(effortOnly.execution_overrides).toEqual({ effort: "low" });
    // An empty override object is still structurally valid (both optional).
    expect(LeaseMessageSchema.safeParse(lease({ execution_overrides: {} })).success).toBe(true);
  });

  test("the execution_overrides field IS ExecutionOverridesSchema", () => {
    expect(LeaseMessageSchema.shape.execution_overrides.unwrap()).toBe(ExecutionOverridesSchema);
  });

  test("execution_overrides rejects a non-string model / effort", () => {
    expect(
      LeaseMessageSchema.safeParse(lease({ execution_overrides: { model: 5 } })).success,
    ).toBe(false);
    expect(
      LeaseMessageSchema.safeParse(lease({ execution_overrides: { effort: true } })).success,
    ).toBe(false);
    // An empty-string model/effort is rejected (a present override is non-empty).
    expect(
      LeaseMessageSchema.safeParse(lease({ execution_overrides: { model: "" } })).success,
    ).toBe(false);
  });

  test("execution_overrides passthrough preserves a newer peer's additive fields", () => {
    const l = LeaseMessageSchema.parse(
      lease({ execution_overrides: { model: "opus", reasoning_budget: 4096 } }),
    );
    expect((l.execution_overrides as Record<string, unknown>).reasoning_budget).toBe(4096);
  });

  // ── env-variables design task b1 (ADDITIVE optional `variables`) ────────────

  test("variables is OPTIONAL: a lease without it still parses and has no key", () => {
    const l = LeaseMessageSchema.parse(lease());
    expect(l.variables).toBeUndefined();
    expect("variables" in l).toBe(false);
  });

  test("round-trip with variables ABSENT is byte-identical to a pre-b1 lease (old readers unaffected)", () => {
    // `toEqual` deep-compares by value, not key order, so it's unaffected by
    // zod's `.parse()` re-ordering keys to declaration order (a pre-existing,
    // harmless quirk unrelated to this change — `id`/`type` sort before the
    // rest even in leases that predate `variables`). The cast sidesteps a
    // `toEqual` overload that otherwise demands the literal `type: "lease"`
    // discriminant on the plain object `lease()` returns.
    const original = lease();
    const parsed = LeaseMessageSchema.parse(original);
    expect(parsed as Record<string, unknown>).toEqual(original);
    expect("variables" in parsed).toBe(false);
  });

  test("a lease carries a variables map of PP_-prefixed keys", () => {
    const l = LeaseMessageSchema.parse(
      lease({ variables: { PP_TARGET_ENV: "prod", PP_DEBUG: "1" } }),
    );
    expect(l.variables).toEqual({ PP_TARGET_ENV: "prod", PP_DEBUG: "1" });
  });

  test("an empty variables map is structurally valid", () => {
    expect(LeaseMessageSchema.safeParse(lease({ variables: {} })).success).toBe(true);
  });

  test("the variables field IS RunVariablesSchema", () => {
    expect(LeaseMessageSchema.shape.variables.unwrap()).toBe(RunVariablesSchema);
  });

  test("variables rejects a non-string value", () => {
    expect(RunVariablesSchema.safeParse({ PP_X: 5 }).success).toBe(false);
    expect(
      LeaseMessageSchema.safeParse(lease({ variables: { PP_X: 5 } })).success,
    ).toBe(false);
  });

  // ── Zod key-schema verdict — PIN, don't assume (task b1 explicit requirement) ──
  // VERDICT: REJECTED (enforced), zod 3.25.76 (this package's exact-pinned
  // dependency). Full rationale + the c1 defense-in-depth caveat is on
  // `RunVariablesSchema`'s JSDoc in `./server.ts` — this test just pins the
  // behavior so a future zod bump that regresses it fails CI loudly.
  test("RunVariablesSchema key-regex verdict: a non-PP_ key is REJECTED by the pinned zod version, not silently admitted", () => {
    expect(RunVariablesSchema.safeParse({ PP_OK: "v" }).success).toBe(true);
    const bad = RunVariablesSchema.safeParse({ NOT_PP: "v" });
    expect(bad.success).toBe(false);
  });

  test("a lease with a bad (non-PP_) variable key is rejected end-to-end", () => {
    expect(
      LeaseMessageSchema.safeParse(lease({ variables: { NOT_PP: "x" } })).success,
    ).toBe(false);
  });

  test("variables and execution_overrides + task can all coexist on one lease", () => {
    const l = LeaseMessageSchema.parse(
      lease({
        execution_overrides: { model: "opus" },
        variables: { PP_TARGET: "prod" },
      }),
    );
    expect(l.execution_overrides).toEqual({ model: "opus" });
    expect(l.variables).toEqual({ PP_TARGET: "prod" });
  });

  // ── crash-resilience task d1 (ADDITIVE optional `attempt`/`max_attempts`/
  //    `resume_hint`/`event_seq_base`) ──────────────────────────────────────

  test("all four attempt fields are OPTIONAL: a lease without them still parses and has no keys", () => {
    const l = LeaseMessageSchema.parse(lease());
    expect(l.attempt).toBeUndefined();
    expect(l.max_attempts).toBeUndefined();
    expect(l.resume_hint).toBeUndefined();
    expect(l.event_seq_base).toBeUndefined();
    expect("attempt" in l).toBe(false);
    expect("max_attempts" in l).toBe(false);
    expect("resume_hint" in l).toBe(false);
    expect("event_seq_base" in l).toBe(false);
  });

  test("a pre-d1 lease (none of the four fields) round-trips byte-identical (old readers unaffected)", () => {
    const original = lease();
    const parsed = LeaseMessageSchema.parse(original);
    expect(parsed as Record<string, unknown>).toEqual(original);
    expect("attempt" in parsed).toBe(false);
    expect("max_attempts" in parsed).toBe(false);
    expect("resume_hint" in parsed).toBe(false);
    expect("event_seq_base" in parsed).toBe(false);
  });

  test("a re-offer lease carries attempt/max_attempts/resume_hint/event_seq_base and round-trips", () => {
    const l = LeaseMessageSchema.parse(
      lease({ attempt: 2, max_attempts: 3, resume_hint: true, event_seq_base: 2_000_000 }),
    );
    expect(l.attempt).toBe(2);
    expect(l.max_attempts).toBe(3);
    expect(l.resume_hint).toBe(true);
    expect(l.event_seq_base).toBe(2_000_000);
  });

  test("a first-attempt lease may set attempt/max_attempts without resume_hint (fresh dispatch, attempt budget only)", () => {
    const l = LeaseMessageSchema.parse(lease({ attempt: 1, max_attempts: 3 }));
    expect(l.attempt).toBe(1);
    expect(l.resume_hint).toBeUndefined();
  });

  test("resume_hint: false is a valid explicit fresh-checkout marker, distinct from absent", () => {
    expect(LeaseMessageSchema.safeParse(lease({ resume_hint: false })).success).toBe(true);
  });

  test("event_seq_base of 0 is valid (nonnegative, not just positive)", () => {
    expect(LeaseMessageSchema.safeParse(lease({ event_seq_base: 0 })).success).toBe(true);
  });

  test("attempt/max_attempts reject non-positive or non-integer values", () => {
    expect(LeaseMessageSchema.safeParse(lease({ attempt: 0 })).success).toBe(false);
    expect(LeaseMessageSchema.safeParse(lease({ attempt: -1 })).success).toBe(false);
    expect(LeaseMessageSchema.safeParse(lease({ attempt: 1.5 })).success).toBe(false);
    expect(LeaseMessageSchema.safeParse(lease({ max_attempts: 0 })).success).toBe(false);
  });

  test("event_seq_base rejects a negative or non-integer value", () => {
    expect(LeaseMessageSchema.safeParse(lease({ event_seq_base: -1 })).success).toBe(false);
    expect(LeaseMessageSchema.safeParse(lease({ event_seq_base: 1.5 })).success).toBe(false);
  });

  test("resume_hint rejects a non-boolean value", () => {
    expect(LeaseMessageSchema.safeParse(lease({ resume_hint: "yes" })).success).toBe(false);
  });

  test("attempt fields coexist with task/execution_overrides/variables on one re-offer lease", () => {
    const l = LeaseMessageSchema.parse(
      lease({
        attempt: 2,
        max_attempts: 3,
        resume_hint: true,
        event_seq_base: 2_000_000,
        execution_overrides: { model: "opus" },
        variables: { PP_TARGET: "prod" },
      }),
    );
    expect(l.attempt).toBe(2);
    expect(l.execution_overrides).toEqual({ model: "opus" });
    expect(l.variables).toEqual({ PP_TARGET: "prod" });
  });

  // ── ADDITIVE-POLICY rule 3: every nested object schema must be `.passthrough()` ──

  test("PipelineRefSchema is passthrough: a newer peer's additive field on pipeline_ref survives", () => {
    const l = LeaseMessageSchema.parse(
      lease({
        pipeline_ref: {
          repo: "acme/api",
          ref: "v43",
          pipeline: "workflows/release",
          content_hash: "sha256:abc",
          future_field: "from-a-newer-peer",
        },
      }),
    );
    expect((l.pipeline_ref as Record<string, unknown>).future_field).toBe("from-a-newer-peer");
  });

  test("the pipeline_ref field IS PipelineRefSchema", () => {
    expect(LeaseMessageSchema.shape.pipeline_ref).toBe(PipelineRefSchema);
  });
});

describe("answer (server → agent — REUSES AnswerMessage, no duplicate)", () => {
  test("valid answer wraps the exact AnswerMessage shape", () => {
    const a = AnswerDeliveryMessageSchema.parse({
      type: "answer",
      id: "ni-1",
      answer: { run_id: "run-7", question_id: "q-abc", answer: "yes, ship it", answered_by: "user:mrbaizor", ts: "2026-07-11T21:00:00.000Z" },
    });
    expect(a.answer.question_id).toBe("q-abc");
    expect(a.answer.answered_by).toBe("user:mrbaizor");
  });

  test("the answer field IS the imported AnswerMessageSchema (single source of truth)", () => {
    expect(AnswerDeliveryMessageSchema.shape.answer).toBe(AnswerMessageSchema);
  });

  test("a bad answer (missing question_id) is rejected via the reused rules", () => {
    expect(
      AnswerDeliveryMessageSchema.safeParse({
        type: "answer",
        answer: { run_id: "run-7", answer: "x", answered_by: "u", ts: "2026-07-11T21:00:00.000Z" },
      }).success,
    ).toBe(false);
  });
});

describe("chat_send (a3-protocol-chat-frames — cloud → runner, run-bound text message)", () => {
  /** A representative valid `chat_send`. */
  function chatSend(overrides: Record<string, unknown> = {}) {
    return {
      type: "chat_send",
      id: "chat-1",
      run_id: "run-7",
      message_id: "msg-abc",
      message: "What's the current status?",
      sent_by: "user:mrbaizor",
      ts: "2026-08-15T21:00:00.000Z",
      ...overrides,
    };
  }

  test("valid chat_send carries run_id + message_id + message + audit identity + ts", () => {
    const c = ChatSendMessageSchema.parse(chatSend());
    expect(c.run_id).toBe("run-7");
    expect(c.message_id).toBe("msg-abc");
    expect(c.message).toBe("What's the current status?");
    expect(c.sent_by).toBe("user:mrbaizor");
  });

  test("rejects a missing run_id, missing/empty message_id, empty message, or missing sent_by/ts", () => {
    const noRunId = chatSend();
    delete (noRunId as Record<string, unknown>).run_id;
    expect(ChatSendMessageSchema.safeParse(noRunId).success).toBe(false);

    const noMessageId = chatSend();
    delete (noMessageId as Record<string, unknown>).message_id;
    expect(ChatSendMessageSchema.safeParse(noMessageId).success).toBe(false); // B1: message_id is REQUIRED
    expect(ChatSendMessageSchema.safeParse(chatSend({ message_id: "" })).success).toBe(false);

    expect(ChatSendMessageSchema.safeParse(chatSend({ message: "" })).success).toBe(false); // empty message — text only, no empty sends

    const noSentBy = chatSend();
    delete (noSentBy as Record<string, unknown>).sent_by;
    expect(ChatSendMessageSchema.safeParse(noSentBy).success).toBe(false);

    const noTs = chatSend();
    delete (noTs as Record<string, unknown>).ts;
    expect(ChatSendMessageSchema.safeParse(noTs).success).toBe(false);
  });

  // ── B1: message_id is the load-bearing turn identity, not the envelope id ──

  test("message_id (not the optional envelope id) is what distinguishes two concurrent turns on the same run", () => {
    const turnA = ChatSendMessageSchema.parse(chatSend({ message_id: "turn-a", message: "First question" }));
    const turnB = ChatSendMessageSchema.parse(chatSend({ message_id: "turn-b", message: "Second question" }));
    expect(turnA.run_id).toBe(turnB.run_id); // same session
    expect(turnA.message_id).not.toBe(turnB.message_id); // distinct turns, unambiguously
  });

  test("a chat_send parses with NO envelope id at all — message_id alone still identifies the turn", () => {
    const noEnvelopeId = chatSend();
    delete (noEnvelopeId as Record<string, unknown>).id;
    const c = ChatSendMessageSchema.parse(noEnvelopeId);
    expect(c.id).toBeUndefined();
    expect(c.message_id).toBe("msg-abc");
  });

  test("(run_id, message_id) is a stable pair a receiver can dedupe a redelivered send on", () => {
    // Two identical frames sharing (run_id, message_id) parse to structurally
    // equal turns — the natural idempotency key, mirroring ingest's
    // (run_id, seq) pair. Redelivery detection itself is a receiver-side
    // concern (F7); this only pins that the KEY is present and stable.
    const first = ChatSendMessageSchema.parse(chatSend());
    const redelivered = ChatSendMessageSchema.parse(chatSend());
    expect([first.run_id, first.message_id]).toEqual([redelivered.run_id, redelivered.message_id]);
  });

  // ── A1: message length bound ────────────────────────────────────────────────

  test("message is bounded by CHAT_MESSAGE_MAX_CHARS", () => {
    expect(ChatSendMessageSchema.safeParse(chatSend({ message: "x".repeat(CHAT_MESSAGE_MAX_CHARS) })).success).toBe(
      true,
    );
    expect(
      ChatSendMessageSchema.safeParse(chatSend({ message: "x".repeat(CHAT_MESSAGE_MAX_CHARS + 1) })).success,
    ).toBe(false);
  });

  test("no attachment / history-backfill fields are part of the schema (R5b minimal channel) — passthrough still tolerates a newer peer's addition", () => {
    const c = ChatSendMessageSchema.parse(chatSend({ attachments: ["from-a-newer-peer"] }));
    expect((c as Record<string, unknown>).attachments).toEqual(["from-a-newer-peer"]);
  });

  // ── B4 fix: assert EACH forbidden authz-shaped key individually, never a
  // single `arrayContaining`-negation check (which passes as soon as just ONE
  // listed key is missing — verified vacuous by the review, not "contains none
  // of these" as the name misleadingly suggests). ──────────────────────────────

  test("sent_by carries no role/permission/org claim — a plain identity string, not an authz assertion (07 T7)", () => {
    const shapeKeys = Object.keys(ChatSendMessageSchema.shape);
    expect(shapeKeys).not.toContain("role");
    expect(shapeKeys).not.toContain("permission");
    expect(shapeKeys).not.toContain("org_id");
    expect(shapeKeys).not.toContain("authz");
    // Belt-and-suspenders: the intersection with the forbidden set is empty,
    // so this fails loudly if ANY of them is later added, not just all four.
    const forbidden = ["role", "permission", "org_id", "authz"];
    expect(forbidden.filter((k) => shapeKeys.includes(k))).toEqual([]);
  });
});

describe("cancel (server → agent)", () => {
  test("valid cancel; reason optional", () => {
    expect(CancelMessageSchema.safeParse({ type: "cancel", run_id: "run-7" }).success).toBe(true);
    const c = CancelMessageSchema.parse({ type: "cancel", run_id: "run-7", job_id: "job-7", reason: "budget cap" });
    expect(c.reason).toBe("budget cap");
  });

  test("rejects a missing run_id", () => {
    expect(CancelMessageSchema.safeParse({ type: "cancel", job_id: "job-7" }).success).toBe(false);
  });
});

describe("heartbeat_ack (server → agent reply)", () => {
  test("valid ack with server ts + directive", () => {
    const ack = HeartbeatAckMessageSchema.parse({ type: "heartbeat_ack", id: "hb-1", ts: "2026-07-11T21:00:00.000Z", directive: "drain" });
    expect(ack.directive).toBe("drain");
  });

  test("rejects an out-of-enum directive", () => {
    expect(HeartbeatAckMessageSchema.safeParse({ type: "heartbeat_ack", directive: "explode" }).success).toBe(false);
  });
});

describe("upload_ack (server → agent — REUSES IngestBatchResponse, no duplicate)", () => {
  test("valid upload_ack wraps the exact ingest response shape", () => {
    const ack = UploadAckMessageSchema.parse({ type: "upload_ack", id: "up-1", ack: { run_id: "run-7", inserted: 2, skipped: 1 } });
    expect(ack.ack.inserted).toBe(2);
    expect(ack.ack.skipped).toBe(1);
  });

  test("the ack field IS the imported IngestBatchResponseSchema (single source of truth)", () => {
    expect(UploadAckMessageSchema.shape.ack).toBe(IngestBatchResponseSchema);
  });

  test("a bad ack (negative count) is rejected via the reused rules", () => {
    expect(UploadAckMessageSchema.safeParse({ type: "upload_ack", ack: { run_id: "run-7", inserted: -1, skipped: 0 } }).success).toBe(false);
  });
});
