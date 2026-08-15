# Wire-protocol additive-only policy

`@baizor/pipeline-protocol` is the load-bearing contract between the closed-source
control-plane **api** and the open-source runner **agent**. It is versioned
**additive-only within a major** — the same policy ARCHITECTURE.md pins for the
wire-protocol surface:

> **Wire protocol** (`protocol` package: events, envelopes, agent messages) —
> *Additive-only within a major; runner and control plane negotiate version on
> connect.*
> — ARCHITECTURE.md §"Format versioning & migrations"

This is the wire protocol, which versions **independently** of the pipeline
**file format** (that surface gets the full `format: N` up/down migration ladder;
this one does not). A CLI update never breaks cloud communication over format
concerns, and vice versa.

## The rule

Within a major (`PROTOCOL_VERSION`, currently **1**):

1. **Only additive changes.** New OPTIONAL fields and new EVENT TYPES only.
   Never remove a field, never tighten a field's type, never make an optional
   field required, never repurpose a field's meaning.
2. **Old consumers ignore what they don't know.** A new optional field or a new
   event type is invisible to an older peer — it keeps working. New consumers
   gain the signal. (In this package, unknown future fields pass through
   `.passthrough()` and are preserved on relay; an unknown event `type` still
   validates as a well-formed envelope via `AnyEventEnvelope`, mirroring the OSS
   daemon's "unknown event types are tolerated" behavior.)
3. **Every new nested object schema must also be `.passthrough()`.** The
   top-level wire envelope (`wireVariant`, `./src/wire/envelope.ts`) is
   `.passthrough()`, but zod does NOT propagate that leniency into a nested
   `z.object(...)` field — a strict nested schema would silently STRIP an
   unknown field a newer peer adds to it, defeating additive-forward
   compatibility one level down. So every new nested object schema added to
   this package (e.g. `PipelineRefSchema`, `LeaseTaskSchema`,
   `ExecutionOverridesSchema`) MUST end in `.passthrough()`, exactly like the
   envelope itself. A schema that is inherently open by construction (e.g. a
   `z.record(...)` map, or a scalar field) has nothing to add here. Reviewers:
   treat a bare `z.object({...})` (no `.passthrough()`) as a review blocker on
   any new nested wire schema.
4. **Negotiate on connect.** Peers exchange `PROTOCOL_VERSION` when they connect;
   `isCompatible(remoteMajor)` encodes the policy (same major ⇒ compatible).
   Full negotiation (capability flags, min-common-minor, graceful degradation)
   is T1-02.
5. **Value spaces may widen additively.** A field whose value space the emitter
   documents as open (e.g. the model alias / canonical-id space, the reasoning
   effort space) may gain new accepted values without a major bump — so those
   fields are validated leniently (`string | null`) rather than as closed enums,
   to never reject a valid-but-newer value.

### Two version numbers

| Constant | Meaning | Value |
|---|---|---|
| `PROTOCOL_VERSION` | Negotiated wire-protocol **major** for this package. Additive within it. | `1` |
| `EVENT_SCHEMA_VERSION` | Integer stamped in each event envelope's `schema` field. | `4` |

The event envelope's `schema` integer stays **4**: the v5 delta is purely
additive, and — exactly as the OSS `EVENTS.md` kept `schema: 4` across every
additive addition (`step_id`, `manager.stopped`, `worktree.*`, script-step
fields, …) — additive changes do **not** bump the on-wire `schema` integer. The
parser still accepts `schema` 1–4 (and a future explicit bump) so older journals
parse unchanged.

## What v5 added over v4 (all additive)

Codified from the Phase-0 spike (`docs/spike-report.md` §4, gaps G1–G10):

- **Ingest contract** — shipper-assigned `(run_id, seq)` idempotency; one shipper
  per journal (G1). See `src/ingest/`.
- **Run-lifecycle events** `run.started` / `run.completed` / `run.halted`,
  emitted by any orchestrator (`drive` included); `run.completed`/`halted` double
  as the end-of-run signal (G4/G6).
- **`awaiting_input`** journalled needs-input event (G7).
- **`question_id`** on questions, echoed by the answer (G3).
- **`resumed`** marker + an `emission` counter on iteration events, with `index`
  frozen as **stable step identity** (G5).
- **Structured answer message** `{run_id, question_id, answer, answered_by, ts}`
  (G8), audit-log-ready.
- **`run_id` presence rule** for shippable events (G2): shippable events carry a
  non-null `run_id`; session-scoped events (`run_id: null`) are a separate bucket,
  never shipped per-run.

Every one of these is a new event type or a new optional field — old consumers
ignore them, new consumers gain the signal.

## What 0.3.0 added over 0.2.0 (all additive)

Codified from the crash-resilience/integrity design (`fix-fundamental-issues`
tasks c2/d1/e3, design doc 07.1):

- **`heartbeat.runs_authoritative?: boolean`** (`src/wire/client.ts`) — capability
  flag: `active_run_ids` is treated as an exhaustive, per-run-actionable list
  ONLY when this flag is present and `true`. Capability-keyed rather than
  presence-keyed, because shipped 0.2.x runners already emit
  `active_run_ids: []` unconditionally — keying on the array's mere presence
  would have misclassified every legacy heartbeat.
- **`lease.attempt?: number`**, **`lease.max_attempts?: number`**,
  **`lease.resume_hint?: boolean`**, **`lease.event_seq_base?: number`**
  (`src/wire/server.ts`) — the cloud's per-run attempt/resume bookkeeping
  riding the offer itself, so a re-enqueued job after a crash/interrupt is
  self-describing (`resume_hint` drives workspace adoption; `event_seq_base`
  fences per-attempt event sequence numbers so a stale straggler from a
  superseded attempt can never collide with a current-attempt event).

Every one of these is a new optional scalar field on an existing, already
`.passthrough()` message — old consumers (runner or control plane) ignore them
exactly as rule 2 above describes; new consumers gain the signal.

## What 0.4.0 added over 0.3.0 (all additive)

Codified from the department-mesh design (task `b1-protocol-mesh-schemas`,
design doc `08-protocol-delta.md`):

- **`src/department/`** — a whole new, ADDITIVE `department.*` message vocabulary:
  12 new wire frames across 6 modules (`task.ts`, `offer.ts`, `lease.ts`,
  `events.ts`, `artifact.ts`, `control.ts`), every one built with
  `wireVariant()` and appended to `CLIENT_MESSAGE_VARIANTS` /
  `SERVER_MESSAGE_VARIANTS` (`src/wire/index.ts`) rather than living in a
  parallel union — `ClientMessage` / `ServerMessage` stay the ONE
  discriminated union each side parses against. Old runners and an old
  cloud simply never emit/expect these types; a same-major peer that
  doesn't recognize a `department.*` type ignores it (§"Compatibility
  posture" in 08).
- **`register.departments?: string[]`**, **`register.mesh_protocol?:
  number`** (`src/wire/handshake.ts`) — a runner optionally advertises its
  installed department slugs and the mesh protocol capability it speaks.
  Both optional; an old runner registers byte-identically. Mesh support is
  a CAPABILITY, not a version gate — `isRegisterCompatible` is deliberately
  untouched.
- **`register_ack.mesh_enabled?: boolean`** (`src/wire/handshake.ts`) — the
  cloud optionally tells a mesh-capable runner whether to expect
  `department.offer`s. Absent ⇒ today's behavior (no mesh signal).

Every one of these is either a brand-new message `type` (old consumers
ignore an unknown type) or a new optional scalar/array field on an already
`.passthrough()` message (old consumers ignore it) — exactly rule 2 above.
Every new NESTED object schema in `src/department/` (`DeptPartSchema`,
`DeptMessageSchema`, `DeptLimitsSchema`, `DeptCapabilitiesSchema`, and each
`DeptRuntimeEventSchema` union member) ends in `.passthrough()` per rule 3,
asserted by test (`src/department/department.test.ts`), not by eye.

## What 0.5.0 added over 0.4.0 (all additive)

Codified from the ux-v2 telemetry design (tasks `e1`, `e2`, `e3`; design docs
`04-subsystem-rules.md`, `05-infrastructure.md`, `07-security.md`). This release
carries **no wire-schema change at all** to any existing message: two brand-new
modules plus one previously-untyped optional field given a shape.

- **`src/privacy/`** (`e1`) — the privacy-tier filter, lifted **verbatim,
  byte-for-byte** from the runner's `pipeline-runner/src/shipper/privacy.ts`
  (430 lines, `sha256 e3d53e9b…`) so a plain byte comparison against the other
  copies stays meaningful. It is a positive ALLOWLIST, not redaction: a field
  absent from the table is dropped, and an event `type` absent from the table
  ships `data: {}`. New exports only — no existing export changes shape, and no
  new dependency (`node:crypto` only). The runner keeps its own copy this
  release and the CLI keeps its vendored copy until plugin-thin phase 6;
  divergence is guarded by the parent monorepo's
  `scripts/check-privacy-filter-drift.mjs` (ux-v2 `a1`, gate SG2), which is the
  one checkout holding every copy at once.
  `src/privacy/privacy.test.ts` is the allowlist conformance test (gate SG1) —
  it pins the policy structurally (allowlists read out of `privacy.ts`'s own
  syntax tree), behaviourally (the same tables re-derived from the compiled
  filter through a `Proxy` `has` trap), and against a hostile fixture. It runs
  in this package's CI **and in the release workflow before `npm publish`**, so
  no tarball can ship a filter that fails it.
- **`src/ids/`** (`e2`) — the shared id mint point: `newId()` /
  `createIdGenerator()`, the RFC 9562 §6.2 Method-1 UUIDv7 generator promoted
  verbatim in behaviour from `pipeline-claude`'s CLI (`b1`), plus `uuidv5(name,
  namespace)`, the deterministic derivation the control plane needs for its two
  derived step classes (`manager`, `step:path:*`) so re-ingest stays idempotent.
  Client-minted and server-derived ids share ONE keyspace, so one
  implementation is the point. Builtin-only (`node:crypto`). Argument order is
  `(name, namespace)`, matching the `uuid` package's `v5()`. New exports only.
- **`IngestBatchContextSchema`** (`e3`, `src/ingest/index.ts`) — a shape for the
  `context` field that ingest batches were already free to carry untyped. The
  field stays OPTIONAL and is `.nullish()` (accepts both absent and `null`), the
  schema is `.passthrough()` per rule 3, and every member is itself `.nullish()`
  — mirroring the control plane's own parse, which skips `undefined` and `null`
  alike. `trigger_type` is a closed `z.enum(["manual","cron","webhook","api",
  "matrix"])` because the server already validated exactly that set; closing it
  here moves the rejection to the protocol boundary rather than widening
  anything. **Every payload that validated on 0.4.0 still validates**, asserted
  by test.

Two new modules whose exports no 0.4.0 consumer imports, and one optional field
that gained a type without gaining a requirement — rule 1 and rule 2 above.
`PROTOCOL_VERSION` stays `1` and `EVENT_SCHEMA_VERSION` stays `4`: no message
type was added, removed or changed on the wire.

## What 0.8.0 added over 0.7.0 (all additive)

Codified from the `pipeline-ui-v2` design (task `a1-protocol-run-state`, design
doc `02-target-architecture.md` §"Unified status model").

- **`src/common/run-state.ts`** — the single 7-state PUBLIC run vocabulary
  (`RUN_STATES` / `RunState`, D12) plus its canonical, pure mapper
  `deriveRunState(input)`, so CLI, runner, cloud API and web derive the same
  state from a cloud-DB row, a CLI `drive` final-JSON status, or a
  journal/drive-snapshot signal instead of each redefining the mapping. New
  module, new exports only — nothing existing changes shape. No
  approval-schema change: `NeedsInputMessageSchema` already embeds
  `question.approval` (`common/question.ts:59`, `.passthrough()`).
- **`src/wire/client.ts`: `RUN_STATUS_OUTCOME_BLOCKED`** — a new exported
  literal (`"blocked"`) plus a doc-comment update on
  `RunStatusMessageSchema.outcome` documenting that value as an accepted
  member of the already-OPEN `run_status` message's `outcome` string field.
  The `phase` enum on that same message (`src/wire/client.ts:24`) stays
  CLOSED and unchanged, per rule 1 above (closed enums cannot grow
  additively) — a doc-only change plus one new constant, no field's type or
  requiredness changed.

New exports only; `PROTOCOL_VERSION` stays `1` and `EVENT_SCHEMA_VERSION`
stays `4` — no message type or envelope field changed on the wire.

## What 0.9.0 added over 0.8.0 (all additive)

Codified from the `pipeline-ui-v2` design (task `a3-protocol-chat-frames`, design
doc `02-target-architecture.md` §M6, gate G1b) — the P2.5 run-bound chat
channel: text messages to/from the runner's executor session, riding the
existing relay transport (no second transport, M6). Revised after a blocking
taskflow review (PR #19) that found the first draft's use of the OPTIONAL
envelope `id` as a turn's only identity, its silent-rejection failure mode,
and its lack of a capability signal all insufficient — see each item below.

- **`src/wire/server.ts`: `ChatSendMessageSchema` (`chat_send`, server → agent)**
  — a brand-new message type: deliver a run-bound text chat message down to the
  runner's executor session. `{ run_id, message_id, message, sent_by, ts }`,
  built with `wireVariant()` (so `.passthrough()` per rule 3) and appended to
  `SERVER_MESSAGE_VARIANTS` (`src/wire/index.ts`). Minimal channel (R5b): text
  only, no attachment fields, no history-backfill fields; `run_id` is the sole
  SESSION-scoping key, mirroring `needs_input`/`answer`. `message_id` is a
  REQUIRED in-body TURN identity — NOT the optional envelope `id`, which
  `src/wire/envelope.ts` itself documents as "a routing aid, not a schema
  gate" — following this repo's own precedent for the identical problem:
  `needs_input`'s required `question_id` and `DeptMessageSchema`'s required
  `message_id` (`src/department/task.ts`). It disambiguates concurrent turns
  on one run, lets a redelivered `chat_send` (F7's 202-queue-and-redeliver
  semantics) be recognized as a duplicate via the `(run_id, message_id)` pair
  rather than re-injected into the session, and lets a reply to a superseded
  turn be rejected. `message` is bounded by the new `CHAT_MESSAGE_MAX_CHARS`
  constant (32,000 chars) — a fixed schema cap, since the minimal channel has
  no per-runtime capability negotiation surface the way `department.*` does
  (`DeptCapabilitiesSchema.maxMessageBytes`). `sent_by` is an AUDIT-LOG
  identity only, the same class of field as `AnswerMessageSchema.answered_by`
  — the schema carries no client-asserted authz data; chat rides the identical
  authorization path as `needs_input.answer` (07 §T7), enforced cloud-side
  before the frame is sent.
- **`src/wire/client.ts`: `ChatReplyMessageSchema` (`chat_reply`, agent → server)**
  — a brand-new message type: the runner's executor-session reply to a
  `chat_send`, STREAMED as one or more frames via `done: false`/`true`.
  `{ run_id, message_id, message, done, error?, ts }`, built with
  `wireVariant()` and appended to `CLIENT_MESSAGE_VARIANTS`. `message_id`
  REQUIRED-echoes the originating `chat_send.message_id` on every chunk of the
  turn. The new OPTIONAL `error` field (`{ code, message }`,
  `ChatReplyErrorSchema`, `.passthrough()` per rule 3, `code` an OPEN lenient
  string per rule 5 — mirrors `DeptFailedEventSchema.reason`) is the turn's
  explicit terminal-failure signal: a runner that cannot service a turn (a
  `chat_send` for a run/session it does not own, a dead executor session, a
  run gone terminal) MUST emit a final `chat_reply` with `done: true` and
  `error` populated, rather than staying silent — silence is indistinguishable
  from "still working" to a consumer assembling the stream. Same
  minimal-channel constraints and shared `CHAT_MESSAGE_MAX_CHARS` bound as
  `chat_send`.
- **`src/wire/handshake.ts`: `RegisterMessageSchema.chat_capable?: boolean`**
  — a new OPTIONAL capability flag on `register` (agent → server): `true` ⇒
  this runner supports `chat_send`/`chat_reply` and will route an inbound
  `chat_send` into the run's executor session. CAPABILITY-KEYED, not
  version-inferred — the SAME posture this package already took for
  `mesh_protocol` ("a CAPABILITY, not a version gate") and
  `heartbeat.runs_authoritative` ("CAPABILITY-KEYED, not presence-keyed"), and
  the nearest analogue, `department.message`'s `midTaskInput` gate
  (`src/department/control.ts`). Necessary because an old runner that has
  never heard of `chat_send` still parses it via the tolerant `AnyWireMessage`
  path and silently drops it — observationally identical to the B2 failure
  mode above, and undetectable from `agent_version`/`protocol_version` alone.
  Absent/`false` ⇒ the cloud must not send `chat_send` to this runner.

Every one of the four additions above is either a brand-new message `type`
(old consumers ignore an unknown type, rule 2) or a new optional field on an
already-`.passthrough()` message (rule 2); every new nested object schema
(`ChatReplyErrorSchema`) ends in `.passthrough()` (rule 3). No existing
message's field changed shape or requiredness. `PROTOCOL_VERSION` stays `1`
and `EVENT_SCHEMA_VERSION` stays `4` — no closed enum grew (the
`phase`/`RUNNER_STATUSES`/`RUN_STATUS_PHASES`/`HEARTBEAT_DIRECTIVES`/
`REGISTER_REJECT_REASONS` enums are all untouched; `ChatReplyErrorSchema.code`
is deliberately an open string, never a closed enum, exactly so a future
failure class needs no schema change).

## How a breaking change (major bump) would be handled

A change that cannot be expressed additively (removing/renaming a field,
tightening a type, changing a field's meaning) is **rare and batched** into a
major bump:

1. Bump `PROTOCOL_VERSION` to `N+1`. `isCompatible` then reports peers still on
   `N` as incompatible.
2. Version negotiation on connect (T1-02) is where the two majors are bridged —
   the control plane can speak `N` and `N+1` during a deprecation window; a
   runner advertises its major and the control plane degrades or refuses
   accordingly (the pre-migration fleet-check pattern in ARCHITECTURE.md §"Where
   the files live").
3. Because breaking bumps are expensive, the bias is always **additive optional
   fields first** — reach for a new optional field / new event type before ever
   considering a breaking change.

See `docs/spike-report.md` for the spike that proved the v5 delta is additive
(“the wire needs enrichment, not surgery”), and ARCHITECTURE.md §"Format
versioning & migrations" for how this surface relates to the pipeline file
format and the HTTP API.
