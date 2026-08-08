/**
 * THE ALLOWLIST CONFORMANCE TEST — ux-v2 gate SG1.
 *
 * This file is the privacy policy, executable. It is not a smoke test that
 * "runs the filter and eyeballs the output": such a test passes when a field is
 * ADDED to an allowlist, because a fixture that happens not to carry the new
 * field cannot notice it. The policy is pinned three independent ways instead:
 *
 *  1. **Structural pin** — the allowlist object literals are extracted from
 *     `./privacy.ts`'s own syntax tree and deep-compared against the pinned
 *     tables below. Catches an added/removed FIELD, an added/removed EVENT
 *     TYPE, a changed rule, and any non-literal (computed/spread) member that
 *     would make the table unreadable.
 *  2. **Behavioural pin** — the same tables are re-derived from the COMPILED
 *     filter, by walking it with a `Proxy` whose `has` trap answers `true` for
 *     every key: `filterByAllowlist` asks `field in source` once per allowlist
 *     entry, so the trap enumerates the live allowlist without the module
 *     having to export it. Each field's RULE is then identified by matching its
 *     three probe outputs against the five rules' signatures — so a
 *     `keep`→`fingerprint` flip (or the reverse, which is a leak) is caught too.
 *  3. **Hostile fixture** — a synthetic event stuffed with prompts, absolute
 *     machine paths, tool arguments, credentials and error text is driven
 *     through the filter, its output asserted EXACTLY, and the serialized
 *     result scanned for every planted secret.
 *  4. **The SG4 value rule** (§6, added by ux-v2 `b23`) — the pin the tables
 *     cannot express.
 *
 * Changing `./privacy.ts`'s allowlists is SUPPOSED to turn this suite red. Edit
 * the pinned tables below in the same commit, deliberately: that edit is the
 * privacy-policy change, and it is what a reviewer reads.
 *
 * ── WHY PINS 1–3 WERE NOT ENOUGH, AND WHAT `b23` CHANGED HERE ───────────────
 *
 * A table says which FIELDS survive. It says nothing about what a surviving
 * VALUE may contain — and `keep` meant "verbatim, absolute machine path and
 * all". `C:\Users\<account>\…` reached the production `events` table for three
 * weeks (2026-07-19 → 2026-08-07, 17 rows) through `iteration_path`, and this
 * suite was green the entire time, because:
 *
 *   - the hostile fixture planted absolute paths ONLY in fields the table
 *     already marks `fingerprint` (`project_root`, `worktree`, `pipeline_root`,
 *     `worktree_path`, `env_file`, `hook_dir`), and
 *   - it planted `iteration_path` as an ALREADY-RELATIVE `"steps/03-implement"`
 *     and asserted it SURVIVES — which is correct, and on its own encoded the
 *     filter's false assumption (that the emitter hands it relative paths) as
 *     the contract.
 *
 * Both are corrected below rather than deleted: each value is now planted BOTH
 * ways, relative and absolute. §6 pins the rule itself, including the two
 * places a field-NAME rule cannot reach — `stats.failures[].step`, which is
 * `keep`-classified and not `*_path`-named, and a path embedded in a `summary`
 * field's free text.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import {
  DEFAULT_PRIVACY_TIER,
  MESSAGE_PARTS_PLACEHOLDER,
  PRIVACY_SALT_ENV,
  PRIVACY_TIER_ENV,
  PRIVACY_TIERS,
  QUESTION_PLACEHOLDER,
  SUMMARY_MAX_CHARS,
  SG4_PATH_RE,
  collectPathRoots,
  defaultAccountNames,
  filterEventForTier,
  filterStatsRecordMetadata,
  fingerprintString,
  looksAbsolutePath,
  resolvePrivacyTier,
  scrubPathString,
  STEP_IDENTITY_FIELD,
  STEP_SCOPED_EVENT_TYPES,
  stepShapedAllowlistViolations,
  stripStatsFailureExcerpts,
} from "./index.js";

// ── 0. The pinned policy ─────────────────────────────────────────────────────
// Mirrors `./privacy.ts` field-for-field. NOTHING here is derived from the
// implementation; it is transcribed by hand on purpose.

/** The rule vocabulary. A sixth rule is a policy change and must fail here. */
const PINNED_FIELD_RULES = ["keep", "fingerprint", "summary", "question", "message_parts"] as const;
type Rule = (typeof PINNED_FIELD_RULES)[number];

/** Every envelope field kept at the `metadata` tier. */
const PINNED_ENVELOPE: Record<string, Rule> = {
  schema: "keep",
  ts: "keep",
  type: "keep",
  run_id: "keep",
  parent_run_id: "keep",
  session_id: "keep",
  project_root: "fingerprint",
  worktree: "fingerprint",
  task_id: "keep",
  context_id: "keep",
  department_id: "keep",
  engine: "keep",
  sender: "fingerprint",
};

/** Every event type with a `data` allowlist, and every field inside it.
 *  A type ABSENT from this table ships `data: {}` (privacy.ts:137, :405). */
const PINNED_DATA: Record<string, Record<string, Rule>> = {
  "session.opened": { claude_pid: "keep" },
  "pipeline.started": {
    pipeline_name: "keep",
    first_iteration_path: "keep",
    pipeline_root: "fingerprint",
    default_model: "keep",
  },
  "iteration.started": {
    iteration_path: "keep",
    index: "keep",
    resolved_model: "keep",
    resolved_effort: "keep",
    step_name: "keep",
    step_id: "keep",
    step_type: "keep",
    resumed: "keep",
    emission: "keep",
    step_uuid: "keep",
  },
  "iteration.resumed": {
    iteration_path: "keep",
    index: "keep",
    resolved_model: "keep",
    resolved_effort: "keep",
    step_name: "keep",
    step_id: "keep",
    resumed: "keep",
    emission: "keep",
    step_uuid: "keep",
  },
  "iteration.completed": {
    iteration_path: "keep",
    outcome: "keep",
    next_iteration_path: "keep",
    has_improvement_brief: "keep",
    has_blocker_delegation: "keep",
    halt_reason: "summary",
    terminal: "keep",
    step_name: "keep",
    step_id: "keep",
    step_type: "keep",
    failure_class: "keep",
    step_uuid: "keep",
  },
  "improver.started": { iteration_path: "keep", step_uuid: "keep" },
  "improver.completed": {
    iteration_path: "keep",
    applied: "keep",
    has_script_brief: "keep",
    step_uuid: "keep",
  },
  "script_creator.started": { iteration_path: "keep", step_uuid: "keep" },
  "script_creator.completed": {
    iteration_path: "keep",
    script_path: "keep",
    outcome: "keep",
    step_uuid: "keep",
  },
  "blocker.delegated": {
    parent_iteration_path: "keep",
    blocker_issue_url: "keep",
    child_run_id: "keep",
    blocker_target_repo: "keep",
  },
  "blocker.polling": { blocker_issue_url: "keep", pr_state: "keep" },
  "blocker.resolved": { blocker_issue_url: "keep", merged_pr_url: "keep" },
  "pipeline.completed": { pipeline_name: "keep" },
  "pipeline.halted": { pipeline_name: "keep", iteration_path: "keep", halt_reason: "summary" },
  "manager.stopped": { run_id: "keep", agent_id: "keep", step_uuid: "keep" },
  "worktree.created": {
    worktree_path: "fingerprint",
    branch: "keep",
    env_file: "fingerprint",
    port_base: "keep",
    ok: "keep",
    hook_dir: "fingerprint",
    // `detail` (free-text hook stderr) is deliberately ABSENT: dropped.
  },
  "worktree.finalized": { worktree_path: "fingerprint", ok: "keep", outcome: "keep" },
  "worktree.destroyed": { worktree_path: "fingerprint", ok: "keep", outcome: "keep" },
  "tool.called": {
    tool_name: "keep",
    success: "keep",
    agent_spawn: "keep",
    tool_use_id: "keep",
    step_uuid: "keep",
  },
  "turn.usage": {
    assistant_turns: "keep",
    input_tokens: "keep",
    output_tokens: "keep",
    cache_read_tokens: "keep",
    cache_creation_tokens: "keep",
    step_uuid: "keep",
  },
  "run.started": {
    pipeline_name: "keep",
    pipeline_root: "fingerprint",
    first_iteration_path: "keep",
    orchestrator: "keep",
    default_model: "keep",
  },
  "run.completed": { pipeline_name: "keep", outcome: "keep" },
  "run.halted": { pipeline_name: "keep", iteration_path: "keep", halt_reason: "summary" },
  awaiting_input: {
    run_id: "keep",
    iteration: "keep",
    question_id: "keep",
    question: "question",
    step_name: "keep",
    iteration_path: "keep",
    step_uuid: "keep",
  },
  // Routed to the nested stats filter before this table is consulted; the empty
  // entry only lets the envelope walk pass the already-filtered record through.
  "stats.run_record": {},
  "department.status": { state: "keep", message: "summary" },
  "department.progress": { note: "summary" },
  "department.input_required": { question_id: "keep", question: "question" },
  "department.message": { parts: "message_parts" },
  // `path` / `bytes_base64` are content — deliberately ABSENT: dropped.
  "department.artifact": { name: "keep", media_type: "keep" },
  "department.completed": { summary: "summary" },
  "department.failed": { reason: "summary", retry_safe: "keep" },
};

