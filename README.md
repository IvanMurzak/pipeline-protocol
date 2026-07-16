# @baizor/pipeline-protocol

The wire contract between the **ai-pipeline control plane** (closed source) and
the public **pipeline-runner**: **zod schemas + inferred TS types + validators**
for every event, record, and ingest shape. Versioned **additive-only within a
major** — see [ADDITIVE-POLICY.md](./ADDITIVE-POLICY.md).

Anything that emits this protocol can be a runner — this is the multi-CLI hedge.

Consumers today: the private `cloud` monorepo (control plane) and the public
`pipeline-runner` (as an npm dependency).

## Install

```
bun add @baizor/pipeline-protocol   # or: npm i @baizor/pipeline-protocol
```

## Usage

```ts
import {
  parseEvent,
  safeParseEvent,
  AnswerMessageSchema,
  IngestBatchRequestSchema,
  isShippableEvent,
  PROTOCOL_VERSION,
  isCompatible,
} from "@baizor/pipeline-protocol";

// Strict, well-typed parse (throws on a malformed / unknown event):
const event = parseEvent(rawJsonLine); // -> discriminated union over `type`
if (event.type === "awaiting_input") {
  event.data.question.text; // fully typed
}

// Only ship events with a non-null run_id:
if (isShippableEvent(event)) upload(event);

// Version negotiation (same-major = compatible):
if (!isCompatible(remotePeerMajor)) refuseConnection();
```

## What's here

| Module | Exports |
|---|---|
| `events/` | The event **envelope** + per-`type` `data` schemas + the discriminated union (`EventEnvelope`), the tolerant `AnyEventEnvelope`, the shippable-event rule (`isShippableEvent`, `ShippableEventEnvelope`), and the run-lifecycle events (`run.started`/`run.completed`/`run.halted`, `awaiting_input`). |
| `records/` | The `ClaudeEnvelope` result schema, the `StepRecord` schema, and the structured `AnswerMessage`. |
| `ingest/` | The batched-upload request/response + the shipper-assigned `(run_id, seq)` idempotency contract. |
| `common/` | The shared `Question` shape (with `question_id`) and outcome value spaces. |
| `wire/` | The runner <-> control-plane wire messages (handshake, client, server). |
| `version.ts` | `PROTOCOL_VERSION`, `EVENT_SCHEMA_VERSION`, `isCompatible()`. |

## Scripts

- `bun run typecheck` — `tsc --noEmit`
- `bun test` — the schema test suite
- `bun run build` — emit `dist/` + `.d.ts` (via `tsconfig.build.json`)

## License

MIT
