import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { root } from '../apps/api/src/template.js';
import { createSummaryProviderV2, ModelRequestError } from '../apps/api/src/model-provider-v2.js';

// Default is offline preflight. --request sends ONE fixed, non-student prompt.
// A successful connectivity smoke test is never a quality evaluation.
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--request') || args.length > 1) throw new Error('EXPECTED_OPTIONAL_REQUEST');
const id = randomUUID(), request = args.includes('--request');
const missing = ['MODEL_BASE_URL', 'MODEL_NAME', 'MODEL_API_KEY'].filter(key => !process.env[key]?.trim());
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const record: Record<string, unknown> = {
  id, measuredAt: new Date().toISOString(), mode: request ? 'connectivity-smoke' : 'offline-preflight',
  state: 'not_configured', missing, requestAttempted: false, requestCount: 0,
  source: 'fixed-nonstudent-connectivity-prompt', qualityEvaluationCompleted: false,
  usage: null, cost: null,
};
let exitCode = 2;
if (!missing.length) {
  try {
    const provider = createSummaryProviderV2()!;
    record.endpointKind = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(provider.configuration.endpoint).hostname)
      ? 'local_endpoint_not_external_model_evidence' : 'configured_remote_endpoint';
    record.configurationSha256 = hash(JSON.stringify(provider.configuration));
    record.state = 'configured_not_contacted'; exitCode = 0;
    if (request) {
      const input = { system: 'Return exactly one JSON object: {"status":"ok"}. Do not include any other keys or text.',
        user: '{"purpose":"CodeLab connectivity smoke test; no student data"}', maxOutputTokens: 64 };
      const privateDirectory = path.join(root, '.data/model-verification', id);
      await mkdir(privateDirectory, { recursive: true, mode: 0o700 });
      await writeFile(path.join(privateDirectory, 'request.json'), JSON.stringify({ configuration: provider.configuration, input }), { flag: 'wx', mode: 0o600 });
      record.requestSha256 = hash(JSON.stringify(input));
      record.requestAttempted = true; record.requestCount = 1;
      const started = performance.now();
      try {
        const response = await provider.complete({ ...input, signal: AbortSignal.timeout(15000) });
        await writeFile(path.join(privateDirectory, 'response.json'), JSON.stringify(response), { flag: 'wx', mode: 0o600 });
        record.responseSha256 = hash(response.raw); record.usage = response.usage;
        let parsed: unknown;
        try { parsed = JSON.parse(response.content); } catch { parsed = null; }
        const valid = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
          && Object.keys(parsed).length === 1 && (parsed as { status?: unknown }).status === 'ok';
        record.state = valid ? 'smoke_passed' : 'smoke_invalid_output';
        exitCode = valid ? 0 : 1;
      } finally { record.elapsedMs = Math.round(performance.now() - started); }
    }
  } catch (error) {
    record.state = 'failed'; exitCode = 1;
    record.errorCode = error instanceof ModelRequestError ? error.code : 'CONFIGURATION_OR_LOCAL_AUDIT_FAILED';
    record.outcome = error instanceof ModelRequestError ? error.outcome : 'unconfirmed';
    // No raw exception: endpoint parsing and filesystem errors may contain secrets.
  }
}
const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
const directory = path.join(root, 'docs/verification', date, `model-${id}`);
await mkdir(directory, { recursive: true });
await writeFile(path.join(directory, 'result.json'), JSON.stringify(record, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ state: record.state, missing, requestAttempted: record.requestAttempted,
  evidence: path.relative(root, path.join(directory, 'result.json')) }));
process.exitCode = exitCode;
