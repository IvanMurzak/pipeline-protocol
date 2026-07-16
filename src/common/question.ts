import { z } from "zod";

/**
 * The membership roles an APPROVAL GATE (T3-14) may require — mirrors the
 * control plane's `MembershipRole` (`apps/api/src/db/types.ts`), owner > admin
 * > member > viewer. The protocol package has no dependency on the db types, so
 * the value space is pinned here as a zod enum; it is the source of truth the
 * OSS runner parses against.
 */
export const APPROVAL_ROLES = ["owner", "admin", "member", "viewer"] as const;
export type ApprovalRole = (typeof APPROVAL_ROLES)[number];

/**
 * The APPROVAL-GATE marker (T3-14). When present on a needs-input question it
 * turns that question into an approval gate: it may be answered ONLY by a user
 * whose role ≥ `required_role`, and the answer is a structured approve/reject
 * decision. Absent ⇒ an ordinary needs-input question. Additive-only within
 * protocol major 1 — no version bump.
 */
export const ApprovalSchema = z
  .object({
    /** Minimum membership role permitted to answer this gate. */
    required_role: z.enum(APPROVAL_ROLES),
  })
  // Additive-forward: tolerate (and preserve) fields a newer peer may add.
  .passthrough();

export type Approval = z.infer<typeof ApprovalSchema>;

/**
 * The needs-input QUESTION shape — shared by the step-record (`records/`) and
 * the journalled `awaiting_input` event (`events/`). Mirrors the OSS
 * `StepQuestion` (`apps/pipeline-cli/src/lib/step-schema.ts`: `{text, context,
 * options}`) plus the v5 additive **`question_id`** (spike-report G3): a stable
 * identity for the question, echoed by the answer so a stale answer racing a
 * superseded question can be rejected.
 *
 * `question_id` is OPTIONAL here (additive over v4 — old questions carried
 * none). It is REQUIRED as a sibling field on `awaiting_input`/`AnswerMessage`,
 * which are v5-only and always carry it.
 */
export const QuestionSchema = z
  .object({
    /** The question to put to the answerer. Required + non-empty. */
    text: z.string().min(1),
    /** What the step already did/found, so the answerer can decide. */
    context: z.string().nullable().optional(),
    /** Optional preset choices. */
    options: z.array(z.string()).nullable().optional(),
    /** v5 additive (G3): stable question identity, echoed by the answer. */
    question_id: z.string().min(1).optional(),
    /**
     * T3-14 additive: APPROVAL-GATE marker. Present ⇒ this needs-input question
     * is an approval gate answerable only by a role ≥ `approval.required_role`
     * (enforced by the control plane's relay). Absent/null ⇒ an ordinary
     * question with the default answer policy. Old questions carried none, so
     * this is byte-identical for every question without a gate.
     */
    approval: ApprovalSchema.nullable().optional(),
  })
  // Additive-forward: tolerate (and preserve) fields added by a newer peer.
  .passthrough();

export type Question = z.infer<typeof QuestionSchema>;
