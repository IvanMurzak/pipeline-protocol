/**
 * ids — the single mint point for every identity this product creates, and the
 * one place client and server share code for it (ux-v2 `02` D11/D15).
 *
 *   const runId = newId();      // "019fc762-5762-7000-a9bf-922ed8fa00be" (v7)
 *   const stepId = uuidv5("manager", runId); // deterministic (v5)
 *
 * ## v7 — `createIdGenerator` / `newId`
 *
 * PROMOTED, not re-derived: this is a straight port of the generator written
 * and conformance-tested in `pipeline-claude` task `b1`
 * (`apps/pipeline-cli/src/lib/ids.ts`), which stays the CLI's own copy for now
 * (it is invoked straight out of the plugin's cached git checkout — a tree
 * with no install step — so it cannot yet `import` this package; that
 * migration is a separate task). This file is the promotion target: the
 * canonical source both `b1`'s eventual CLI wiring and the server-side
 * consumer (`c2`) build on.
 *
 * `newId()` returns an RFC 9562 §5.7 UUIDv7. There is no second v7 mint site
 * in this package, no per-call format argument, and — deliberately — no
 * runtime-capability branch:
 *
 *   - `crypto.randomUUID()` is UUIDv4 (version nibble `4`). Wrong version, no
 *     embedded timestamp, no index locality.
 *   - A native v7 primitive exists on SOME runtimes (`Bun.randomUUIDv7()`) but
 *     not others (no Node primitive below Node 26.1), and this exact module is
 *     the one the client CLI's `--target=node` bundle and the Bun-based server
 *     must agree with bit-for-bit. A `typeof Bun !== "undefined" ? … : …`
 *     branch would mean two generators with two monotonicity behaviours and
 *     two failure modes wearing one name — the thing D11 rules out. So there
 *     is exactly one code path, and every runtime takes it.
 *
 * ZERO DEPENDENCIES for this module specifically: `node:crypto` and nothing
 * else (the package as a whole depends on `zod` for its schemas, but the id
 * generator does not reach for it, in case a future consumer needs this file
 * import-isolated the way the CLI needs its own copy today).
 *
 * ── INTRA-MILLISECOND ORDERING: IN SCOPE ─────────────────────────────────────
 *
 * This generator implements RFC 9562 §6.2 **Method 1 — Fixed-Length Dedicated
 * Counter Bits**: `rand_a` (the 12 bits immediately after the timestamp, which
 * is exactly where §6.2 requires the counter to sit) holds a per-millisecond
 * counter, randomly seeded on every new tick, incremented on every mint inside
 * the same tick.
 *
 * The alternative — a pure-CSPRNG `rand_a` — is conformant too, but leaves ids
 * minted in the SAME millisecond mutually unordered. Three reasons this design
 * wants the counter instead:
 *
 *   1. RFC 9562 §6.2 carries a SHOULD for implementations "concerned about
 *      monotonicity with high-frequency UUID generation". This generator is in
 *      that regime by measurement, not by speculation: the ux-v2 D7 evidence
 *      recorded 5 000 mints inside ~256 ms (~20 mints per millisecond), so the
 *      overwhelmingly common case is several ids sharing one tick.
 *   2. The stated reason this product chose v7 over v4 at all is index
 *      locality (ux-v2 `02-target-architecture.md`, trade-offs table). Locality
 *      that stops at millisecond granularity only partly delivers that.
 *   3. `07-security.md` T12 already ACCEPTS that a v7 id signals creation
 *      order. The counter makes that accepted property actually true rather
 *      than true-to-the-millisecond. It discloses nothing new beyond the
 *      already-accepted millisecond timestamp: relative order among ids minted
 *      by one process inside one millisecond.
 *
 * WHAT THE COUNTER DOES AND DOES NOT GUARANTEE:
 *   - Within one process: ids are STRICTLY INCREASING as 128-bit big-endian
 *     values and, equivalently, as lowercase canonical strings under plain
 *     lexicographic comparison (the version nibble and variant bits are
 *     constant, so they never perturb the ordering).
 *   - Across processes or machines: NO ordering guarantee finer than the
 *     millisecond timestamp. That is inherent to any counter-based v7 (RFC 9562
 *     §6.2 says as much) and is not something this generator can fix.
 *
 * Uniqueness does not rest on the counter. Every id carries 62 CSPRNG bits in
 * `rand_b`, drawn fresh per mint; the counter only orders ids that would
 * otherwise tie.
 *
 * PURE LIBRARY: importing this module runs nothing but the module-level
 * generator construction (which reads no clock and no entropy until the first
 * `newId()` call).
 *
 * ## v5 — `uuidv5`
 *
 * The one deliberate exception to "every id is v7": two step classes the
 * server DERIVES rather than observes (`manager`, `step:path:*`, `02`
 * identity-model table) are UUIDv5 over the run UUID, so re-ingest stays
 * idempotent — the same property `derive.ts:168-169` relies on today. RFC
 * 9562 §5.5's `MUST NOT` is scoped to *SHA-256*-derived name-based UUIDs
 * (which must live in the v8 space); it does not deprecate SHA-1-based v5.
 *
 * **Argument order is `uuidv5(name, namespace)`** — name first, namespace
 * second — matching the prevailing JS convention (the `uuid` npm package's
 * `v5(name, namespace)`), not the "namespace-first" phrasing a plain-English
 * description invites. The namespace argument MUST already be a valid UUID
 * string; `uuidv5` throws `TypeError: Invalid UUID` otherwise. This is not
 * incidental: a prior revision of this design wrote the call reversed —
 * `uuidv5(run_uuid, "manager")`, i.e. namespace first — which, under this
 * argument order, passes `"manager"` as the namespace and throws exactly that
 * `TypeError` (`"manager"` is not a parseable UUID). `./ids.test.ts` pins this
 * with a test vector so the order cannot silently flip back.
 */

