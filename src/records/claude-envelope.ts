import { z } from "zod";

/**
 * The `claude -p --output-format json` RESULT ENVELOPE — the single JSON object
 * a headless claude process prints on exit. Mirrors OSS `ClaudeEnvelope` /
 * `EnvelopeUsage` (`apps/pipeline-cli/src/lib/envelope.ts`), i.e. the NORMALIZED
 * post-parse shape (the raw wire uses `input_tokens` / `cache_read_input_tokens`
 * / … which the OSS parser folds into `input` / `cache_read` / …).
 *
 * When `--json-schema` was passed, `structured_output` IS the step record (see
 * `./step-record.ts`) — schema-validated by the harness itself.
 */

export const EnvelopeUsageSchema = z
  .object({
    input: z.number(),
    output: z.number(),
    cache_read: z.number(),
    cache_creation: z.number(),
  })
  .passthrough();
export type EnvelopeUsage = z.infer<typeof EnvelopeUsageSchema>;

export const ClaudeEnvelopeSchema = z
  .object({
    /** True when the run errored (`subtype` carries the category). */
    is_error: z.boolean(),
    /** "success" | "error_max_turns" | … — null when absent. */
    subtype: z.string().nullable(),
    /** Final response text (stringified JSON when `--json-schema` was used). */
    result: z.string().nullable(),
    session_id: z.string().nullable(),
    /** The `--json-schema`-validated object (the step record); null when the
     *  flag wasn't passed. */
    structured_output: z.record(z.unknown()).nullable(),
    total_cost_usd: z.number().nullable(),
    usage: EnvelopeUsageSchema.nullable(),
    num_turns: z.number().nullable(),
  })
  .passthrough();
export type ClaudeEnvelope = z.infer<typeof ClaudeEnvelopeSchema>;
