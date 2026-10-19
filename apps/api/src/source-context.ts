import { getEncoding, type Tiktoken } from "js-tiktoken";

export type SourceTokenizer =
  | "utf8-conservative"
  | "cl100k_base"
  | "o200k_base";
export type SourceContextSettings = {
  contextWindowTokens: number | null;
  maxOutputTokens: number;
  tokenizer: SourceTokenizer;
};
const encoders = new Map<string, Tiktoken>();
export function readSourceContextSettings(
  env: NodeJS.ProcessEnv,
): SourceContextSettings {
  const integer = (
    name: string,
    fallback: number | null,
    min: number,
    max: number,
  ) => {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    if (!/^\d+$/.test(raw))
      throw new Error("SOURCE_CONTEXT_CONFIGURATION_INVALID");
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n < min || n > max)
      throw new Error("SOURCE_CONTEXT_CONFIGURATION_INVALID");
    return n;
  };
  const tokenizer = env.SOURCE_MODEL_TOKENIZER?.trim() || "utf8-conservative";
  if (!["utf8-conservative", "cl100k_base", "o200k_base"].includes(tokenizer))
    throw new Error("SOURCE_CONTEXT_CONFIGURATION_INVALID");
  const settings: SourceContextSettings = {
    contextWindowTokens: integer(
      "SOURCE_MODEL_CONTEXT_TOKENS",
      null,
      16384,
      2_000_000,
    ),
    maxOutputTokens: integer(
      "SOURCE_MODEL_MAX_OUTPUT_TOKENS",
      12000,
      1024,
      32768,
    )!,
    tokenizer: tokenizer as SourceTokenizer,
  };
  sourceContextPolicy(settings); // Reject inconsistent capacity before sending requests.
  return settings;
}

export function sourceContextPolicy(
  settings: SourceContextSettings = {
    contextWindowTokens: null,
    maxOutputTokens: 12000,
    tokenizer: "utf8-conservative",
  },
) {
  const { contextWindowTokens: window, maxOutputTokens, tokenizer } = settings;
  if (
    (window !== null &&
      (!Number.isSafeInteger(window) ||
        window < 16384 ||
        window > 2_000_000)) ||
    !Number.isSafeInteger(maxOutputTokens) ||
    maxOutputTokens < 1024 ||
    maxOutputTokens > 32768 ||
    !["utf8-conservative", "cl100k_base", "o200k_base"].includes(tokenizer)
  )
    throw new Error("SOURCE_CONTEXT_CONFIGURATION_INVALID");
  const safetyTokens = Math.max(2048, Math.ceil((window ?? 0) * 0.02));
  // Unknown model capacity stays unknown. 120k is an application allocation,
  // never a claimed context-window size for a model or a vendor guarantee.
  const inputTokenLimit = Math.min(
    500_000,
    window === null ? 120_000 : window - maxOutputTokens - safetyTokens,
  );
  if (inputTokenLimit < 8192)
    throw new Error("SOURCE_CONTEXT_CONFIGURATION_INVALID");
  return {
    ...settings,
    safetyTokens,
    inputTokenLimit,
    capacitySource:
      window === null
        ? ("application-fallback" as const)
        : ("operator-configured" as const),
    counting:
      tokenizer === "utf8-conservative"
        ? ("utf8-conservative-estimate" as const)
        : ("configured-tokenizer-text-count" as const),
  };
}

export function sourceTokenCounter(tokenizer: SourceTokenizer) {
  if (tokenizer === "utf8-conservative")
    return (text: string) => Buffer.byteLength(text, "utf8");
  let encoder = encoders.get(tokenizer);
  if (!encoder) {
    encoder = getEncoding(tokenizer);
    encoders.set(tokenizer, encoder);
  }
  // Uploaded special-token-looking text is ordinary untrusted data.
  return (text: string) => encoder!.encode(text, [], []).length;
}

export class SourceContextBudgetError extends Error {
  constructor() { super('MODEL_CONTEXT_BUDGET'); }
}
export function checkSourceRequestBudget(
  policy: ReturnType<typeof sourceContextPolicy>,
  count: (text: string) => number,
  request: { system: string; user: string; maxOutputTokens: number },
) {
  const inputBytes =
    Buffer.byteLength(request.system) + Buffer.byteLength(request.user);
  if (
    !Number.isSafeInteger(request.maxOutputTokens) ||
    request.maxOutputTokens < 1
  )
    throw new Error("SOURCE_CONTEXT_CONFIGURATION_INVALID");
  const inputTokens = count(request.system) + count(request.user);
  const outputTokens = Math.min(
    request.maxOutputTokens,
    policy.maxOutputTokens,
  );
  // Provider chat framing and optional response-format overhead use the safety
  // reserve. Even a configured tokenizer's text count is not vendor billing.
  if (
    inputBytes > 768 * 1024 ||
    inputTokens > policy.inputTokenLimit ||
    (policy.contextWindowTokens !== null &&
      inputTokens + outputTokens + policy.safetyTokens >
        policy.contextWindowTokens)
  )
    throw new SourceContextBudgetError();
  return {
    inputBytes,
    inputTokens,
    outputTokens,
    safetyTokens: policy.safetyTokens,
    counting: policy.counting,
  };
}
