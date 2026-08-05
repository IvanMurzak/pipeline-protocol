/**
 * Identity — the shared mint point (ux-v2 `e2-publish-ids`).
 *
 * `newId()` is the UUIDv7 generator promoted from `pipeline-claude`'s CLI
 * (task `b1`, `apps/pipeline-cli/src/lib/ids.ts`) so client and server mint
 * conformant ids from the same code. `uuidv5()` is the deterministic
 * derivation the server uses for the two step classes it derives rather than
 * observes (`manager`, `step:path:*`) — see `./ids.ts` for the full rationale,
 * bit layout, and the argument-order pitfall this module guards against.
 */

export * from "./ids.js";