const PINNED_STATS_RECORD: Record<string, Rule> = {
  schema: "keep",
  run_id: "keep",
  pipeline: "keep",
  started_at: "keep",
  ended_at: "keep",
  duration_s: "keep",
  outcome: "keep",
  halt_reason: "summary",
  runner: "keep",
  mode: "keep",
  steps_run: "keep",
  improver_runs: "keep",
  improver_applied: "keep",
  scripts_created: "keep",
  merges: "keep",
  merge_conflicts: "keep",
  llm_steps: "keep",
  revision: "keep",
  origin: "keep",
};

/** `RunFailureDetail` — the `error` excerpt is deliberately ABSENT (D16). */
const PINNED_STATS_FAILURE: Record<string, Rule> = { ts: "keep", tool: "keep", step: "keep" };

const PINNED_STATS_STEP: Record<string, Rule> = {
  id: "keep",
  started_at: "keep",
  seconds: "keep",
  outcome: "keep",
  model: "keep",
  effort: "keep",
  step_type: "keep",
  failure_class: "keep",
  step_uuid: "keep",
};

const PINNED_STATS_TOKENS: Record<string, Rule> = {
  input: "keep",
  output: "keep",
  cache_read: "keep",
  cache_creation: "keep",
  tools_called: "keep",
  tools_failed: "keep",
  failed_tools: "keep",
  agents_spawned: "keep",
  cost_usd: "keep",
};

/** The ONLY module `./privacy.ts` may import. A second import is a new data
 *  path into the trust boundary and must be reviewed, not merged silently.
 *
 *  Still exactly one after ux-v2 `b23`, deliberately: the SG4 rule reads the OS
 *  account name out of the environment rather than through `node:os.homedir()`,
 *  and splits the home directory's last segment by hand rather than through
 *  `node:path.basename()` — which would in any case apply the wrong platform's
 *  rules, since a Windows-shaped path is routinely scrubbed on a Linux CI
 *  runner and vice versa. */
const PINNED_IMPORTS = ["node:crypto"];

// ── 1. Structural pin: read the allowlists out of the source's syntax tree ───

const PRIVACY_SOURCE_PATH = join(import.meta.dir, "privacy.ts");
const PRIVACY_SOURCE = readFileSync(PRIVACY_SOURCE_PATH, "utf8");
const PRIVACY_AST = ts.createSourceFile("privacy.ts", PRIVACY_SOURCE, ts.ScriptTarget.ES2022, true);

function propertyKey(name: ts.PropertyName, label: string): string {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  throw new Error(`${label}: key is not a plain identifier or string literal — cannot be pinned`);
}

/** `{ field: 'rule', … }` → `{ field: 'rule' }`. THROWS on anything that is not
 *  a literal key/value pair (spread, computed key, variable, method), because
 *  such a member could smuggle an entry past the pinned table. */
function readFlatTable(node: ts.Expression | undefined, label: string): Record<string, string> {
  if (node === undefined || !ts.isObjectLiteralExpression(node)) {
    throw new Error(`${label}: expected an object literal`);
  }
  const out: Record<string, string> = {};
  for (const prop of node.properties) {
    if (!ts.isPropertyAssignment(prop)) throw new Error(`${label}: non-literal member`);
    const key = propertyKey(prop.name, label);
    if (!ts.isStringLiteral(prop.initializer)) {
      throw new Error(`${label}.${key}: rule is not a string literal`);
    }
    if (key in out) throw new Error(`${label}: duplicate key '${key}'`);
    out[key] = prop.initializer.text;
  }
  return out;
}

/** `{ 'event.type': { field: 'rule' }, … }` — same strictness, one level down. */
function readNestedTable(
  node: ts.Expression | undefined,
  label: string,
): Record<string, Record<string, string>> {
  if (node === undefined || !ts.isObjectLiteralExpression(node)) {
    throw new Error(`${label}: expected an object literal`);
  }
  const out: Record<string, Record<string, string>> = {};
  for (const prop of node.properties) {
    if (!ts.isPropertyAssignment(prop)) throw new Error(`${label}: non-literal member`);
    const key = propertyKey(prop.name, label);
    if (key in out) throw new Error(`${label}: duplicate key '${key}'`);
    out[key] = readFlatTable(prop.initializer, `${label}['${key}']`);
  }
  return out;
}

function topLevelInitializer(name: string): ts.Expression | undefined {
  for (const statement of PRIVACY_AST.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
        return declaration.initializer;
      }
    }
  }
  return undefined;
}

