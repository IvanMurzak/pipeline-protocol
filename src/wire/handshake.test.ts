import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION } from "../version.js";
import {
  isRegisterCompatible,
  RegisterAckMessageSchema,
  RegisterMessageSchema,
  RegisterRejectMessageSchema,
  REGISTER_REJECT_REASONS,
} from "./handshake.js";

/** A representative valid `register` frame at the current protocol major. */
function register(overrides: Record<string, unknown> = {}) {
  return {
    type: "register",
    runner_token: "rt_live_abc123",
    labels: ["os:windows", "repo:acme/api"],
    os: "windows",
    agent_version: "0.1.0",
    cli_version: "3.4.1",
    plugin_version: "2.9.0",
    protocol_version: PROTOCOL_VERSION,
    capacity: 2,
    ...overrides,
  };
}

describe("register (agent → server handshake)", () => {
  test("valid register parses and keeps its fields", () => {
    const msg = RegisterMessageSchema.parse(register());
    expect(msg.type).toBe("register");
    expect(msg.runner_token).toBe("rt_live_abc123");
    expect(msg.protocol_version).toBe(PROTOCOL_VERSION);
    expect(msg.labels).toContain("os:windows");
  });

  test("plugin_version is optional/nullable (runner without the plugin)", () => {
    expect(RegisterMessageSchema.safeParse(register({ plugin_version: null })).success).toBe(true);
    const noPlugin = register();
    delete (noPlugin as Record<string, unknown>).plugin_version;
    expect(RegisterMessageSchema.safeParse(noPlugin).success).toBe(true);
  });

  test("rejects a malformed register (empty token, non-integer protocol_version)", () => {
    expect(RegisterMessageSchema.safeParse(register({ runner_token: "" })).success).toBe(false);
    expect(RegisterMessageSchema.safeParse(register({ protocol_version: 1.5 })).success).toBe(false);
    const noToken = register();
    delete (noToken as Record<string, unknown>).runner_token;
    expect(RegisterMessageSchema.safeParse(noToken).success).toBe(false);
  });

  test("additive-forward: an unknown future field is preserved, not rejected", () => {
    const msg = RegisterMessageSchema.parse(register({ gpu_count: 4 }));
    expect((msg as Record<string, unknown>).gpu_count).toBe(4);
  });
});

describe("version negotiation (reuses isCompatible)", () => {
  test("ACCEPT: a same-major runner is register-compatible", () => {
    expect(isRegisterCompatible({ protocol_version: PROTOCOL_VERSION })).toBe(true);
    expect(isRegisterCompatible(RegisterMessageSchema.parse(register()))).toBe(true);
  });

  test("REJECT: a differing / invalid major is NOT compatible (→ upgrade_required)", () => {
    expect(isRegisterCompatible({ protocol_version: PROTOCOL_VERSION + 1 })).toBe(false);
    expect(isRegisterCompatible({ protocol_version: 0 })).toBe(false);
    expect(isRegisterCompatible({ protocol_version: 1.5 })).toBe(false);
  });

  test("register_ack carries the negotiated version + assigned runner_id", () => {
    const ack = RegisterAckMessageSchema.parse({
      type: "register_ack",
      id: "corr-1",
      protocol_version: PROTOCOL_VERSION,
      runner_id: "runner-42",
      heartbeat_interval_s: 15,
    });
    expect(ack.type).toBe("register_ack");
    expect(ack.protocol_version).toBe(PROTOCOL_VERSION);
    expect(ack.runner_id).toBe("runner-42");
  });

  test("register_reject: upgrade_required states the minimum protocol major", () => {
    const rej = RegisterRejectMessageSchema.parse({
      type: "register_reject",
      reason: "upgrade_required",
      min_protocol_version: PROTOCOL_VERSION,
      message: "runner too old",
    });
    expect(rej.type).toBe("register_reject");
    expect(rej.reason).toBe("upgrade_required");
    expect(rej.min_protocol_version).toBe(PROTOCOL_VERSION);
  });

  test("register_reject rejects an out-of-enum reason", () => {
    expect(
      RegisterRejectMessageSchema.safeParse({ type: "register_reject", reason: "because" }).success,
    ).toBe(false);
    // The enumerated reasons are the only accepted ones.
    for (const reason of REGISTER_REJECT_REASONS) {
      expect(RegisterRejectMessageSchema.safeParse({ type: "register_reject", reason }).success).toBe(true);
    }
  });
});
