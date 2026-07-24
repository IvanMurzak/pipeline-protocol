import { z } from "zod";

/**
 * Shared `department.*` TASK vocabulary — A2A-aligned task state, the unified
 * `Part` (A2A v1.0's `oneof {text|raw|url|data}`), and the `Message` envelope
 * that carries an array of parts. See design `08-protocol-delta.md` §2/§3.
 *
 * Every schema here is a NESTED wire shape (embedded inside a `wireVariant()`
 * frame elsewhere under `./`), so per ADDITIVE-POLICY rule 3 each ends in
 * `.passthrough()` even though it is never itself a top-level envelope.
 */

/**
 * The eight A2A v1.0 task states, MINUS the proto zero-value
 * `TASK_STATE_UNSPECIFIED` (a value we never store — 08 §3), and with the
 * `TASK_STATE_` prefix stripped: the wire and internal storage are
 * unprefixed, and the prefix is re-added only at the A2A facade boundary
 * (05). Keeping the wire unprefixed avoids leaking an external spec's naming
 * into an internal contract that also serves MCP.
 */
export const DEPT_TASK_STATES = [
  "SUBMITTED",
  "WORKING",
  "COMPLETED",
  "FAILED",
  "CANCELED",
  "INPUT_REQUIRED",
  "REJECTED",
  "AUTH_REQUIRED",
] as const;
export type DeptTaskState = (typeof DEPT_TASK_STATES)[number];

/** A department task's lifecycle state — see {@link DEPT_TASK_STATES}. */
export const DeptTaskStateSchema = z.enum(DEPT_TASK_STATES);

/**
 * A2A v1.0's unified `Part`: a `oneof {text | raw | url | data}` plus sibling
 * metadata fields, `.refine`d so EXACTLY ONE content member is set (a part
 * with zero or two content members is malformed). `raw` is base64-encoded
 * bytes in JSON — 08 §3 flags this as easy to miss even though 05 §1/§5/§9
 * all require inline binary to be legal.
 *
 * `.passthrough()` on the base object (ADDITIVE-POLICY rule 3) so a newer
 * peer's additive sibling field survives; the `.refine` runs AFTER shape
 * validation, so an unknown extra field never defeats the content-member
 * check. NOTE: this schema is intentionally never embedded directly as a
 * discriminated-union MEMBER (which would require a bare `ZodObject`) — it
 * only ever appears nested inside an array field (`DeptMessageSchema.parts`,
 * `DeptMessageEventSchema.parts`), where a `.refine()`-wrapped schema is
 * fine.
 */
export const DeptPartSchema = z
  .object({
    /** Plain-text content. */
    text: z.string().optional(),
    /** Base64-encoded inline bytes. */
    raw: z.string().optional(),
    /** A URL reference to the content (fetched out-of-band). */
    url: z.string().url().optional(),
    /** Structured/JSON content. */
    data: z.unknown().optional(),
    /** MIME type of the content (any member). */
    mediaType: z.string().optional(),
    /** Suggested filename, when the content is file-shaped. */
    filename: z.string().optional(),
    /** Free-form metadata sibling (A2A `Part.metadata`). */
    metadata: z.record(z.unknown()).optional(),
  })
  .passthrough()
  .refine(
    (p) => [p.text, p.raw, p.url, p.data].filter((v) => v !== undefined).length === 1,
    { message: "DeptPartSchema: exactly one content member (text | raw | url | data) must be set" },
  );
export type DeptPart = z.infer<typeof DeptPartSchema>;

/**
 * A2A v1.0's unified `Message`: one or more {@link DeptPartSchema} parts plus
 * routing/threading metadata. `reference_task_ids` is the spec's sanctioned
 * way to relate tasks (A2A §3.4.3, "Agents SHOULD use referenced tasks to
 * understand the context") — it carries the same information as the internal
 * `parent_task_id` used by `tasks.create_followup` (04 §3.9); the A2A
 * projection populates it from that field.
 */
export const DeptMessageSchema = z
  .object({
    message_id: z.string().min(1),
    role: z.enum(["ROLE_USER", "ROLE_AGENT"]),
    parts: z.array(DeptPartSchema).min(1),
    context_id: z.string().optional(),
    task_id: z.string().optional(),
    /** A2A §3.4.3 — relates this message to other tasks (see doc above). */
    reference_task_ids: z.array(z.string()).optional(),
    created_at: z.string().datetime({ offset: true }),
    metadata: z.record(z.unknown()).optional(),
  })
  .passthrough();
export type DeptMessage = z.infer<typeof DeptMessageSchema>;

/**
 * Department questions REUSE the existing {@link QuestionSchema} (and its
 * `ApprovalSchema` sibling, `../common/question.ts`) UNCHANGED — "no
 * parallel shape" (08 §3). Re-exported under a `Dept`-prefixed alias so mesh
 * consumers can import it from `./mesh/` without reaching into
 * `../common/`.
 */
export { QuestionSchema as DeptQuestionSchema, type Question as DeptQuestion } from "../common/question.js";