describe("structural pin — the allowlists as written in privacy.ts", () => {
  test("ENVELOPE_ALLOWLIST is exactly the pinned envelope policy", () => {
    expect(readFlatTable(topLevelInitializer("ENVELOPE_ALLOWLIST"), "ENVELOPE_ALLOWLIST")).toEqual(
      PINNED_ENVELOPE,
    );
  });

  test("DATA_ALLOWLISTS is exactly the pinned per-event-type policy", () => {
    const actual = readNestedTable(topLevelInitializer("DATA_ALLOWLISTS"), "DATA_ALLOWLISTS");
    // Pinned type-for-type first, so a NEW event type reads as one clear
    // failure rather than a wall of field diffs.
    expect(Object.keys(actual).sort()).toEqual(Object.keys(PINNED_DATA).sort());
    expect(actual).toEqual(PINNED_DATA);
  });

  test("the nested stats allowlists are exactly the pinned stats policy", () => {
    expect(readFlatTable(topLevelInitializer("STATS_RECORD_ALLOWLIST"), "STATS_RECORD")).toEqual(
      PINNED_STATS_RECORD,
    );
    expect(readFlatTable(topLevelInitializer("STATS_FAILURE_ALLOWLIST"), "STATS_FAILURE")).toEqual(
      PINNED_STATS_FAILURE,
    );
    expect(readFlatTable(topLevelInitializer("STATS_STEP_ALLOWLIST"), "STATS_STEP")).toEqual(
      PINNED_STATS_STEP,
    );
    expect(readFlatTable(topLevelInitializer("STATS_TOKENS_ALLOWLIST"), "STATS_TOKENS")).toEqual(
      PINNED_STATS_TOKENS,
    );
  });

  test("`FieldRule` declares exactly the five pinned rules", () => {
    const alias = PRIVACY_AST.statements.find(
      (s): s is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(s) && s.name.text === "FieldRule",
    );
    if (alias === undefined || !ts.isUnionTypeNode(alias.type)) {
      throw new Error("FieldRule is not a union type alias");
    }
    const members = alias.type.types.map((member) => {
      if (!ts.isLiteralTypeNode(member) || !ts.isStringLiteral(member.literal)) {
        throw new Error("FieldRule member is not a string literal type");
      }
      return member.literal.text;
    });
    expect(members.sort()).toEqual([...PINNED_FIELD_RULES].sort());
  });

  test("privacy.ts imports node:crypto and nothing else", () => {
    const specifiers = PRIVACY_AST.statements.filter(ts.isImportDeclaration).map((decl) => {
      if (!ts.isStringLiteral(decl.moduleSpecifier)) throw new Error("non-literal import specifier");
      return decl.moduleSpecifier.text;
    });
    expect(specifiers).toEqual(PINNED_IMPORTS);
  });
});

// ── 2. Behavioural pin: re-derive the allowlists from the compiled filter ────
//
// `filterByAllowlist` asks `field in source` once per allowlist entry, so a
// Proxy whose `has` trap always answers `true` gets asked for EVERY key in the
// live allowlist — the enumeration the module does not export. Its `get` trap
// then returns a probe value, and the rule is identified by which of the five
// rules' signatures the three probe results match.

const SALT = "conformance-salt";
const ABSENT = Symbol("absent");

/** Longer than SUMMARY_MAX_CHARS so `keep` and `summary` are distinguishable. */
const STRING_PROBE = `PROBE-${"x".repeat(SUMMARY_MAX_CHARS + 64)}`;
const RECORD_PROBE = { question_id: "q-probe", text: "authored question text", options: ["a", "b"] };
const ARRAY_PROBE = [{ text: "authored message part", media_type: "text/markdown" }];
const PROBES: readonly unknown[] = [STRING_PROBE, RECORD_PROBE, ARRAY_PROBE];

/** What each rule does to the three probes. Distinct for all five rules, which
 *  is what makes the classification below unambiguous.
 *
 *  NOTE (`b23`): `keep` is "verbatim" only for a value that is not path-shaped;
 *  every surviving string then goes through the SG4 scrub. The probes are
 *  deliberately path-free (`PROBE-xxxx…`, `text/plain`) so the five rules stay
 *  distinguishable and this derivation keeps measuring the ALLOWLIST rather
 *  than the scrub. The scrub gets its own pin in §6. */
const RULE_SIGNATURES: Record<Rule, readonly unknown[]> = {
  keep: [STRING_PROBE, RECORD_PROBE, ARRAY_PROBE],
  fingerprint: [fingerprintString(STRING_PROBE, SALT), ABSENT, ABSENT],
  summary: [`${STRING_PROBE.slice(0, SUMMARY_MAX_CHARS)}…`, ABSENT, ABSENT],
  question: [ABSENT, { text: QUESTION_PLACEHOLDER, question_id: "q-probe" }, ABSENT],
  message_parts: [ABSENT, ABSENT, [{ text: MESSAGE_PARTS_PLACEHOLDER, media_type: "text/plain" }]],
};

function probeSource(value: unknown): Record<string, unknown> {
  return new Proxy({} as Record<string, unknown>, {
    has: () => true,
    get: (_target, key) => (typeof key === "string" ? value : undefined),
  });
}

function classify(signature: readonly unknown[], label: string): Rule {
  const matches = PINNED_FIELD_RULES.filter((rule) =>
    Bun.deepEquals(signature, RULE_SIGNATURES[rule]),
  );
  if (matches.length !== 1 || matches[0] === undefined) {
    throw new Error(
      `${label}: probe results match ${matches.length} rules — the filter applied something that is not one of the five pinned rules. Got ${JSON.stringify(signature)}`,
    );
  }
  return matches[0];
}

/** Three filtered outputs (one per probe) → the allowlist that produced them. */
function deriveTable(passes: readonly Record<string, unknown>[], label: string): Record<string, Rule> {
  const fields = [...new Set(passes.flatMap((pass) => Object.keys(pass)))].sort();
  const out: Record<string, Rule> = {};
  for (const field of fields) {
    const signature = passes.map((pass) => (field in pass ? pass[field] : ABSENT));
    out[field] = classify(signature, `${label}.${field}`);
  }
  return out;
}

function deriveEnvelopeAllowlist(): Record<string, Rule> {
  const passes = PROBES.map((probe) => {
    const out = filterEventForTier(probeSource(probe), "metadata", { fingerprintSalt: SALT });
    // `data` is written unconditionally by filterEventForTier, not by the
    // envelope walk, so it is not an envelope allowlist entry. (An envelope
    // entry literally named `data` would be masked here — the structural pin
    // above is what covers that case.)
    delete out.data;
    return out;
  });
  return deriveTable(passes, "ENVELOPE_ALLOWLIST");
}

function deriveDataAllowlist(type: string): Record<string, Rule> {
  const passes = PROBES.map((probe) => {
    const out = filterEventForTier({ type, data: probeSource(probe) }, "metadata", {
      fingerprintSalt: SALT,
    });
    return (out.data ?? {}) as Record<string, unknown>;
  });
  return deriveTable(passes, `DATA_ALLOWLISTS['${type}']`);
}

function deriveStatsTable(
  wrap: (probed: Record<string, unknown>) => Record<string, unknown>,
  unwrap: (filtered: Record<string, unknown>) => Record<string, unknown>,
  label: string,
): Record<string, Rule> {
  const passes = PROBES.map((probe) =>
    unwrap(filterStatsRecordMetadata(wrap(probeSource(probe)), { fingerprintSalt: SALT })),
  );
  return deriveTable(passes, label);
}

