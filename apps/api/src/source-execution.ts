import { z } from "zod";
import type { SummaryProviderV2 } from "./model-provider-v2.js";
import { sourceContextPolicy } from "./source-context.js";

const snapshotSchema = z
  .object({
    version: z.literal(1),
    model: z
      .object({
        provider: z.string(),
        model: z.string(),
        endpoint: z.string(),
        temperature: z.number().finite().optional(),
        enableThinking: z.boolean().optional(),
        credentialRevision: z.string().uuid().optional(),
      })
      .strict(),
    context: z
      .object({
        contextWindowTokens: z.number().int().nullable(),
        maxOutputTokens: z.number().int(),
        tokenizer: z.enum(["utf8-conservative", "cl100k_base", "o200k_base"]),
        safetyTokens: z.number().int(),
        inputTokenLimit: z.number().int(),
        capacitySource: z.enum(["application-fallback", "operator-configured"]),
        counting: z.enum([
          "utf8-conservative-estimate",
          "configured-tokenizer-text-count",
        ]),
      })
      .strict(),
  })
  .strict();

/** Only public configuration is persisted; API keys and prompt/source content are excluded. */
export function sourceExecutionSnapshot(provider: SummaryProviderV2) {
  const {
    provider: name,
    model,
    endpoint,
    temperature,
    enableThinking,
    credentialRevision,
  } = provider.configuration;
  return snapshotSchema.parse({
    version: 1,
    model: {
      provider: name,
      model,
      endpoint,
      ...(temperature === undefined ? {} : { temperature }),
      ...(enableThinking === undefined ? {} : { enableThinking }),
      ...(credentialRevision === undefined ? {} : { credentialRevision }),
    },
    context: sourceContextPolicy(provider.sourceContext),
  });
}

/** Parse both sides to normalize JSONB key order; a queued job never silently changes models/budget. */
export function assertSourceExecutionSnapshot(
  saved: unknown,
  provider: SummaryProviderV2,
) {
  const parsed = snapshotSchema.safeParse(saved);
  if (
    !parsed.success ||
    JSON.stringify(parsed.data) !==
      JSON.stringify(sourceExecutionSnapshot(provider))
  )
    throw new Error("SOURCE_CONFIGURATION_CHANGED");
}
