import { describe, expect, test } from "bun:test";
import { DeptLeaseRenewMessageSchema, DeptLeaseRevokedMessageSchema } from "./lease.js";

describe("department.lease_renew (runner → cloud)", () => {
  test("round-trips and rejects a missing required field", () => {
    const valid = { type: "department.lease_renew", id: "corr-1", execution_id: "exec-1", lease_token: "lt_abc" };
    const parsed = DeptLeaseRenewMessageSchema.parse(valid);
    expect(parsed.execution_id).toBe("exec-1");
    expect(parsed.lease_token).toBe("lt_abc");

    const missingExec = { type: "department.lease_renew", lease_token: "lt_abc" };
    expect(DeptLeaseRenewMessageSchema.safeParse(missingExec).success).toBe(false);
    const missingToken = { type: "department.lease_renew", execution_id: "exec-1" };
    expect(DeptLeaseRenewMessageSchema.safeParse(missingToken).success).toBe(false);
  });

  test("an unknown extra field survives a parse", () => {
    const parsed = DeptLeaseRenewMessageSchema.parse({
      type: "department.lease_renew",
      execution_id: "exec-1",
      lease_token: "lt_abc",
      future_field: "x",
    });
    expect((parsed as Record<string, unknown>).future_field).toBe("x");
  });
});

describe("department.lease_revoked (cloud → runner)", () => {
  test("round-trips and rejects a missing required field", () => {
    const valid = { type: "department.lease_revoked", execution_id: "exec-1", reason: "runner lost lease" };
    const parsed = DeptLeaseRevokedMessageSchema.parse(valid);
    expect(parsed.execution_id).toBe("exec-1");
    expect(parsed.reason).toBe("runner lost lease");

    const missingExec = { type: "department.lease_revoked", reason: "x" };
    expect(DeptLeaseRevokedMessageSchema.safeParse(missingExec).success).toBe(false);
    const missingReason = { type: "department.lease_revoked", execution_id: "exec-1" };
    expect(DeptLeaseRevokedMessageSchema.safeParse(missingReason).success).toBe(false);
  });

  test("an unknown extra field survives a parse", () => {
    const parsed = DeptLeaseRevokedMessageSchema.parse({
      type: "department.lease_revoked",
      execution_id: "exec-1",
      reason: "x",
      future_field: 1,
    });
    expect((parsed as Record<string, unknown>).future_field).toBe(1);
  });
});