describe("behavioural pin — the allowlists as the compiled filter applies them", () => {
  test("the live envelope allowlist matches the pinned envelope policy", () => {
    expect(deriveEnvelopeAllowlist()).toEqual(PINNED_ENVELOPE);
  });

  test("every pinned event type's live data allowlist matches, field for field", () => {
    for (const [type, pinned] of Object.entries(PINNED_DATA)) {
      // `stats.run_record` short-circuits into the nested stats filter before
      // the per-type table is consulted; it is covered below and by the
      // structural pin.
      if (type === "stats.run_record") continue;
      expect({ [type]: deriveDataAllowlist(type) }).toEqual({ [type]: pinned });
    }
  });

  test("the live stats allowlists match, field for field", () => {
    // `steps` / `tokens` / `failures` are recursed into explicitly by
    // filterStatsRecordMetadata rather than being STATS_RECORD_ALLOWLIST
    // entries, so they are stripped before the record-level derivation and
    // derived on their own below.
    const record = deriveStatsTable(
      (probed) => probed,
      (filtered) => {
        const { steps: _s, tokens: _t, failures: _f, ...rest } = filtered;
        return rest;
      },
      "STATS_RECORD_ALLOWLIST",
    );
    expect(record).toEqual(PINNED_STATS_RECORD);

    expect(
      deriveStatsTable(
        (probed) => ({ steps: [probed] }),
        (filtered) => (filtered.steps as Record<string, unknown>[])[0] ?? {},
        "STATS_STEP_ALLOWLIST",
      ),
    ).toEqual(PINNED_STATS_STEP);

    expect(
      deriveStatsTable(
        (probed) => ({ tokens: probed }),
        (filtered) => (filtered.tokens ?? {}) as Record<string, unknown>,
        "STATS_TOKENS_ALLOWLIST",
      ),
    ).toEqual(PINNED_STATS_TOKENS);

    expect(
      deriveStatsTable(
        (probed) => ({ failures: [probed] }),
        (filtered) => (filtered.failures as Record<string, unknown>[])[0] ?? {},
        "STATS_FAILURE_ALLOWLIST",
      ),
    ).toEqual(PINNED_STATS_FAILURE);
  });

  test("the derivation is sound: each rule's signature is unique", () => {
    for (const rule of PINNED_FIELD_RULES) {
      expect(classify(RULE_SIGNATURES[rule], rule)).toBe(rule);
    }
  });
});

// ── 3. The hostile fixture ───────────────────────────────────────────────────

const HOSTILE_ROOT = "/Users/ivan.murzak/clients/acme-bank/checkout-rewrite";
const HOSTILE_WORKTREE = "C:\\Users\\ivan.murzak\\work\\acme-bank\\wt-42";
const HOSTILE_ENV_FILE = "/Users/ivan.murzak/clients/acme-bank/.env.production";
const HOSTILE_HOOK_DIR = "/Users/ivan.murzak/clients/acme-bank/.git/hooks";
const HOSTILE_SENDER = "ivan.murzak@acme-bank.example";
const HOSTILE_PROMPT = "Rewrite ACME Bank's checkout flow; the staging key is sk-live-DEADBEEF00";
const HOSTILE_TOOL_ARGS = '{"command":"psql postgres://admin:hunter2@db.acme.internal/prod"}';
const HOSTILE_ERROR =
  "TypeError: cannot read 'total' of undefined at /Users/ivan.murzak/clients/acme-bank/src/checkout.ts:88";
const HOSTILE_TRANSCRIPT = "assistant: I will now read the customer PII table for Jane Roe.";

/** A `summary` field whose first 256 chars are benign and whose tail carries
 *  secrets — so the truncation itself is load-bearing, not incidental. */
const HALT_HEAD = "step 03-implement exhausted its retry budget after 3 attempts";
const HALT_TAIL = `; leaked-tail ${HOSTILE_ROOT} ${HOSTILE_PROMPT}`;
const HOSTILE_HALT_REASON = `${HALT_HEAD}${".".repeat(SUMMARY_MAX_CHARS - HALT_HEAD.length)}${HALT_TAIL}`;

/** Every planted secret that must NOT survive at the `metadata` tier. */
const FORBIDDEN = [
  HOSTILE_ROOT,
  HOSTILE_WORKTREE,
  HOSTILE_ENV_FILE,
  HOSTILE_HOOK_DIR,
  HOSTILE_SENDER,
  HOSTILE_PROMPT,
  HOSTILE_TOOL_ARGS,
  HOSTILE_ERROR,
  HOSTILE_TRANSCRIPT,
  "sk-live-DEADBEEF00",
  "hunter2",
  "Jane Roe",
  "ivan.murzak",
  "acme-bank",
];

function expectNoSecrets(filtered: unknown, note: string): void {
  const serialized = JSON.stringify(filtered);
  for (const secret of FORBIDDEN) {
    if (serialized.includes(secret)) {
      throw new Error(`${note}: '${secret.slice(0, 48)}' survived the metadata filter — ${serialized}`);
    }
  }
}

/** Hostile envelope extras a newer (or malicious) peer might attach. */
const HOSTILE_ENVELOPE_EXTRAS = {
  prompt: HOSTILE_PROMPT,
  transcript: HOSTILE_TRANSCRIPT,
  cwd: HOSTILE_ROOT,
  api_key: "sk-live-DEADBEEF00",
  user_email: HOSTILE_SENDER,
  env: { DATABASE_URL: "postgres://admin:hunter2@db.acme.internal/prod" },
};

/** A step path under the run's own root, and one under no root at all — the
 *  two shapes a `keep`-classified path field can carry (`b23`). */
const HOSTILE_STEP_IN_ROOT = `${HOSTILE_ROOT}/.pipeline/ship-feature/steps/03-implement.md`;
const HOSTILE_STEP_OFF_ROOT = "/Users/ivan.murzak/clients/other-bank/notes/hand-off.md";

