import { describe, expect, test } from "bun:test";
import type { z } from "zod";
import { isCompatible, PROTOCOL_VERSION } from "../version.js";
// Import from the PACKAGE ENTRY to prove the department surface reaches the
// barrel (mirrors `../wire/wire.test.ts`'s own convention).
import {
  ClientMessage,
  CLIENT_MESSAGE_TYPES,
  DEPT_CLIENT_VARIANTS,
  DEPT_SERVER_VARIANTS,
  DeptArtifactAckMessageSchema,
  DeptArtifactMessageSchema,
  DeptCancelMessageSchema,
  DeptCapabilitiesSchema,
  DeptConfigUpdateMessageSchema,
  DeptControlMessageSchema,
  DeptEventMessageSchema,
  DeptLeaseRevokedMessageSchema,
  DeptLimitsSchema,
  DeptMessageSchema,
  DeptOfferMessageSchema,
  DeptPartSchema,
  isRegisterCompatible,
  parseClientMessage,
  parseServerMessage,
  RegisterAckMessageSchema,
  RegisterMessageSchema,
  ServerMessage,
  SERVER_MESSAGE_TYPES,
} from "../index.js";

describe("DEPT_CLIENT_VARIANTS / DEPT_SERVER_VARIANTS (department assembly, 08 §2)", () => {
  test("each direction has exactly the six documented department variants", () => {
    const clientTypes = DEPT_CLIENT_VARIANTS.map((v) => v.shape.type.value) as string[];
    const serverTypes = DEPT_SERVER_VARIANTS.map((v) => v.shape.type.value) as string[];
    expect(clientTypes.sort()).toEqual(
      ["department.accept", "department.artifact", "department.event", "department.lease_renew", "department.ready", "department.reject"].sort(),
    );
    expect(serverTypes.sort()).toEqual(
      ["department.artifact_ack", "department.cancel", "department.config_update", "department.lease_revoked", "department.message", "department.offer"].sort(),
    );
  });

  test("every department variant is reachable through the assembled ClientMessage/ServerMessage unions", () => {
    expect(parseClientMessage({ type: "department.ready", department_id: "d1", adapter: "jsonl-process", capabilities: {}, adapter_health: "healthy" }).type).toBe("department.ready");
    expect(parseServerMessage({ type: "department.cancel", task_id: "t1", execution_id: "e1" }).type).toBe("department.cancel");
  });

  test("department types are folded into CLIENT_MESSAGE_TYPES / SERVER_MESSAGE_TYPES with no cross-direction overlap", () => {
    for (const v of DEPT_CLIENT_VARIANTS) expect(CLIENT_MESSAGE_TYPES).toContain(v.shape.type.value);
    for (const v of DEPT_SERVER_VARIANTS) expect(SERVER_MESSAGE_TYPES).toContain(v.shape.type.value);
    const overlap = (CLIENT_MESSAGE_TYPES as readonly string[]).filter((t) =>
      (SERVER_MESSAGE_TYPES as readonly string[]).includes(t),
    );
    expect(overlap).toEqual([]);
    // Sanity: the assembled unions' option counts match (base + 6 department each side).
    expect(CLIENT_MESSAGE_TYPES.length).toBe(ClientMessage.options.length);
    expect(SERVER_MESSAGE_TYPES.length).toBe(ServerMessage.options.length);
  });
});

describe("no server→runner (cloud→runner) department variant carries a bearer/execution token (08 §8)", () => {
  test("none of DEPT_SERVER_VARIANTS' shapes has a bearer/execution-token-shaped field", () => {
    // `lease_token` (on `department.offer`) is DELIBERATELY excluded from the
    // banned set: it is a lease-scoped renewal/revocation credential, the
    // direct analogue of the existing `job_jwt` on `LeaseMessageSchema` — NOT
    // the MCP execution bearer token that 08 §4 explicitly forbids on this
    // frame ("No execution token rides this frame" — the runner mints its
    // own via OAuth client_credentials, naming the execution_id it was
    // offered, per 13 §12).
    const BANNED = /^(bearer_token|access_token|execution_token|authorization|auth_token)$/i;
    for (const variant of DEPT_SERVER_VARIANTS) {
      const offending = Object.keys(variant.shape).filter((k) => BANNED.test(k));
      expect(offending).toEqual([]);
    }
  });

  test("department.offer specifically has no execution-token field, only the lease-scoped lease_token", () => {
    const keys = Object.keys(DeptOfferMessageSchema.shape);
    expect(keys).toContain("lease_token");
    expect(keys.some((k) => /token/i.test(k) && k !== "lease_token")).toBe(false);
  });
});

