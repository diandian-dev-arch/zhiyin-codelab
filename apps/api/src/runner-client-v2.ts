import {
  LIMITS_V1,
  runnerCapabilitiesSchema,
  runnerCleanupRequestSchema,
  runnerCleanupResponseSchema,
  runnerExecuteResponseSchema,
  runnerHeartbeatRequestSchema,
  runnerHeartbeatResponseSchema,
  runnerOperationQueryRequestSchema,
  runnerOperationQueryResponseSchema,
  validateRunRequest,
  validateProbeRequest, validateProbeResponse, runnerProbeResponseSchema,
  type RunnerProbeRequest, type RunnerProbeResponse, type RuleSnapshot,
  validatePreparationRequest, validatePreparationResponse, runnerPreparationResponseSchema,
  type RunnerPreparationRequest, type RunnerPreparationResponse,
  type RunnerCleanupRequest,
  type RunnerCleanupResponse,
  type RunnerExecuteRequest,
  type RunnerExecuteResponse,
  type RunnerHeartbeatRequest,
  type RunnerHeartbeatResponse,
  type RunnerOperationQueryRequest,
  type RunnerOperationQueryResponse,
} from "@codelab/contracts/v2";
import type { z } from "zod";

export type RunnerCapabilitiesV2 = z.infer<typeof runnerCapabilitiesSchema>;
export interface RunnerCallOptionsV2 {
  signal?: AbortSignal;
  timeoutMs?: number;
}
export interface RunnerClientV2 {
  prepareProbe?(request: RunnerPreparationRequest, options?: RunnerCallOptionsV2): Promise<RunnerPreparationResponse>;
  probe(request: RunnerProbeRequest, rule: RuleSnapshot, options?: RunnerCallOptionsV2): Promise<RunnerProbeResponse>;
  capabilities(options?: RunnerCallOptionsV2): Promise<RunnerCapabilitiesV2>;
  execute(
    request: RunnerExecuteRequest,
    options?: RunnerCallOptionsV2,
  ): Promise<RunnerExecuteResponse>;
  heartbeat(
    request: RunnerHeartbeatRequest,
    options?: RunnerCallOptionsV2,
  ): Promise<RunnerHeartbeatResponse>;
  query(
    request: RunnerOperationQueryRequest,
    options?: RunnerCallOptionsV2,
  ): Promise<RunnerOperationQueryResponse>;
  cleanup(
    request: RunnerCleanupRequest,
    options?: RunnerCallOptionsV2,
  ): Promise<RunnerCleanupResponse>;
}

/** Error text deliberately excludes request bodies, credentials and remote HTML. */
export class RunnerClientError extends Error {
  constructor(
    readonly kind: "transport" | "timeout" | "http" | "protocol" | "aborted",
    readonly code: string,
    readonly statusCode?: number,
  ) {
    super(code);
  }
}

async function readJson(
  response: Response,
  maxBytes: number,
): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    (!/^\d+$/.test(declared) || Number(declared) > maxBytes)
  ) {
    await response.body?.cancel();
    throw new RunnerClientError("protocol", "RUNNER_RESPONSE_TOO_LARGE");
  }
  if (!response.body)
    throw new RunnerClientError("protocol", "RUNNER_EMPTY_RESPONSE");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new RunnerClientError("protocol", "RUNNER_RESPONSE_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
  } catch {
    throw new RunnerClientError("protocol", "RUNNER_INVALID_JSON");
  }
}