describe("hostile fixture — prompts, absolute paths, tool arguments, error text", () => {
  // `iteration_path` / `next_iteration_path` are planted RELATIVE here and
  // asserted to survive, which is half the contract; the absolute half is the
  // test immediately below. Before `b23` only this half existed, and it read as
  // proof that the filter handled paths.
  test("a fully-stuffed iteration.completed is reduced to exactly the allowlist", () => {
    const event = {
      schema: 4,
      ts: "2026-08-04T10:00:00.000Z",
      type: "iteration.completed",
      run_id: "run-0199",
      parent_run_id: "run-0198",
      session_id: "sess-77",
      project_root: HOSTILE_ROOT,
      worktree: HOSTILE_WORKTREE,
      task_id: "task-12",
      context_id: "ctx-9",
      department_id: "dept-eng",
      engine: "claude",
      sender: HOSTILE_SENDER,
      ...HOSTILE_ENVELOPE_EXTRAS,
      data: {
        iteration_path: "steps/03-implement",
        outcome: "FAIL",
        next_iteration_path: "steps/04-review",
        has_improvement_brief: true,
        has_blocker_delegation: false,
        halt_reason: HOSTILE_HALT_REASON,
        terminal: true,
        step_name: "implement",
        step_id: "03-implement",
        step_type: "llm",
        failure_class: "assertion",
        // Hostile extras inside a KNOWN type — every one must be dropped.
        error: HOSTILE_ERROR,
        stderr: HOSTILE_ERROR,
        tool_input: HOSTILE_TOOL_ARGS,
        prompt: HOSTILE_PROMPT,
        transcript: HOSTILE_TRANSCRIPT,
        absolute_script_path: HOSTILE_ROOT,
      },
    };

    const filtered = filterEventForTier(event, "metadata", { fingerprintSalt: SALT });

    expect(filtered).toEqual({
      schema: 4,
      ts: "2026-08-04T10:00:00.000Z",
      type: "iteration.completed",
      run_id: "run-0199",
      parent_run_id: "run-0198",
      session_id: "sess-77",
      project_root: fingerprintString(HOSTILE_ROOT, SALT),
      worktree: fingerprintString(HOSTILE_WORKTREE, SALT),
      task_id: "task-12",
      context_id: "ctx-9",
      department_id: "dept-eng",
      engine: "claude",
      sender: fingerprintString(HOSTILE_SENDER, SALT),
      data: {
        iteration_path: "steps/03-implement",
        outcome: "FAIL",
        next_iteration_path: "steps/04-review",
        has_improvement_brief: true,
        has_blocker_delegation: false,
        halt_reason: `${HOSTILE_HALT_REASON.slice(0, SUMMARY_MAX_CHARS)}…`,
        terminal: true,
        step_name: "implement",
        step_id: "03-implement",
        step_type: "llm",
        failure_class: "assertion",
      },
    });
    expectNoSecrets(filtered, "iteration.completed");
  });

  test("…and the SAME event with ABSOLUTE step paths ships neither of them (`b23`)", () => {
    // The other half of the contract, and the disposition this file never
    // exercised: `keep` copies its value, so before `b23` these two fields
    // shipped `/Users/ivan.murzak/…` verbatim while `project_root` beside them
    // was fingerprinted — same payload, same filter, two dispositions.
    const filtered = filterEventForTier(
      {
        type: "iteration.completed",
        project_root: HOSTILE_ROOT,
        worktree: null,
        data: {
          iteration_path: HOSTILE_STEP_IN_ROOT,
          next_iteration_path: HOSTILE_STEP_OFF_ROOT,
          outcome: "FAIL",
          step_name: "implement",
        },
      },
      "metadata",
      { fingerprintSalt: SALT },
    );
    expect(filtered).toEqual({
      type: "iteration.completed",
      project_root: fingerprintString(HOSTILE_ROOT, SALT),
      worktree: null,
      data: {
        // Under the run's own root: relativized, so the step is STILL NAMED —
        // the fix is not "ship nothing".
        iteration_path: ".pipeline/ship-feature/steps/03-implement.md",
        // Under no known root: fails closed to the same fingerprint shape.
        next_iteration_path: expect.stringMatching(/^fp:[0-9a-f]{16}$/) as unknown as string,
        outcome: "FAIL",
        step_name: "implement",
      },
    });
    expectNoSecrets(filtered, "iteration.completed (absolute)");
  });

  test("the `summary` rule truncates the secret-bearing tail away", () => {
    expect(HALT_HEAD.length).toBeLessThan(SUMMARY_MAX_CHARS);
    expect(HOSTILE_HALT_REASON).toContain(HOSTILE_PROMPT);
    const filtered = filterEventForTier(
      { type: "run.halted", data: { halt_reason: HOSTILE_HALT_REASON } },
      "metadata",
    );
    expect(String((filtered.data as Record<string, unknown>).halt_reason)).toHaveLength(
      SUMMARY_MAX_CHARS + 1,
    );
    expectNoSecrets(filtered, "run.halted");
  });

  test("awaiting_input ships a schema-valid placeholder, never the question text", () => {
    const filtered = filterEventForTier(
      {
        type: "awaiting_input",
        run_id: "run-0199",
        data: {
          run_id: "run-0199",
          iteration: 3,
          question_id: "q-7",
          question: {
            question_id: "q-7",
            text: HOSTILE_PROMPT,
            context: HOSTILE_TRANSCRIPT,
            options: [HOSTILE_TOOL_ARGS, HOSTILE_ERROR],
          },
        },
      },
      "metadata",
    );
    expect(filtered.data).toEqual({
      run_id: "run-0199",
      iteration: 3,
      question_id: "q-7",
      question: { text: QUESTION_PLACEHOLDER, question_id: "q-7" },
    });
    expectNoSecrets(filtered, "awaiting_input");
  });

  test("department.message ships one placeholder part, never authored content", () => {
    const filtered = filterEventForTier(
      {
        type: "department.message",
        data: {
          parts: [
            { text: HOSTILE_PROMPT },
            { text: HOSTILE_TRANSCRIPT, media_type: "text/markdown" },
            { path: HOSTILE_ROOT },
          ],
        },
      },
      "metadata",
    );
    expect(filtered.data).toEqual({
      parts: [{ text: MESSAGE_PARTS_PLACEHOLDER, media_type: "text/plain" }],
    });
    expectNoSecrets(filtered, "department.message");
  });

  test("department.artifact keeps name + media_type and drops path/bytes", () => {
    const filtered = filterEventForTier(
      {
        type: "department.artifact",
        data: {
          name: "report.md",
          media_type: "text/markdown",
          path: HOSTILE_ROOT,
          bytes_base64: Buffer.from(HOSTILE_TRANSCRIPT).toString("base64"),
        },
      },
      "metadata",
    );
    expect(filtered.data).toEqual({ name: "report.md", media_type: "text/markdown" });
    expectNoSecrets(filtered, "department.artifact");
  });

  test("worktree.created fingerprints its paths and drops free-text `detail`", () => {
    const filtered = filterEventForTier(
      {
        type: "worktree.created",
        data: {
          worktree_path: HOSTILE_WORKTREE,
          branch: "feat/checkout",
          env_file: HOSTILE_ENV_FILE,
          port_base: 4200,
          ok: false,
          hook_dir: HOSTILE_HOOK_DIR,
          detail: HOSTILE_ERROR,
        },
      },
      "metadata",
    );
    expect(filtered.data).toEqual({
      worktree_path: fingerprintString(HOSTILE_WORKTREE, ""),
      branch: "feat/checkout",
      env_file: fingerprintString(HOSTILE_ENV_FILE, ""),
      port_base: 4200,
      ok: false,
      hook_dir: fingerprintString(HOSTILE_HOOK_DIR, ""),
    });
    expectNoSecrets(filtered, "worktree.created");
  });

  test("tool.called keeps the tool NAME and drops its arguments and result", () => {
    const filtered = filterEventForTier(
      {
        type: "tool.called",
        data: {
          tool_name: "Bash",
          success: false,
          agent_spawn: false,
          tool_use_id: "toolu_01",
          tool_input: HOSTILE_TOOL_ARGS,
          input: HOSTILE_TOOL_ARGS,
          result: HOSTILE_ERROR,
          error: HOSTILE_ERROR,
        },
      },
      "metadata",
    );
    expect(filtered.data).toEqual({
      tool_name: "Bash",
      success: false,
      agent_spawn: false,
      tool_use_id: "toolu_01",
    });
    expectNoSecrets(filtered, "tool.called");
  });

  // `steps[].id` and `failures[].step` are planted RELATIVE here. Both are
  // `keep`-classified and NEITHER is `*_path`-named, which is why the absolute
  // case (below) is the one a field-name patch would have missed entirely.
  test("the stats record drops failure `error` excerpts and unknown fields", () => {
    const filtered = filterEventForTier(
      {
        type: "stats.run_record",
        project_root: HOSTILE_ROOT,
        data: {
          schema: 1,
          run_id: "run-0199",
          pipeline: "ship-feature",
          outcome: "FAIL",
          halt_reason: "assertion failed",
          revision: 3,
          origin: "local",
          prompt: HOSTILE_PROMPT,
          steps: [
            { id: "03-implement", seconds: 41, outcome: "FAIL", prompt: HOSTILE_PROMPT },
            "not-an-object",
          ],
          tokens: { input: 100, output: 20, failed_tools: { Bash: 2 }, transcript: HOSTILE_TRANSCRIPT },
          failures: [
            { ts: "2026-08-04T10:00:00.000Z", tool: "Bash", step: "03-implement", error: HOSTILE_ERROR },
            "not-an-object",
          ],
        },
      },
      "metadata",
      { fingerprintSalt: SALT },
    );
    expect(filtered).toEqual({
      type: "stats.run_record",
      project_root: fingerprintString(HOSTILE_ROOT, SALT),
      data: {
        schema: 1,
        run_id: "run-0199",
        pipeline: "ship-feature",
        outcome: "FAIL",
        halt_reason: "assertion failed",
        revision: 3,
        origin: "local",
        steps: [{ id: "03-implement", seconds: 41, outcome: "FAIL" }, {}],
        tokens: { input: 100, output: 20, failed_tools: { Bash: 2 } },
        failures: [{ ts: "2026-08-04T10:00:00.000Z", tool: "Bash", step: "03-implement" }],
      },
    });
    expectNoSecrets(filtered, "stats.run_record");
  });

  test("…and an ABSOLUTE `failures[].step` / `steps[].id` never ships (`b23`)", () => {
    const filtered = filterEventForTier(
      {
        type: "stats.run_record",
        project_root: HOSTILE_ROOT,
        data: {
          run_id: "run-0199",
          pipeline: "ship-feature",
          outcome: "FAIL",
          steps: [{ id: HOSTILE_STEP_IN_ROOT, seconds: 41, outcome: "FAIL" }],
          failures: [
            { ts: "2026-08-04T10:00:00.000Z", tool: "Bash", step: HOSTILE_STEP_IN_ROOT },
            { ts: "2026-08-04T10:01:00.000Z", tool: "Read", step: HOSTILE_STEP_OFF_ROOT },
          ],
        },
      },
      "metadata",
      { fingerprintSalt: SALT },
    );
    const data = filtered.data as Record<string, unknown>;
    expect((data.steps as Record<string, unknown>[])[0]?.id).toBe(
      ".pipeline/ship-feature/steps/03-implement.md",
    );
    expect((data.failures as Record<string, unknown>[])[0]?.step).toBe(
      ".pipeline/ship-feature/steps/03-implement.md",
    );
    expect((data.failures as Record<string, unknown>[])[1]?.step).toMatch(/^fp:[0-9a-f]{16}$/);
    expectNoSecrets(filtered, "stats.run_record (absolute step)");
  });

  test("a bare stats record relativizes against the root its CALLER supplies (`b23`)", () => {
    // A `RunRecord` carries no root field of its own, so a caller that filters
    // one directly — rather than wrapped in an envelope — has to say what the
    // root is. Without one the path fails closed rather than shipping.
    const record = {
      run_id: "run-0199",
      failures: [{ ts: "2026-08-04T10:00:00.000Z", tool: "Bash", step: HOSTILE_STEP_IN_ROOT }],
    };
    expect(
      (
        filterStatsRecordMetadata(record, { fingerprintSalt: SALT, pathRoots: [HOSTILE_ROOT] })
          .failures as Record<string, unknown>[]
      )[0]?.step,
    ).toBe(".pipeline/ship-feature/steps/03-implement.md");
    expect(
      (filterStatsRecordMetadata(record, { fingerprintSalt: SALT }).failures as Record<string, unknown>[])[0]
        ?.step,
    ).toMatch(/^fp:[0-9a-f]{16}$/);
    expectNoSecrets(filterStatsRecordMetadata(record, { fingerprintSalt: SALT }), "bare stats record");
  });

  test("stripStatsFailureExcerpts removes `error` at EVERY tier, before the tier filter", () => {
    const stripped = stripStatsFailureExcerpts({
      run_id: "run-0199",
      failures: [
        { ts: "t", tool: "Bash", step: "03", error: HOSTILE_ERROR },
        "not-an-object",
        { ts: "t2", tool: "Read", step: "04" },
      ],
    });
    expect(stripped).toEqual({
      run_id: "run-0199",
      failures: [
        { ts: "t", tool: "Bash", step: "03" },
        { ts: "t2", tool: "Read", step: "04" },
      ],
    });
    expect(JSON.stringify(stripped)).not.toContain(HOSTILE_ERROR);
  });
});