describe("handshake department extension (08 §7) — additive, isRegisterCompatible untouched", () => {
  test("register accepts the new optional `departments` + `mesh_protocol` fields and round-trips them", () => {
    const parsed = RegisterMessageSchema.parse({
      type: "register",
      runner_token: "rt_1",
      labels: [],
      os: "linux",
      agent_version: "0.4.0",
      cli_version: "3.4.1",
      protocol_version: PROTOCOL_VERSION,
      departments: ["dept-unity", "dept-review"],
      mesh_protocol: 1,
    });
    expect(parsed.departments).toEqual(["dept-unity", "dept-review"]);
    expect(parsed.mesh_protocol).toBe(1);
  });

  test("register_ack accepts the new optional `mesh_enabled` field", () => {
    const parsed = RegisterAckMessageSchema.parse({
      type: "register_ack",
      protocol_version: PROTOCOL_VERSION,
      runner_id: "runner-1",
      mesh_enabled: true,
    });
    expect(parsed.mesh_enabled).toBe(true);
  });

  test("a 0.3.0 runner's `register` (no mesh fields at all) still parses against 0.4.0 schemas", () => {
    const legacyRegister = {
      type: "register",
      runner_token: "rt_legacy",
      labels: ["os:linux"],
      os: "linux",
      agent_version: "0.3.0",
      cli_version: "3.4.0",
      protocol_version: PROTOCOL_VERSION,
    };
    const parsed = RegisterMessageSchema.parse(legacyRegister);
    expect(parsed.departments).toBeUndefined();
    expect(parsed.mesh_protocol).toBeUndefined();
    expect(isRegisterCompatible(parsed)).toBe(true);
  });

  test("isCompatible(1) is still true — the department extension ships inside protocol major 1, no bump", () => {
    expect(isCompatible(1)).toBe(true);
    expect(PROTOCOL_VERSION).toBe(1);
  });
});

describe("ADDITIVE-POLICY rule 3 sweep: every new nested object schema is .passthrough()", () => {
  // Behavioural assertion (not introspection of zod internals): every listed
  // nested schema preserves an unknown field on parse, which is exactly what
  // `.passthrough()` (vs. the default `.strip()`) guarantees.
  const nestedSchemasWithMinimalValid: Array<[string, z.ZodTypeAny, Record<string, unknown>]> = [
    ["DeptPartSchema", DeptPartSchema, { text: "hi" }],
    [
      "DeptMessageSchema",
      DeptMessageSchema,
      { message_id: "m1", role: "ROLE_USER", parts: [{ text: "hi" }], created_at: "2026-07-23T00:00:00.000Z" },
    ],
    ["DeptLimitsSchema", DeptLimitsSchema, {}],
    ["DeptCapabilitiesSchema", DeptCapabilitiesSchema, {}],
  ];

  for (const [name, schema, valid] of nestedSchemasWithMinimalValid) {
    test(`${name} preserves an unknown field (passthrough)`, () => {
      const result = schema.parse({ ...valid, __rule3_probe: "x" });
      expect((result as Record<string, unknown>).__rule3_probe).toBe("x");
    });
  }

  // Top-level department wire frames (built via `wireVariant()`) — same guarantee,
  // inherited from the envelope, spot-checked across every new frame type.
  const frames: Array<[string, z.ZodTypeAny, Record<string, unknown>]> = [
    [
      "DeptConfigUpdateMessageSchema",
      DeptConfigUpdateMessageSchema,
      { type: "department.config_update", department_id: "d1", manifest_digest: "sha256:x", runtime_profile: {}, limits: {} },
    ],
    ["DeptControlMessageSchema", DeptControlMessageSchema, { type: "department.message", task_id: "t1", execution_id: "e1", message: { message_id: "m1", role: "ROLE_USER", parts: [{ text: "hi" }], created_at: "2026-07-23T00:00:00.000Z" } }],
    ["DeptCancelMessageSchema", DeptCancelMessageSchema, { type: "department.cancel", task_id: "t1", execution_id: "e1" }],
    ["DeptLeaseRevokedMessageSchema", DeptLeaseRevokedMessageSchema, { type: "department.lease_revoked", execution_id: "e1", reason: "x" }],
    [
      "DeptArtifactAckMessageSchema",
      DeptArtifactAckMessageSchema,
      { type: "department.artifact_ack", artifact_id: "a1", accepted: true },
    ],
    [
      "DeptEventMessageSchema",
      DeptEventMessageSchema,
      { type: "department.event", execution_id: "e1", task_id: "t1", seq: 1, event: { type: "progress", note: "n" } },
    ],
    [
      "DeptArtifactMessageSchema",
      DeptArtifactMessageSchema,
      {
        type: "department.artifact",
        execution_id: "e1",
        task_id: "t1",
        name: "x.md",
        media_type: "text/markdown",
        size: 1,
        checksum: "abc",
        chunk_index: 0,
        chunk_total: 1,
        bytes: "aGk=",
      },
    ],
  ];

  for (const [name, schema, valid] of frames) {
    test(`${name} frame preserves an unknown field (passthrough, inherited from wireVariant)`, () => {
      const result = schema.parse({ ...valid, __rule3_probe: "y" });
      expect((result as Record<string, unknown>).__rule3_probe).toBe("y");
    });
  }
});