export function createRunnerClientV2(input: {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}): RunnerClientV2 {
  const base = new URL(input.baseUrl);
  if (
    !/^https?:$/.test(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new Error("RUNNER_URL_INVALID");
  if (
    input.token.length < 32 ||
    input.token.startsWith("replace-") ||
    /[\r\n]/.test(input.token)
  )
    throw new Error("RUNNER_TOKEN_INVALID");
  const transport = input.fetchImpl ?? fetch;
  const url = (endpoint: string) =>
    `${base.toString().replace(/\/$/, "")}${endpoint}`;

  async function request<T>(
    endpoint: string,
    body: unknown | undefined,
    schema: z.ZodType<T>,
    options: RunnerCallOptionsV2 = {},
    maximum = LIMITS_V1.runnerMetadataMaxBytes,
  ): Promise<T> {
    const timeoutMs = options.timeoutMs ?? 5_000;
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > 300_000
    )
      throw new Error("RUNNER_TIMEOUT_INVALID");
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeout])
      : timeout;
    try {
      const response = await transport(url(endpoint), {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${input.token}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        redirect: "error",
        signal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) {
        // Keep status even when a reverse proxy sends non-JSON or an oversized body.
        let code = `RUNNER_HTTP_${response.status}`;
        try {
          const value = (await readJson(
            response,
            Math.min(maximum, 64 * 1024),
          )) as {
            code?: unknown;
            error?: { code?: unknown };
          };
          const candidate = value?.error?.code ?? value?.code;
          if (
            typeof candidate === "string" &&
            /^[A-Z][A-Z0-9_]{0,99}$/.test(candidate)
          )
            code = candidate;
        } catch {
          /* The HTTP status remains authoritative. */
        }
        throw new RunnerClientError("http", code, response.status);
      }
      const value = await readJson(response, maximum);
      const parsed = schema.safeParse(value);
      if (!parsed.success)
        throw new RunnerClientError("protocol", "RUNNER_RESPONSE_INVALID");
      return parsed.data;
    } catch (error) {
      if (options.signal?.aborted)
        throw new RunnerClientError("aborted", "RUNNER_CALL_ABORTED");
      if (timeout.aborted)
        throw new RunnerClientError("timeout", "RUNNER_CALL_TIMEOUT");
      if (error instanceof RunnerClientError) throw error;
      throw new RunnerClientError("transport", "RUNNER_TRANSPORT_FAILED");
    }
  }
  return {
    async prepareProbe(value, options) {
      const checked=await validatePreparationRequest(value);
      const response=await request('/v2/prepare-probe',checked,runnerPreparationResponseSchema,options);
      try { return validatePreparationResponse(response,checked); }
      catch { throw new RunnerClientError('protocol','RUNNER_PREPARATION_RESPONSE_INVALID'); }
    },
    async probe(value, rule, options) {
      const checked = await validateProbeRequest(value, rule);
      const response = await request('/v2/probe', checked, runnerProbeResponseSchema, options,
        LIMITS_V1.runnerResponseMaxBytes);
      try { return await validateProbeResponse(response, checked, rule); }
      catch { throw new RunnerClientError('protocol', 'RUNNER_PROBE_RESPONSE_INVALID'); }
    },
    capabilities: (options) =>
      request("/v2/capabilities", undefined, runnerCapabilitiesSchema, options),
    async execute(value, options) {
      const checked = await validateRunRequest(value);
      return request(
        "/v2/execute",
        checked,
        runnerExecuteResponseSchema,
        options,
        LIMITS_V1.runnerResponseMaxBytes,
      );
    },
    heartbeat: (value, options) =>
      request(
        "/v2/heartbeat",
        runnerHeartbeatRequestSchema.parse(value),
        runnerHeartbeatResponseSchema,
        options,
      ),
    async query(value, options) {
      const parsed = await request(
        "/v2/operations/query",
        runnerOperationQueryRequestSchema.parse(value),
        runnerOperationQueryResponseSchema,
        options,
        LIMITS_V1.runnerResponseMaxBytes + 4096,
      );
      return { record: parsed.record, response: parsed.response ?? null };
    },
    cleanup: (value, options) =>
      request(
        "/v2/cleanup",
        runnerCleanupRequestSchema.parse(value),
        runnerCleanupResponseSchema,
        options,
      ),
  };
}
