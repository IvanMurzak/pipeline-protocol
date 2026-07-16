import { describe, expect, test } from "bun:test";
import { AnswerMessageSchema } from "../records/answer.js";
import { IngestBatchResponseSchema } from "../ingest/index.js";
import {
  AnswerDeliveryMessageSchema,
  CancelMessageSchema,
  ExecutionOverridesSchema,
  HeartbeatAckMessageSchema,
  LeaseMessageSchema,
  LeaseTaskSchema,
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