import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";

// ── Bit layout (RFC 9562 §5.7 for v7, §5.5 for v5) ───────────────────────────
//
//   v7  bits   0–47   unix_ts_ms   big-endian milliseconds since the Unix epoch
//       bits  48–51   ver          0b0111
//       bits  52–63   rand_a       12-bit counter, seeded per tick (§6.2 Method 1)
//       bits  64–65   var          0b10
//       bits  66–127  rand_b       62 CSPRNG bits
//
//   v5  bits   0–127  the first 16 bytes of SHA1(namespace_bytes || name_bytes),
//              with `ver` (bits 48–51) forced to 0b0101 and `var` (bits 64–65)
//              forced to 0b10 over the hash output.
//
// As bytes: [ts0 ts1 ts2 ts3 ts4 ts5][ver|rand_a_hi][rand_a_lo][var|rand_b …]

/** `ver` field value — UUID version 7, placed in the high nibble of byte 6. */
const VERSION_7 = 0x70;

/** `ver` field value — UUID version 5, placed in the high nibble of byte 6. */
const VERSION_5 = 0x50;

/** `var` field value — the RFC 4122/9562 variant `0b10`, in the top two bits of byte 8. */
const VARIANT_RFC = 0x80;

/** Widest value `rand_a` can hold (12 bits). */
const COUNTER_MAX = 0x0fff;

/**
 * Bits of CSPRNG seed loaded into the counter at the start of each new
 * millisecond. Eight of the twelve counter bits are seeded; the top four are
 * left clear as §6.2's "counter rollover guard", which reserves headroom so a
 * burst inside one tick cannot immediately overflow. Concretely: a fresh tick
 * starts somewhere in [0, 255] and can absorb at least 3 840 further mints in
 * that same millisecond before the rollover path is even reachable — two orders
 * of magnitude above the ~20/ms this generator is actually driven at.
 */
const COUNTER_SEED_MASK = 0xff;

