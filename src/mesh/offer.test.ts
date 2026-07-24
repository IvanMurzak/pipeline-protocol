import { describe, expect, test } from "bun:test";
import {
  DEPT_REJECT_REASONS,
  DeptAcceptMessageSchema,
  DeptOfferMessageSchema,
  DeptRejectMessageSchema,
} from "./offer.js";

function anOffer(overrides: Record<string, unknown> = {}) {
  return {
    type: "department.offer",
    id: "corr-1",
    execution_id: "exec-1",
    task_id: "dtask_1",
    context_id: "dctx_1",
    department_id: "dept-unity",
    attempt: 1,
    lease_token: "lt_abc",
    lease_ttl_s: 90,
    adapter: "jsonl-process",
    messages: [
      {
        message_id: "msg-1",
        role: "ROLE_USER",
        parts: [{ text: "Review the project" }],
        created_at: "2026-07-23T00:00:00.000Z",
      },
    ],
    accepted_output_modes: ["text/markdown"],
    deadline_at: "2026-07-23T02:00:00.000Z",
    event_seq_base: 1_000_000,
    ...overrides,
  };
}

describe("department.offer (cloud → runner)", () => {
  test("round-trips a valid offer", () => {
    const parsed = DeptOfferMessageSchema.parse(anOffer());
    expect(parsed.type).toBe("department.offer");
    expect(parsed.execution_id).toBe("exec-1");
    expect(parsed.messages).toHaveLength(1);
    const again = DeptOfferMessageSchema.parse(JSON.parse(JSON.stringify(parsed)));
    expect(again).toEqual(parsed);
  });

  test("rejects a missing required field", () => {
    for (const key of [
      "execution_id",
      "task_id",
      "context_id",
      "department_id",
      "attempt",
      "lease_token",
      "lease_ttl_s",
      "adapter",
      "messages",
      "accepted_output_modes",
      "deadline_at",
      "event_seq_base",
    ]) {
      const bad = anOffer();
      delete (bad as Record<string, unknown>)[key];
      expect(DeptOfferMessageSchema.safeParse(bad).success).toBe(false);
    }
  });

  test("an unknown extra field survives a parse (additive-forward)", () => {
    const parsed = DeptOfferMessageSchema.parse(anOffer({ future_field: "x" }));
    expect((parsed as Record<string, unknown>).future_field).toBe("x");
  });

  test("does NOT carry an execution/bearer token field (08 §4 — token minted separately)", () => {
    const keys = Object.keys(DeptOfferMessageSchema.shape);
    expect(keys).not.toContain("execution_token");
    expect(keys).not.toContain("bearer_token");
    expect(keys).not.toContain("access_token");
    // `lease_token` IS present and intentional — a lease-scoped renewal
    // credential, not the MCP execution bearer token (see module doc).
    expect(keys).toContain("lease_token");
  });
});

describe("department.accept (runner → cloud)", () => {
  test("round-trips and rejects a missing required field", () => {
    const valid = { type: "department.accept", id: "corr-1", execution_id: "exec-1", task_id: "dtask_1" };
    expect(DeptAcceptMessageSchema.parse(valid).execution_id).toBe("exec-1");
    const missing = { type: "department.accept", task_id: "dtask_1" };
    expect(DeptAcceptMessageSchema.safeParse(missing).success).toBe(false);
  });

  test("an unknown extra field survives a parse", () => {
    const parsed = DeptAcceptMessageSchema.parse({
      type: "department.accept",
      execution_id: "exec-1",
      task_id: "dtask_1",
      future_field: 7,
    });
    expect((parsed as Record<string, unknown>).future_field).toBe(7);
  });
});

describe("department.reject (runner → cloud)", () => {
  test("accepts every DEPT_REJECT_REASONS value and round-trips", () => {
    for (const reason of DEPT_REJECT_REASONS) {
      const parsed = DeptRejectMessageSchema.parse({
        type: "department.reject",
        execution_id: "exec-1",
        reason,
      });
      expect(parsed.reason).toBe(reason);
    }
  });

  test("rejects an out-of-enum reason and a missing required field", () => {
    expect(
      DeptRejectMessageSchema.safeParse({ type: "department.reject", execution_id: "exec-1", reason: "because" })
        .success,
    ).toBe(false);
    expect(DeptRejectMessageSchema.safeParse({ type: "department.reject", reason: "busy" }).success).toBe(false);
    expect(DeptRejectMessageSchema.safeParse({ type: "department.reject", execution_id: "exec-1" }).success).toBe(
      false,
    );
  });

  test("an unknown extra field survives a parse", () => {
    const parsed = DeptRejectMessageSchema.parse({
      type: "department.reject",
      execution_id: "exec-1",
      reason: "busy",
      future_field: true,
    });
    expect((parsed as Record<string, unknown>).future_field).toBe(true);
  });
});