// ── 4. The two default-deny rules ────────────────────────────────────────────

describe("default-deny", () => {
  test("an unknown event type ships `data: {}`", () => {
    for (const type of ["exfil.everything", "iteration.completed.v2", "", "__proto__"]) {
      const filtered = filterEventForTier(
        {
          type,
          run_id: "run-0199",
          project_root: HOSTILE_ROOT,
          data: { prompt: HOSTILE_PROMPT, error: HOSTILE_ERROR, tool_input: HOSTILE_TOOL_ARGS },
        },
        "metadata",
        { fingerprintSalt: SALT },
      );
      expect(filtered.data).toEqual({});
      expectNoSecrets(filtered, `unknown type '${type}'`);
    }
  });

  test("an unknown FIELD inside a known type is dropped", () => {
    const filtered = filterEventForTier(
      {
        type: "pipeline.started",
        data: {
          pipeline_name: "ship-feature",
          first_iteration_path: "steps/01-frame",
          pipeline_root: HOSTILE_ROOT,
          default_model: "opus",
          // Not in the allowlist — every one of these must vanish.
          prompt: HOSTILE_PROMPT,
          author: HOSTILE_SENDER,
          repo_path: HOSTILE_ROOT,
          brand_new_field_a_future_peer_added: HOSTILE_TRANSCRIPT,
        },
      },
      "metadata",
      { fingerprintSalt: SALT },
    );
    expect(filtered.data).toEqual({
      pipeline_name: "ship-feature",
      first_iteration_path: "steps/01-frame",
      pipeline_root: fingerprintString(HOSTILE_ROOT, SALT),
      default_model: "opus",
    });
    expectNoSecrets(filtered, "pipeline.started");
  });

  test("a non-object `data` cannot smuggle anything through", () => {
    for (const data of [HOSTILE_PROMPT, 42, null, [HOSTILE_PROMPT], undefined]) {
      const filtered = filterEventForTier({ type: "iteration.completed", data }, "metadata");
      expect(filtered.data).toEqual({});
    }
  });
});

// ── 5. Tiers ─────────────────────────────────────────────────────────────────

