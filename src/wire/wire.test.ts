import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION } from "../version.js";
// Import from the PACKAGE ENTRY to prove the wire surface reaches the barrel.
import {
  AnyWireMessage,
  ClientMessage,
  CLIENT_MESSAGE_TYPES,
  parseClientMessage,
  parseServerMessage,
  safeParseClientMessage,
  safeParseServerMessage,
  ServerMessage,
  SERVER_MESSAGE_TYPES,
} from "../index.js";

const aRegister = {
  type: "register",
  runner_token: "rt_1",
  labels: [],
  os: "linux",
  agent_version: "0.1.0",
  cli_version: "3.4.1",
  protocol_version: PROTOCOL_VERSION,
};
const aLease = {
  type: "lease",
  job_id: "job-1",
  run_id: "run-1",
  pipeline_ref: { repo: "acme/api", ref: "main", pipeline: "p" },
  labels: [],
  job_jwt: "jwt",
  secret_slugs: [],
};

describe("ClientMessage discriminated union (agent → server)", () => {
  test("routes each known agent→server type", () => {
    expect(parseClientMessage(aRegister).type).toBe("register");
    expect(parseClientMessage({ type: "heartbeat", runner_id: "r1" }).type).toBe("heartbeat");
    expect(parseClientMessage({ type: "run_status", run_id: "run-1", phase: "started" }).type).toBe("run_status");
  });

  test("parseClientMessage THROWS on an unknown type; safeParse reports failure", () => {
    expect(() => parseClientMessage({ type: "not_a_client_msg" })).toThrow();
    expect(safeParseClientMessage({ type: "not_a_client_msg" }).success).toBe(false);
  });

  test("a SERVER message is not a valid ClientMessage (direction separation)", () => {
    // `lease` is server→agent — it must NOT parse as a client message.
    expect(safeParseClientMessage(aLease).success).toBe(false);
  });
});

describe("ServerMessage discriminated union (server → agent)", () => {
  test("routes each known server→agent type", () => {
    expect(parseServerMessage(aLease).type).toBe("lease");
    expect(parseServerMessage({ type: "cancel", run_id: "run-1" }).type).toBe("cancel");
    expect(parseServerMessage({ type: "register_reject", reason: "revoked" }).type).toBe("register_reject");
  });

  test("a lease round-trips WITH and WITHOUT the optional T2-05 task field", () => {
    // Absent: the T2-03 fixed-pipeline lease is untouched by the extension.
    const fixed = parseServerMessage(aLease);
    expect(fixed.type).toBe("lease");
    expect((fixed as Record<string, unknown>).task).toBeUndefined();

    // Present: a task-dispatch lease carries the work item verbatim.
    const task = { task_id: "t-1", title: "Ship the release", body: "cut v1.2", labels: ["os:linux"] };
    const taskLease = {
      ...aLease,
      pipeline_ref: { repo: "acme/api", ref: "main", pipeline: "@task", content_hash: null },
      task,
    };
    const parsed = parseServerMessage(taskLease);
    expect(parsed.type).toBe("lease");
    if (parsed.type !== "lease") throw new Error("expected lease");
    expect(parsed.task).toEqual(task);
    expect(parsed.pipeline_ref.pipeline).toBe("@task");
    // Full round-trip: re-serialize + re-parse is lossless for the task.
    const again = parseServerMessage(JSON.parse(JSON.stringify(parsed)));
    if (again.type !== "lease") throw new Error("expected lease");
    expect(again.task).toEqual(task);
  });

  test("parseServerMessage THROWS on an unknown type; safeParse reports failure", () => {
    expect(() => parseServerMessage({ type: "not_a_server_msg" })).toThrow();
    expect(safeParseServerMessage({ type: "not_a_server_msg" }).success).toBe(false);
  });

  test("a CLIENT message is not a valid ServerMessage (direction separation)", () => {
    expect(safeParseServerMessage(aRegister).success).toBe(false);
  });
});

describe("AnyWireMessage forward/backward compatibility", () => {
  test("tolerates an UNKNOWN FUTURE message type (well-formed envelope)", () => {
    // A newer peer sends a message type this build has never heard of. The strict
    // unions reject it, but AnyWireMessage validates it as a well-formed frame so
    // a router can log/ignore it instead of dropping the connection.
    const future = { type: "quota_grant", id: "c-9", quota: 1000, window: "1h" };
    expect(safeParseClientMessage(future).success).toBe(false);
    expect(safeParseServerMessage(future).success).toBe(false);

    const any = AnyWireMessage.parse(future);
    expect(any.type).toBe("quota_grant");
    expect(any.id).toBe("c-9");
    // Passthrough preserves the unknown peer's extra fields.
    expect((any as Record<string, unknown>).quota).toBe(1000);
  });

  test("AnyWireMessage still requires a non-empty type discriminant", () => {
    expect(AnyWireMessage.safeParse({ id: "x" }).success).toBe(false);
    expect(AnyWireMessage.safeParse({ type: "" }).success).toBe(false);
  });

  test("a KNOWN message also validates against AnyWireMessage (superset)", () => {
    expect(AnyWireMessage.safeParse(aRegister).success).toBe(true);
    expect(AnyWireMessage.safeParse(aLease).success).toBe(true);
  });
});

describe("message catalogues", () => {
  test("CLIENT_MESSAGE_TYPES lists every agent→server variant exactly once", () => {
    expect(CLIENT_MESSAGE_TYPES.length).toBe(ClientMessage.options.length);
    expect(new Set(CLIENT_MESSAGE_TYPES).size).toBe(CLIENT_MESSAGE_TYPES.length);
    expect([...CLIENT_MESSAGE_TYPES].sort()).toEqual(
      ["accept", "heartbeat", "needs_input", "register", "run_status", "upload"].sort() as typeof CLIENT_MESSAGE_TYPES[number][],
    );
  });

  test("SERVER_MESSAGE_TYPES lists every server→agent variant exactly once", () => {
    expect(SERVER_MESSAGE_TYPES.length).toBe(ServerMessage.options.length);
    expect(new Set(SERVER_MESSAGE_TYPES).size).toBe(SERVER_MESSAGE_TYPES.length);
    expect([...SERVER_MESSAGE_TYPES].sort()).toEqual(
      ["answer", "cancel", "heartbeat_ack", "lease", "register_ack", "register_reject", "upload_ack"].sort() as typeof SERVER_MESSAGE_TYPES[number][],
    );
  });

  test("no type appears in BOTH directions (disjoint client/server sets)", () => {
    const overlap = CLIENT_MESSAGE_TYPES.filter((t) => (SERVER_MESSAGE_TYPES as readonly string[]).includes(t));
    expect(overlap).toEqual([]);
  });
});
