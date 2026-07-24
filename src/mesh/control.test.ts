import { describe, expect, test } from "bun:test";
import {
  DeptCancelMessageSchema,
  DeptCapabilitiesSchema,
  DeptConfigUpdateMessageSchema,
  DeptControlMessageSchema,
  DeptLimitsSchema,
  DeptReadyMessageSchema,
} from "./control.js";

describe("department.config_update (cloud → runner)", () => {
  function aConfigUpdate(overrides: Record<string, unknown> = {}) {
    return {
      type: "department.config_update",
      department_id: "dept-unity",
      manifest_digest: "sha256:abcd",
      runtime_profile: { engineVersion: "2022.3" },
      limits: { taskTimeout: "2h", parkExpiry: "7d", maxArtifactBytes: 1_048_576, retrySafe: false },
      ...overrides,
    };
  }

  test("round-trips a valid config_update", () => {
    const parsed = DeptConfigUpdateMessageSchema.parse(aConfigUpdate());
    expect(parsed.department_id).toBe("dept-unity");
    expect(parsed.limits.taskTimeout).toBe("2h");
    expect(parsed.runtime_profile.engineVersion).toBe("2022.3");
    const again = DeptConfigUpdateMessageSchema.parse(JSON.parse(JSON.stringify(parsed)));
    expect(again).toEqual(parsed);
  });

  test("`limits` fields are all optional (a partial manifest omits what it hasn't declared)", () => {
    expect(DeptLimitsSchema.safeParse({}).success).toBe(true);
    expect(DeptLimitsSchema.safeParse({ taskTimeout: "2h" }).success).toBe(true);
  });

  test("rejects a missing required top-level field", () => {
    for (const key of ["department_id", "manifest_digest", "runtime_profile", "limits"]) {
      const bad = aConfigUpdate();
      delete (bad as Record<string, unknown>)[key];
      expect(DeptConfigUpdateMessageSchema.safeParse(bad).success).toBe(false);
    }
  });

  test("an unknown extra field survives a parse, at both the frame and `limits` level", () => {
    const parsed = DeptConfigUpdateMessageSchema.parse(
      aConfigUpdate({ limits: { taskTimeout: "2h", future_limit: "x" }, future_field: "y" }),
    );
    expect((parsed as Record<string, unknown>).future_field).toBe("y");
    expect((parsed.limits as Record<string, unknown>).future_limit).toBe("x");
  });
});

describe("department.message (cloud → runner, mid-task input)", () => {
  function aMessage(overrides: Record<string, unknown> = {}) {
    return {
      type: "department.message",
      task_id: "dtask_1",
      execution_id: "exec-1",
      message: {
        message_id: "msg-2",
        role: "ROLE_USER",
        parts: [{ text: "Use Addressables instead." }],
        created_at: "2026-07-23T00:00:00.000Z",
      },
      ...overrides,
    };
  }

  test("round-trips a valid mid-task message", () => {
    const parsed = DeptControlMessageSchema.parse(aMessage());
    expect(parsed.task_id).toBe("dtask_1");
    expect(parsed.message.parts).toHaveLength(1);
  });

  test("rejects a missing required field", () => {
    for (const key of ["task_id", "execution_id", "message"]) {
      const bad = aMessage();
      delete (bad as Record<string, unknown>)[key];
      expect(DeptControlMessageSchema.safeParse(bad).success).toBe(false);
    }
  });

  test("an unknown extra field survives a parse", () => {
    const parsed = DeptControlMessageSchema.parse(aMessage({ future_field: 1 }));
    expect((parsed as Record<string, unknown>).future_field).toBe(1);
  });
});

describe("department.cancel (cloud → runner)", () => {
  test("round-trips with and without an optional reason, rejects a missing required field", () => {
    const withReason = DeptCancelMessageSchema.parse({
      type: "department.cancel",
      task_id: "dtask_1",
      execution_id: "exec-1",
      reason: "caller canceled",
    });
    expect(withReason.reason).toBe("caller canceled");

    const noReason = DeptCancelMessageSchema.parse({ type: "department.cancel", task_id: "dtask_1", execution_id: "exec-1" });
    expect(noReason.reason).toBeUndefined();

    expect(DeptCancelMessageSchema.safeParse({ type: "department.cancel", execution_id: "exec-1" }).success).toBe(
      false,
    );
    expect(DeptCancelMessageSchema.safeParse({ type: "department.cancel", task_id: "dtask_1" }).success).toBe(false);
  });

  test("an unknown extra field survives a parse", () => {
    const parsed = DeptCancelMessageSchema.parse({
      type: "department.cancel",
      task_id: "dtask_1",
      execution_id: "exec-1",
      future_field: 1,
    });
    expect((parsed as Record<string, unknown>).future_field).toBe(1);
  });
});

describe("department.ready (runner → cloud)", () => {
  function aReady(overrides: Record<string, unknown> = {}) {
    return {
      type: "department.ready",
      department_id: "dept-unity",
      adapter: "jsonl-process",
      capabilities: { acceptsMidTaskInput: true, supportsStreaming: true },
      adapter_health: "healthy",
      ...overrides,
    };
  }

  test("round-trips a valid ready frame", () => {
    const parsed = DeptReadyMessageSchema.parse(aReady());
    expect(parsed.capabilities.acceptsMidTaskInput).toBe(true);
    expect(parsed.adapter_health).toBe("healthy");
  });

  test("capabilities fields are all optional", () => {
    expect(DeptCapabilitiesSchema.safeParse({}).success).toBe(true);
  });

  test("rejects a missing required field", () => {
    for (const key of ["department_id", "adapter", "capabilities", "adapter_health"]) {
      const bad = aReady();
      delete (bad as Record<string, unknown>)[key];
      expect(DeptReadyMessageSchema.safeParse(bad).success).toBe(false);
    }
  });

  test("an unknown extra field survives a parse, at both the frame and `capabilities` level", () => {
    const parsed = DeptReadyMessageSchema.parse(
      aReady({ capabilities: { acceptsMidTaskInput: true, future_cap: true }, future_field: "z" }),
    );
    expect((parsed as Record<string, unknown>).future_field).toBe("z");
    expect((parsed.capabilities as Record<string, unknown>).future_cap).toBe(true);
  });
});