describe("tiers", () => {
  test("`events` and `full` pass the event through verbatim", () => {
    const event = { type: "iteration.completed", project_root: HOSTILE_ROOT, data: { prompt: HOSTILE_PROMPT } };
    expect(filterEventForTier(event, "events")).toBe(event);
    expect(filterEventForTier(event, "full")).toBe(event);
  });

  test("tier resolution fails CLOSED to the most private tier", () => {
    expect(PRIVACY_TIERS).toEqual(["metadata", "events", "full"]);
    expect(DEFAULT_PRIVACY_TIER).toBe("metadata");
    expect(PRIVACY_TIER_ENV).toBe("PIPELINE_PRIVACY_TIER");
    expect(PRIVACY_SALT_ENV).toBe("PIPELINE_PRIVACY_SALT");

    expect(resolvePrivacyTier(undefined, {})).toEqual({ tier: "metadata", warning: null });
    expect(resolvePrivacyTier("", {})).toEqual({ tier: "metadata", warning: null });
    expect(resolvePrivacyTier("full", {})).toEqual({ tier: "full", warning: null });
    expect(resolvePrivacyTier(undefined, { [PRIVACY_TIER_ENV]: "events" })).toEqual({
      tier: "events",
      warning: null,
    });
    // config wins over env
    expect(resolvePrivacyTier("metadata", { [PRIVACY_TIER_ENV]: "full" }).tier).toBe("metadata");
    // anything unrecognized degrades DOWN, never up
    for (const bogus of ["FULL", "everything", "full ", "events;full", "0"]) {
      const resolved = resolvePrivacyTier(bogus, {});
      expect(resolved.tier).toBe("metadata");
      expect(resolved.warning).toContain("failing closed");
    }
    expect(resolvePrivacyTier(undefined, { [PRIVACY_TIER_ENV]: "bogus" }).tier).toBe("metadata");
  });

  test("fingerprints are deterministic, salted, and shaped `fp:<16 hex>`", () => {
    expect(fingerprintString(HOSTILE_ROOT)).toMatch(/^fp:[0-9a-f]{16}$/);
    expect(fingerprintString(HOSTILE_ROOT)).toBe(fingerprintString(HOSTILE_ROOT));
    expect(fingerprintString(HOSTILE_ROOT, SALT)).not.toBe(fingerprintString(HOSTILE_ROOT));
    expect(fingerprintString(HOSTILE_ROOT)).not.toContain("ivan.murzak");
    // null passes through; a non-string, non-null value is dropped entirely
    const filtered = filterEventForTier(
      { type: "worktree.created", data: { worktree_path: null, env_file: 42, ok: true } },
      "metadata",
    );
    expect(filtered.data).toEqual({ worktree_path: null, ok: true });
  });
});

// ── 6. The SG4 value rule (ux-v2 `b23`) ──────────────────────────────────────
//
// The pin the allowlist tables cannot express. §§1–2 pin WHICH FIELDS survive;
// this one pins what a surviving VALUE may contain. It exists because §§1–3
// were all green while `iteration_path` shipped `C:\Users\<account>\…` to
// production for three weeks: `keep` meant verbatim, and no table can say
// otherwise.
//
// The arbiter is not invented here. `SG4_PATH_RE` is transcribed verbatim from
// `scripts/i1-production-e2e/check-sg4.mjs` in the parent monorepo — the check
// that read the defect out of the production `events` table — so "this filter
// is conformant" and "the production check is clean" are one statement.

/** Every `keep`-classified field in `PINNED_DATA` whose value is a PATH,
 *  derived from the pinned table itself rather than listed by hand: a path
 *  field added to the policy tomorrow joins this sweep automatically. */
const PINNED_KEEP_PATH_FIELDS: Array<[string, string]> = Object.entries(PINNED_DATA).flatMap(
  ([type, fields]) =>
    Object.entries(fields)
      .filter(([field, rule]) => rule === "keep" && field.endsWith("_path"))
      .map(([field]) => [type, field] as [string, string]),
);

/** Every string leaf of a payload with its dotted location — `check-sg4.mjs`'s
 *  own `scanStrings` walk. */
function stringLeaves(node: unknown, at = "payload"): Array<[string, string]> {
  if (typeof node === "string") return [[at, node]];
  if (Array.isArray(node)) return node.flatMap((v, i) => stringLeaves(v, `${at}[${i}]`));
  if (node && typeof node === "object") {
    return Object.entries(node).flatMap(([k, v]) => stringLeaves(v, `${at}.${k}`));
  }
  return [];
}

function sg4Findings(payload: unknown): string[] {
  return stringLeaves(payload)
    .filter(([, v]) => SG4_PATH_RE.test(v))
    .map(([at, v]) => `${at} -> ${JSON.stringify(v.slice(0, 140))}`);
}

