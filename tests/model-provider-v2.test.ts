import { createServer, type Server, type RequestListener } from "node:http";
import { afterEach, expect, it } from "vitest";
import { createSummaryProviderV2 } from "../apps/api/src/model-provider-v2";

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
async function provider(handler: RequestListener, extra: NodeJS.ProcessEnv = {}) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return createSummaryProviderV2({
    MODEL_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
    MODEL_API_KEY: "synthetic-test-only",
    MODEL_NAME: "test-only",
    ...extra,
  })!;
}
const input = () => ({
  system: "test-only",
  user: "{}",
  maxOutputTokens: 6000,
  signal: AbortSignal.timeout(1000),
});

it("sends one bounded text request and preserves provider usage and response identity", async () => {
  let count = 0;
  const client = await provider(async (request, response) => {
    count++;
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    expect(request.url).toBe("/v1/chat/completions");
    expect(body.stream).toBe(false);
    expect(body.max_tokens).toBe(6000);
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('enable_thinking');
    expect(body.messages.map((v: any) => v.role)).toEqual(["system", "user"]);
    response.setHeader("x-request-id", "test-request");
    response.end(
      JSON.stringify({
        choices: [
          { finish_reason: "stop", message: { content: '{"feedback":[]}' } },
        ],
        usage: { prompt_tokens: 31, completion_tokens: 9 },
      }),
    );
  });
  const result = await client.complete(input());
  expect(count).toBe(1);
  expect(result.requestId).toBe("test-request");
  expect(result.usage).toEqual({ inputTokens: 31, outputTokens: 9 });
  expect(JSON.stringify(client.configuration)).not.toContain(
    "synthetic-test-only",
  );
});

it.each(['gpt-6.1-sol', 'gpt-6-astra'])('sends a compatible bounded JSON request for %s', async model => {
  let count = 0;
  const client = await provider(async (request, response) => {
    count++;
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    expect(request.url).toBe('/v1/chat/completions');
    expect(body.model).toBe(model);
    expect(body.max_completion_tokens).toBe(6000);
    expect(body.response_format).toEqual({type:'json_object'});
    expect(body.messages.map((message: any) => message.role)).toEqual(['system', 'user']);
    for (const field of ['max_tokens', 'temperature', 'top_p', 'enable_thinking', 'thinking', 'tools'])
      expect(body).not.toHaveProperty(field);
    response.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{"status":"ok"}'}}],usage:{prompt_tokens:10,completion_tokens:40}}));
  }, {MODEL_NAME:model});
  const result = await client.complete({...input(), enableThinking:false});
  expect(count).toBe(1);
  expect(result.content).toBe('{"status":"ok"}');
  expect(result.usage).toEqual({inputTokens:10,outputTokens:40});
});

it.each(['gpt-6.1-sol', 'gpt-6-astra'])('rejects unsupported sampling for %s before making a request', model => {
  expect(() => createSummaryProviderV2({MODEL_BASE_URL:'https://api.openai.com/v1',MODEL_API_KEY:'test-only',MODEL_NAME:model,MODEL_TEMPERATURE:'0'}))
    .toThrow('MODEL_TEMPERATURE_UNSUPPORTED');
});

it('sends an explicit per-request thinking mode without changing subsequent defaults', async () => {
  const sent: unknown[] = [];
  const client = await provider(async (request, response) => {
    const chunks=[]; for await (const chunk of request) chunks.push(chunk);
    sent.push(JSON.parse(Buffer.concat(chunks).toString()).enable_thinking);
    response.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{}'}}]}));
  });
  await client.complete({...input(),enableThinking:false});
  await client.complete(input());
  expect(sent).toEqual([false,undefined]);
});
it('sends and records an explicitly fixed temperature, including zero', async () => {
  let sent: unknown;
  const client = await provider(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    sent = JSON.parse(Buffer.concat(chunks).toString()).temperature;
    response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{}' } }] }));
  }, { MODEL_TEMPERATURE: '0' });
  await client.complete(input());
  expect(sent).toBe(0); expect(client.configuration.temperature).toBe(0);
});

