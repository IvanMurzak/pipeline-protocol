import { z } from "zod";

/**
 * The STRUCTURED ANSWER MESSAGE (spike-report G8) — the reply to a needs-input
 * question on the WSS wire. v4 answer delivery was PROSE-ONLY (the resume
 * template's first line `Answer to your question: <text>`); v5 gives it a
 * structured envelope that also feeds the audit log (ARCHITECTURE §security).
 *
 * Shape: `{ run_id, question_id, answer, answered_by, ts }`. `question_id`
 * echoes the question's identity (G3) so the relay can reject an answer to a
 * superseded question.
 */
export const AnswerMessageSchema = z
  .object({
    run_id: z.string().min(1),
    /** Echoes the question's `question_id` (G3). */
    question_id: z.string().min(1),
    /** The answer text. */
    answer: z.string().min(1),
    /** WHO answered — audit-log identity (role-gated per ARCHITECTURE §security,
     *  G10). */
    answered_by: z.string().min(1),
    /** ISO-8601 UTC time the answer was submitted. */
    ts: z.string().datetime({ offset: true }),
  })
  .passthrough();
export type AnswerMessage = z.infer<typeof AnswerMessageSchema>;