describe("SG4 — the shape of the value, not the name of the field", () => {
  test("EVERY `keep`-classified `*_path` field in the pinned policy is scrubbed", () => {
    // Not "the two fields i1 observed". If this sweep is empty the pinned table
    // itself has stopped naming any path field, which is its own failure.
    expect(PINNED_KEEP_PATH_FIELDS.length).toBeGreaterThan(10);
    for (const [type, field] of PINNED_KEEP_PATH_FIELDS) {
      const filtered = filterEventForTier(
        { type, project_root: HOSTILE_ROOT, data: { [field]: HOSTILE_STEP_IN_ROOT } },
        "metadata",
        { fingerprintSalt: SALT },
      );
      const findings = sg4Findings(filtered);
      expect(`${type}.${field}: ${findings.join(" | ") || "clean"}`).toBe(`${type}.${field}: clean`);
      // …and not by DELETING the field: the step is still named, relative to
      // the run's own root.
      expect(`${type}.${field} = ${String((filtered.data as Record<string, unknown>)[field])}`).toBe(
        `${type}.${field} = .pipeline/ship-feature/steps/03-implement.md`,
      );
    }
  });

  test("a path embedded in a `summary` field's free text is rewritten, prose intact", () => {
    // No field-NAME rule can reach this one: `halt_reason` is free text.
    const filtered = filterEventForTier(
      {
        type: "run.halted",
        project_root: HOSTILE_ROOT,
        data: { halt_reason: `cannot open ${HOSTILE_STEP_IN_ROOT} (ENOENT)` },
      },
      "metadata",
      { fingerprintSalt: SALT },
    );
    expect((filtered.data as Record<string, unknown>).halt_reason).toBe(
      "cannot open .pipeline/ship-feature/steps/03-implement.md (ENOENT)",
    );
    expect(sg4Findings(filtered)).toEqual([]);
  });

  test("all three absolute shapes relativize; a relative value and a URL are untouched", () => {
    const roots = {
      posix: "/home/ivand/work/proj",
      windows: "C:\\Users\\IvanD\\work\\proj",
      unc: "\\\\fileserver\\team\\ivand\\proj",
    };
    for (const root of Object.values(roots)) {
      const sep = root.includes("/") ? "/" : "\\";
      expect(looksAbsolutePath(root)).toBe(true);
      expect(
        scrubPathString(`${root}${sep}steps${sep}01.md`, { roots: [root], fingerprintSalt: SALT }),
      ).toBe("steps/01.md");
    }
    expect(looksAbsolutePath("steps/01.md")).toBe(false);
    expect(scrubPathString("steps/01.md", { fingerprintSalt: SALT })).toBe("steps/01.md");
    // A URL is not a path — `blocker_issue_url` is `keep` and must not be
    // mangled. (`https://` contains `s:/`, which is why the arbiter carries a
    // leading-boundary guard.)
    const url = "https://github.com/IvanMurzak/pipeline/issues/1";
    expect(looksAbsolutePath(url)).toBe(false);
    expect(scrubPathString(url, { fingerprintSalt: SALT })).toBe(url);
    expect(
      (
        filterEventForTier(
          { type: "blocker.polling", data: { blocker_issue_url: url, pr_state: "open" } },
          "metadata",
        ).data as Record<string, unknown>
      ).blocker_issue_url,
    ).toBe(url);
  });

  test("a relativized remainder that would still name the OS account is refused", () => {
    // Root is the home directory itself, so the remainder would be
    // `ivand/proj/steps/01.md` — root-free, but still naming the account.
    expect(
      scrubPathString("/Users/ivand/proj/steps/01.md", {
        roots: ["/Users"],
        accountNames: ["ivand"],
        fingerprintSalt: SALT,
      }),
    ).toMatch(/^fp:[0-9a-f]{16}$/);
    expect(defaultAccountNames({ USERNAME: "ivand", USER: undefined, LOGNAME: undefined })).toEqual([
      "ivand",
    ]);
    // A one-character name is dropped: it would match half the world's path
    // segments, and the absolute-path rule already covers the disclosure.
    expect(defaultAccountNames({ USER: "x" }, null)).toEqual([]);
    // A bare token that merely EQUALS the account name, with no path around it,
    // is NOT a layout disclosure and is left alone — redacting it would corrupt
    // step identity for every consumer downstream.
    expect(scrubPathString("ivand", { accountNames: ["ivand"], fingerprintSalt: SALT })).toBe("ivand");
  });

  test("the roots come from the UNFILTERED event, and the most specific one wins", () => {
    const worktree = `${HOSTILE_ROOT}/.worktrees/run-1`;
    expect(collectPathRoots({ project_root: HOSTILE_ROOT, worktree })).toEqual([worktree, HOSTILE_ROOT]);
    // After the allowlist, `project_root` is `fp:…` and names nothing — which
    // is why the filter collects roots BEFORE it runs.
    expect(collectPathRoots({ project_root: fingerprintString(HOSTILE_ROOT, SALT) })).toEqual([]);
    const filtered = filterEventForTier(
      {
        type: "iteration.started",
        project_root: HOSTILE_ROOT,
        worktree,
        data: { iteration_path: `${worktree}/steps/01.md` },
      },
      "metadata",
      { fingerprintSalt: SALT },
    );
    expect((filtered.data as Record<string, unknown>).iteration_path).toBe("steps/01.md");
  });

  test("the scrub is idempotent — a second pass over a filtered payload is a no-op", () => {
    const once = filterEventForTier(
      {
        type: "iteration.completed",
        project_root: HOSTILE_ROOT,
        data: { iteration_path: HOSTILE_STEP_IN_ROOT, next_iteration_path: HOSTILE_STEP_OFF_ROOT },
      },
      "metadata",
      { fingerprintSalt: SALT },
    );
    const twice = filterEventForTier(once, "metadata", {
      fingerprintSalt: SALT,
      pathRoots: [HOSTILE_ROOT],
    });
    expect(twice.data).toEqual(once.data);
  });

  test("`events` and `full` are unaffected — at those tiers the TIER is the control", () => {
    const event = {
      type: "iteration.started",
      project_root: HOSTILE_ROOT,
      data: { iteration_path: HOSTILE_STEP_IN_ROOT },
    };
    expect(filterEventForTier(event, "events")).toBe(event);
    expect(filterEventForTier(event, "full")).toBe(event);
  });

  test("the arbiter itself is not vacuous — it flags every shape it is meant to", () => {
    for (const bad of [
      "C:\\Users\\IvanD\\x.md",
      "C:/Users/IvanD/x.md",
      "/Users/ivan.murzak/x.md",
      "/home/ivand/x.md",
      "\\\\fileserver\\team\\x.md",
      "cannot open C:\\Users\\IvanD\\x.md (ENOENT)",
    ]) {
      expect(`${bad}: ${SG4_PATH_RE.test(bad)}`).toBe(`${bad}: true`);
    }
    for (const ok of [
      "steps/01.md",
      "fp:0123456789abcdef",
      "https://github.com/IvanMurzak/pipeline/issues/1",
      "workflows/release",
    ]) {
      expect(`${ok}: ${SG4_PATH_RE.test(ok)}`).toBe(`${ok}: false`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE STEP-IDENTITY RULE (ux-v2 `b24`)
// ─────────────────────────────────────────────────────────────────────────────
//
// The pinned tables above are the structural half of this: every step-shaped
// allowlist now pins `step_uuid: "keep"`, so removing it from privacy.ts is a
// loud pin failure rather than a silent strip. The pins are also how the
// omission survived — they were written FROM the allowlists, so they recorded
// whatever the allowlists happened to contain, and the allowlists contained no
// step identity at all. `grep -c step_uuid` over the shipped filter returned 0,
// the server derived a row identity per reporting path over two different keys,
// and production held four `step_executions` rows for two steps.
//
// The behavioural half is below: the RULE, checked against the live tables so a
// future step-shaped allowlist cannot land without identity even if someone
// updates the pins to match it.

describe("the step-identity rule (b24)", () => {
  test("THE SWEEP: no step-shaped allowlist is missing step identity", () => {
    expect(stepShapedAllowlistViolations()).toEqual([]);
  });

  test.each([...STEP_SCOPED_EVENT_TYPES])(
    "%s carries step_uuid through the metadata tier",
    (type) => {
      const uuid = "019fded9-3a7c-7c31-9f0e-2b5a1d4e8c60";
      const filtered = filterEventForTier(
        { schema: 5, ts: "2026-08-08T10:00:00.000Z", type, run_id: "r1", data: { step_uuid: uuid } },
        "metadata",
      ) as { data: Record<string, unknown> };
      expect(filtered.data[STEP_IDENTITY_FIELD]).toBe(uuid);
    },
  );

  test("D15: both reporters ship the SAME uuid, so the cloud sees ONE row", () => {
    const uuid = "019fded9-3a7c-7c31-9f0e-2b5a1d4e8c60";
    const fromEvent = (
      filterEventForTier(
        {
          schema: 5,
          ts: "2026-08-08T10:00:00.000Z",
          type: "iteration.completed",
          run_id: "r1",
          data: { iteration_path: "steps/01.md", outcome: "completed", step_uuid: uuid },
        },
        "metadata",
      ) as { data: Record<string, unknown> }
    ).data[STEP_IDENTITY_FIELD];
    const fromStats = (
      filterStatsRecordMetadata({
        run_id: "r1",
        steps: [{ id: "01-prepare", outcome: "pass", step_uuid: uuid }],
      }).steps as Array<Record<string, unknown>>
    )[0]?.[STEP_IDENTITY_FIELD];
    expect(fromEvent).toBe(uuid);
    expect(fromStats).toBe(uuid);
    expect(fromEvent).toBe(fromStats);
  });

  test("a step uuid is not path-shaped, so the SG4 scrub leaves it alone", () => {
    const uuid = "019fded9-3a7c-7c31-9f0e-2b5a1d4e8c60";
    expect(looksAbsolutePath(uuid)).toBe(false);
    expect(SG4_PATH_RE.test(uuid)).toBe(false);
    expect(scrubPathString(uuid)).toBe(uuid);
  });
});
