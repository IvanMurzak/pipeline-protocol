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

- **`src/mesh/`** — a whole new, ADDITIVE `department.*` message vocabulary:
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
Every new NESTED object schema in `src/mesh/` (`DeptPartSchema`,
`DeptMessageSchema`, `DeptLimitsSchema`, `DeptCapabilitiesSchema`, and each
`DeptRuntimeEventSchema` union member) ends in `.passthrough()` per rule 3,
asserted by test (`src/mesh/mesh.test.ts`), not by eye.

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
