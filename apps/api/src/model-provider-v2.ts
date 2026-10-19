import {
  readSourceContextSettings,
  type SourceContextSettings,
} from "./source-context.js";
export interface SummaryResponseV2 {
  raw: string;
  content: string;
  requestId: string | null;
  usage: { inputTokens: number; outputTokens: number } | null;
}
export interface SummaryProviderV2 {
  /** Source-analysis-only policy; does not relabel historical course model configurations. */
  sourceContext?: SourceContextSettings;
  configuration: {
    provider: string;
    model: string;
    endpoint: string;
    temperature?: number;
    enableThinking?: boolean;
    credentialRevision?: string;
  };
  complete(input: {
    system: string;
    user: string;
    maxOutputTokens: number;
    enableThinking?: boolean;
    signal: AbortSignal;
  }): Promise<SummaryResponseV2>;
}
export class ModelRequestError extends Error {
  constructor(
    readonly code: string,
    readonly outcome: "failed" | "unknown",
  ) {
    super(code);
  }
}
// These verified models require a reasoning-inclusive completion budget.
export function isOpenAIReasoningModel(model: string) {
  return model === "gpt-6.1-sol" || model === "gpt-6-astra";
}
/** OpenAI-compatible non-streaming chat completions, exactly one HTTP request. */
export function createSummaryProviderV2(
  env: NodeJS.ProcessEnv = process.env,
): SummaryProviderV2 | undefined {
  if (!env.MODEL_API_KEY) return undefined;
  if (!env.MODEL_BASE_URL || !env.MODEL_NAME)
    throw new Error("MODEL_CONFIGURATION_INCOMPLETE");
  const base = new URL(env.MODEL_BASE_URL);
  if (
    !/^https?:$/.test(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new Error("MODEL_ENDPOINT_INVALID");
  if (
    base.protocol !== "https:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)
  )
    throw new Error("MODEL_ENDPOINT_REQUIRES_TLS");
  const endpoint = `${base.href.replace(/\/$/, "")}/chat/completions`;
  const sourceContext = readSourceContextSettings(env);
  const key = env.MODEL_API_KEY,
    model = env.MODEL_NAME;
  // Verified hybrid model: thinking tokens consume the same bounded course
  // deadline. Record the policy so old/default-mode runs cannot be paired as
  // though their sampling configuration were identical. Other models unchanged.
  // DeepSeek's OpenAI-compatible endpoint uses `thinking.type`, not
  // DashScope's `enable_thinking`. Bound interactive JSON analysis explicitly;
  // its API otherwise enables reasoning by default.
  const deepseek = base.hostname === "api.deepseek.com" ||
    ["deepseek-flash", "deepseek-v4-pro"].includes(model);
  const enableThinking = deepseek || model === "qwen3.8-flash" ? false : undefined;
  const rawTemperature = env.MODEL_TEMPERATURE?.trim();
  const temperature = rawTemperature ? Number(rawTemperature) : undefined;
  if (
    temperature !== undefined &&
    (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)
  )
    throw new Error("MODEL_TEMPERATURE_INVALID");
  const openaiReasoning = isOpenAIReasoningModel(model);
  if (openaiReasoning && temperature !== undefined)
    throw new Error("MODEL_TEMPERATURE_UNSUPPORTED");
  return {
    sourceContext,
    configuration: {
      provider: "openai-compatible",
      model,
      endpoint,
      ...(temperature === undefined ? {} : { temperature }),
      ...(enableThinking === undefined ? {} : { enableThinking }),
    },
    async complete(input) {
      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: "POST",
          redirect: "error",
          signal: input.signal,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${key}`,
          },
          body: JSON.stringify({
            model,
            ...(temperature === undefined ? {} : { temperature }),
            stream: false,
            ...(openaiReasoning
              ? { max_completion_tokens: input.maxOutputTokens }
              : { max_tokens: input.maxOutputTokens }),
            ...(openaiReasoning || (input.enableThinking ?? enableThinking) === undefined
              ? {}
              : deepseek
                ? { thinking: { type: (input.enableThinking ?? enableThinking) ? "enabled" : "disabled" } }
                : { enable_thinking: input.enableThinking ?? enableThinking }),
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: input.system },
              { role: "user", content: input.user },
            ],
          }),
        });
      } catch {
        throw new ModelRequestError("MODEL_TRANSPORT_UNKNOWN", "unknown");
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new ModelRequestError(
          `MODEL_HTTP_${response.status}`,
          response.status >= 500 ? "unknown" : "failed",
        );
      }
      const reader = response.body?.getReader();
      if (!reader) throw new ModelRequestError("MODEL_EMPTY_BODY", "unknown");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const item = await reader.read();
          if (item.done) break;
          size += item.value.byteLength;
          if (size > 256_000) {
            await reader.cancel();
            throw new Error("size");
          }
          chunks.push(item.value);
        }
      } catch {
        throw new ModelRequestError("MODEL_RESPONSE_UNKNOWN", "unknown");
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      // Preserve received malformed output for the private audit as well.
      let body: any;
      try {
        body = JSON.parse(raw);
      } catch {
        body = {};
      }
      // Valid JSON may still be null, an array or a scalar. Preserve the raw
      // response for audit, but treat all such envelopes as unusable output.
      if (!body || typeof body !== "object" || Array.isArray(body)) body = {};
      const usage = body.usage;
      const validUsage =
        Number.isSafeInteger(usage?.prompt_tokens) &&
        usage.prompt_tokens >= 0 &&
        Number.isSafeInteger(usage?.completion_tokens) &&
        usage.completion_tokens >= 0;
      return {
        raw,
        content:
          typeof body.choices?.[0]?.message?.content === "string" &&
          body.choices?.[0]?.finish_reason === "stop"
            ? body.choices[0].message.content
            : "",
        requestId: response.headers.get("x-request-id")?.slice(0, 256) ?? null,
        usage: validUsage
          ? {
              inputTokens: usage.prompt_tokens,
              outputTokens: usage.completion_tokens,
            }
          : null,
      };
    },
  };
}