describe("p2-rename-protocol: byte-level wire-value stability (identifiers moved, wire did not)", () => {
  // `src/mesh/` -> `src/department/` and `mesh.test.ts` -> `department.test.ts`
  // renamed FILES, EXPORTED TYPE NAMES stayed `Dept*` (they were never
  // `Mesh*`), and the discriminated-union `type` strings were already
  // `department.*`. The only two fields that still literally say `mesh` on
  // the wire — `register.mesh_protocol` and `register_ack.mesh_enabled` — are
  // deliberately UNCHANGED (a JSON key rename is a wire-value change, and
  // that belongs to c13's dual-accept window, not this rename). These
  // fixtures are frozen JSON.stringify captures taken immediately BEFORE the
  // p2 rename and re-asserted immediately AFTER it landed — any accidental
  // key/value drift (e.g. a find-and-replace catching `mesh_protocol`) fails
  // this test byte-for-byte, not just structurally.
  test("register: full frame, including `departments` + `mesh_protocol`, serializes byte-identically", () => {
    const register = RegisterMessageSchema.parse({
      type: "register",
      runner_token: "rt_1",
      labels: ["os:linux"],
      os: "linux",
      agent_version: "0.4.0",
      cli_version: "3.4.1",
      protocol_version: PROTOCOL_VERSION,
      departments: ["dept-unity"],
      mesh_protocol: 1,
    });
    expect(JSON.stringify(register)).toBe(
      '{"type":"register","runner_token":"rt_1","labels":["os:linux"],"os":"linux","agent_version":"0.4.0","cli_version":"3.4.1","protocol_version":1,"departments":["dept-unity"],"mesh_protocol":1}',
    );
  });

  test("register_ack: full frame, including `mesh_enabled`, serializes byte-identically", () => {
    const ack = RegisterAckMessageSchema.parse({
      type: "register_ack",
      protocol_version: PROTOCOL_VERSION,
      runner_id: "runner-1",
      mesh_enabled: true,
    });
    expect(JSON.stringify(ack)).toBe(
      '{"type":"register_ack","protocol_version":1,"runner_id":"runner-1","mesh_enabled":true}',
    );
  });

  test("department.offer: full frame serializes byte-identically (the renamed directory's own top-level frame)", () => {
    const offer = DeptOfferMessageSchema.parse({
      type: "department.offer",
      execution_id: "e1",
      task_id: "t1",
      context_id: "c1",
      department_id: "d1",
      attempt: 1,
      lease_token: "lt_1",
      lease_ttl_s: 60,
      adapter: "jsonl-process",
      messages: [
        {
          message_id: "m1",
          role: "ROLE_USER",
          parts: [{ text: "hi" }],
          created_at: "2026-07-23T00:00:00.000Z",
        },
      ],
      accepted_output_modes: ["text/markdown"],
      deadline_at: "2026-07-23T01:00:00.000Z",
      event_seq_base: 1000000,
    });
    expect(JSON.stringify(offer)).toBe(
      '{"type":"department.offer","execution_id":"e1","task_id":"t1","context_id":"c1","department_id":"d1","attempt":1,"lease_token":"lt_1","lease_ttl_s":60,"adapter":"jsonl-process","messages":[{"message_id":"m1","role":"ROLE_USER","parts":[{"text":"hi"}],"created_at":"2026-07-23T00:00:00.000Z"}],"accepted_output_modes":["text/markdown"],"deadline_at":"2026-07-23T01:00:00.000Z","event_seq_base":1000000}',
    );
  });
});
