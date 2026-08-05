/**
 * The privacy-tier filter — the canonical copy.
 *
 * `./privacy.ts` is a **verbatim, byte-for-byte lift** of the runner's
 * `pipeline-runner/src/shipper/privacy.ts` (430 lines,
 * `sha256 e3d53e9b71eda780632ce833be400a61f116ec9f29f467233133a05b6fef0d58`,
 * re-verified 2026-08-04). It is deliberately UNMODIFIED — not reformatted, not
 * re-quoted to this package's double-quote style, not re-worded — so that a
 * plain byte comparison against the other copies stays meaningful.
 *
 * ## Why there are still several copies
 *
 * | Copy | Where | State |
 * | --- | --- | --- |
 * | This package | `src/privacy/privacy.ts` | **The source of truth from day one.** |
 * | Runner | `pipeline-runner/src/shipper/privacy.ts` | Keeps its own copy this release. |
 * | Vendored CLI | `pipeline-claude/apps/pipeline-cli/src/lib/vendor/privacy.ts` | Until plugin-thin phase 6. |
 *
 * They must move in LOCKSTEP. The comparison cannot live in any one of these
 * repos — a repo's own CI checkout never has the other repos' sources on disk,
 * so such a test would be vacuous. It lives in the parent monorepo, which
 * checks out all of them as submodules:
 * `scripts/check-privacy-filter-drift.mjs`, wired into CI (ux-v2 task `a1`,
 * gate SG2).
 *
 * ## What this repo CAN prove, and does
 *
 * `./privacy.test.ts` is the allowlist conformance test (gate SG1). It is not a
 * smoke test for the filter — it *is* the privacy policy, written down twice
 * over and pinned field-for-field:
 *
 *  1. the allowlist tables are extracted from `./privacy.ts`'s syntax tree and
 *     deep-compared against a pinned table in the test, and
 *  2. the SAME tables are re-derived from the COMPILED filter's observable
 *     behaviour and compared again,
 *
 * so adding or removing one single allowlisted field turns the suite red from
 * both directions. A synthetic hostile event stuffed with prompts, absolute
 * paths, tool arguments and error text is then driven through the filter and
 * its output asserted exactly.
 *
 * **If you change `./privacy.ts`, the conformance test is supposed to go red.**
 * Update the pinned table in the same commit, deliberately — that edit is the
 * privacy-policy change, and it is what a reviewer reads.
 */

export * from "./privacy.js";