/** `unix_ts_ms` is 48 bits. Reached in the year 10889; masked defensively so a
 *  nonsense clock can never corrupt the version nibble in the next byte. */
const MAX_UNIX_TS_MS = 0xffffffffffff;

const HEX: readonly string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

/** 16 bytes → canonical lowercase `8-4-4-4-12`. No Buffer, no dependency. */
function toCanonical(bytes: Uint8Array): string {
  let hex = "";
  // Non-null assertions below: `i` is loop-bounded to [0, 16) into a 16-byte
  // array and HEX has exactly 256 entries indexed by a byte value — both
  // reads are provably in range; `noUncheckedIndexedAccess` cannot see that.
  for (let i = 0; i < 16; i++) hex += HEX[bytes[i]!]!;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Canonical `8-4-4-4-12` UUID string → its 16 bytes. Throws `TypeError:
 * Invalid UUID` if the string is not exactly 32 hex digits arranged as
 * 8-4-4-4-12 — mirroring the `uuid` npm package's `parse()`, which is why a
 * reversed `uuidv5` call (a non-UUID string in the namespace slot) fails this
 * way rather than silently hashing garbage.
 */
function parseUuid(uuid: string): Uint8Array {
  if (typeof uuid !== "string") throw new TypeError("Invalid UUID");
  const parts = uuid.split("-");
  if (parts.length !== 5) throw new TypeError("Invalid UUID");
  const want = [8, 4, 4, 4, 12];
  for (let i = 0; i < 5; i++) {
    // `parts.length === 5` and `want.length === 5` are both just checked/
    // fixed above, so both reads are in range.
    if (parts[i]!.length !== want[i]!) throw new TypeError("Invalid UUID");
  }
  const hex = parts.join("");
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new TypeError("Invalid UUID");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// ── v7 ────────────────────────────────────────────────────────────────────────

/** Seams for the conformance tests ONLY — see `createIdGenerator`. */
export interface IdGeneratorOptions {
  /** Clock in epoch milliseconds. Default `Date.now`. */
  now?: () => number;
  /** CSPRNG. Must return at least `n` bytes. Default `node:crypto`'s `randomBytes`. */
  randomBytes?: (n: number) => Uint8Array;
}

/**
 * Build an independent UUIDv7 generator with an injectable clock and CSPRNG.
 *
 * **This is not a second mint point.** Product code calls `newId()`. This
 * factory is exported for exactly one reason: the counter-rollover and
 * clock-regression paths above are unreachable from a real clock in a test, and
 * an untested monotonicity guarantee is not a guarantee. Every generator owns
 * its own counter state, so a test can drive one without perturbing `newId()`.
 */
export function createIdGenerator(options: IdGeneratorOptions = {}): () => string {
  const now = options.now ?? Date.now;
  const random = options.randomBytes ?? nodeRandomBytes;

  // Highest timestamp this generator has emitted. Never moves backwards, so a
  // clock that jumps back (NTP step, VM restore, DST-unaware host) cannot make
  // this generator emit a smaller id than one it already handed out.
  let lastMs = -1;
  let counter = 0;

  return function mint(): string {
    const observed = now();
    const ms = Number.isFinite(observed) ? Math.max(0, Math.min(Math.trunc(observed), MAX_UNIX_TS_MS)) : 0;

    if (ms > lastMs) {
      // New tick: re-seed the counter (§6.2 Method 1 — the counter is random
      // per tick, not a global sequence, so it leaks no cross-tick volume).
      // `random(1)` is contracted (`IdGeneratorOptions.randomBytes`) to
      // return at least 1 byte; index 0 is always present.
      lastMs = ms;
      counter = random(1)[0]! & COUNTER_SEED_MASK;
    } else {
      // Same tick, or the clock regressed. Either way `lastMs` is the timestamp
      // we keep, and the counter is what orders this id after the previous one.
      counter += 1;
      if (counter > COUNTER_MAX) {
        // §6.2 counter rollover guard: borrow a millisecond from the future
        // rather than emit a duplicate or a non-increasing id. Self-correcting
        // — the real clock catches up as soon as the burst subsides.
        lastMs = Math.min(lastMs + 1, MAX_UNIX_TS_MS);
        counter = random(1)[0]! & COUNTER_SEED_MASK;
      }
    }

    const tsHi = Math.floor(lastMs / 0x100000000) & 0xffff; // bits 0–15
    const tsLo = lastMs % 0x100000000; // bits 16–47

    const bytes = new Uint8Array(16);
    bytes[0] = (tsHi >>> 8) & 0xff;
    bytes[1] = tsHi & 0xff;
    bytes[2] = (tsLo >>> 24) & 0xff;
    bytes[3] = (tsLo >>> 16) & 0xff;
    bytes[4] = (tsLo >>> 8) & 0xff;
    bytes[5] = tsLo & 0xff;
    bytes[6] = VERSION_7 | ((counter >>> 8) & 0x0f); // ver + rand_a high nibble
    bytes[7] = counter & 0xff; // rand_a low byte

    // `random(8)` is contracted to return at least 8 bytes; indices 0–7 are
    // always present.
    const entropy = random(8);
    bytes[8] = VARIANT_RFC | (entropy[0]! & 0x3f); // var + rand_b top 6 bits
    for (let i = 1; i < 8; i++) bytes[8 + i] = entropy[i]!;

    return toCanonical(bytes);
  };
}

/** The process-wide generator backing `newId()`. */
const mintDefault = createIdGenerator();

/**
 * Mint a new identity. RFC 9562 UUIDv7, canonical lowercase `8-4-4-4-12`.
 *
 * This is the sanctioned way to create a client- or server-minted id in this
 * product — runs, steps, requests, messages. Never derive one from a hash,
 * never let a prompt invent a format, never call `crypto.randomUUID()` (that
 * is a v4).
 *
 * The one deliberate exception is `uuidv5`, below: the two step classes the
 * server derives rather than observes (`manager`, `step:path:*`) do not come
 * from here, and conformance tests must assert the version nibble per class —
 * `7` for anything minted by this function, `5` for those two.
 */
export function newId(): string {
  return mintDefault();
}

// ── v5 ────────────────────────────────────────────────────────────────────────

/**
 * Derive a deterministic UUIDv5 (RFC 9562 §5.5 / RFC 4122 §4.3) from a name and
 * a namespace UUID: `SHA1(namespace_bytes || name_bytes)`, truncated to 16
 * bytes, with the version nibble forced to `5` and the variant bits forced to
 * `0b10`.
 *
 * **Argument order: `uuidv5(name, namespace)`** — name first, namespace
 * second — matching the prevailing JS convention (the `uuid` package's
 * `v5(name, namespace)`). `namespace` MUST be a canonical UUID string; a
 * non-UUID value throws `TypeError: Invalid UUID` rather than silently
 * hashing garbage, which is exactly what surfaces a reversed call (see this
 * module's doc comment).
 *
 * Deterministic and stateless: same `(name, namespace)` in ⇒ byte-identical
 * UUID out, in any process, on any platform, forever. That determinism is
 * what lets the server derive `manager` and `step:path:*` step ids from the
 * run UUID and have re-ingest stay idempotent (`derive.ts:168-169`'s
 * property).
 */
export function uuidv5(name: string, namespace: string): string {
  const namespaceBytes = parseUuid(namespace);
  const nameBytes = new TextEncoder().encode(name);
  const digest = createHash("sha1").update(namespaceBytes).update(nameBytes).digest();

  // SHA-1 digests are always 20 bytes; indices 0–15 are always present.
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = digest[i]!;
  bytes[6] = VERSION_5 | (bytes[6]! & 0x0f);
  bytes[8] = VARIANT_RFC | (bytes[8]! & 0x3f);

  return toCanonical(bytes);
}
