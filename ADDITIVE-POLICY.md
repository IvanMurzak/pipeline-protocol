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
3. **Negotiate on connect.** Peers exchange `PROTOCOL_VERSION` when they connect;
   `isCompatible(remoteMajor)` encodes the policy (same major ⇒ compatible).
   Full negotiation (capability flags, min-common-minor, graceful degradation)
   is T1-02.
4. **Value spaces may widen additively.** A field whose value space the emitter
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