it('records non-thinking mode for the verified hybrid model and sends it on every default request', async () => {
  const sent: unknown[] = [];
  const client = await provider(async (request, response) => {
    const chunks=[]; for await (const chunk of request) chunks.push(chunk);
    const body=JSON.parse(Buffer.concat(chunks).toString());
    sent.push(body.enable_thinking);
    expect(body.max_tokens).toBe(6000);
    response.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{}'}}]}));
  }, { MODEL_NAME: 'qwen3.8-flash' });
  expect(client.configuration.enableThinking).toBe(false);
  await client.complete(input());
  await client.complete(input());
  expect(sent).toEqual([false,false]);
});

it.each(['NaN', '-1', '2.1', 'Infinity'])('rejects invalid temperature %s before any request', temperature => {
  expect(() => createSummaryProviderV2({ MODEL_BASE_URL: 'https://example.com/v1', MODEL_API_KEY: 'test', MODEL_NAME: 'test', MODEL_TEMPERATURE: temperature }))
    .toThrow('MODEL_TEMPERATURE_INVALID');
});

it.each(['deepseek-flash', 'deepseek-v4-pro'])('uses documented DeepSeek thinking parameters for %s', async model => {
  const sent: any[] = [];
  const client = await provider(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    sent.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{}'}}],usage:{prompt_tokens:10,completion_tokens:2}}));
  }, { MODEL_NAME: model });
  expect(client.configuration.enableThinking).toBe(false);
  await client.complete(input());
  await client.complete({...input(), enableThinking:true});
  await client.complete(input());
  expect(sent.map(body => body.thinking)).toEqual([{type:'disabled'},{type:'enabled'},{type:'disabled'}]);
  for (const body of sent) {
    expect(body).not.toHaveProperty('enable_thinking');
    expect(body.response_format).toEqual({type:'json_object'});
    expect(body.model).toBe(model);
  }
});

it('recognizes the official DeepSeek host and freezes its default thinking policy', () => {
  const client = createSummaryProviderV2({MODEL_BASE_URL:'https://api.deepseek.com',MODEL_NAME:'future-model',MODEL_API_KEY:'synthetic-test-only'})!;
  expect(client.configuration.endpoint).toBe('https://api.deepseek.com/chat/completions');
  expect(client.configuration.enableThinking).toBe(false);
});

it("does not retry a rejected request or leak its response body", async () => {
  let count = 0;
  const client = await provider((_request, response) => {
    count++;
    response.statusCode = 403;
    response.end("private provider diagnostic");
  });
  await expect(client.complete(input())).rejects.toMatchObject({
    code: "MODEL_HTTP_403",
    outcome: "failed",
    message: "MODEL_HTTP_403",
  });
  expect(count).toBe(1);
});

it("records unknown outcome on a connection lost after accepting the request", async () => {
  let count = 0;
  const client = await provider((request) => {
    count++;
    request.socket.destroy();
  });
  await expect(client.complete(input())).rejects.toMatchObject({
    outcome: "unknown",
  });
  expect(count).toBe(1);
});

it("terminates a stalled provider at the supplied deadline", async () => {
  const client = await provider(() => {});
  await expect(
    client.complete({ ...input(), signal: AbortSignal.timeout(50) }),
  ).rejects.toMatchObject({ outcome: "unknown" });
});

it("retains malformed received output privately with unknown usage instead of inventing zero", async () => {
  const client = await provider((_request, response) =>
    response.end("not JSON"),
  );
  const result = await client.complete(input());
  expect(result).toMatchObject({ raw: "not JSON", content: "", usage: null });
});

it("does not accept truncated model output as a candidate", async () => {
  const client = await provider((_request, response) =>
    response.end(
      JSON.stringify({
        choices: [
          { finish_reason: "length", message: { content: '{"feedback":[]}' } },
        ],
      }),
    ),
  );
  expect((await client.complete(input())).content).toBe("");
});

it.each(['null', '[]', '42', '"text"'])('preserves invalid envelope %s without throwing or inventing usage', async raw => {
  const client = await provider((_request, response) => response.end(raw));
  expect(await client.complete(input())).toMatchObject({ raw, content: '', usage: null });
});

it("rejects insecure remote and credential-bearing endpoint configuration", () => {
  for (const url of [
    "http://example.com/v1",
    "https://user:pass@example.com/v1",
    "https://example.com/v1?key=private",
  ])
    expect(() =>
      createSummaryProviderV2({
        MODEL_API_KEY: "test",
        MODEL_NAME: "test",
        MODEL_BASE_URL: url,
      }),
    ).toThrow();
  expect(createSummaryProviderV2({})).toBeUndefined();
});
