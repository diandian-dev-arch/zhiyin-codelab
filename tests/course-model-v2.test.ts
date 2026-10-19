import { it, expect, vi } from 'vitest';
import { resolveCourseModel } from '../apps/api/src/course-model-v2';
import type { SummaryProviderV2 } from '../apps/api/src/model-provider-v2';

it('revalidates every model call, caps output and rejects changed revisions or missing payer', async () => {
  const complete = vi.fn(async (_input: Parameters<SummaryProviderV2['complete']>[0]) => ({ raw:'{}', content:'{}', requestId:null, usage:null }));
  let revision = 'revision-one';
  const resolve = vi.fn(async (): Promise<SummaryProviderV2> => ({
    configuration: { provider:'fixture', model:'one', endpoint:'https://example.invalid', credentialRevision:revision },
    sourceContext: { contextWindowTokens:16384, maxOutputTokens:1024, tokenizer:'utf8-conservative' }, complete,
  }));
  const snapshot = { billingUserId:'actor', configuration:(await resolve()).configuration };
  const client = await resolveCourseModel(resolve, snapshot);
  const input = { system:'system', user:'user', maxOutputTokens:4000, signal:new AbortController().signal };
  await client.complete(input);
  expect(complete.mock.calls[0][0]).toMatchObject({ maxOutputTokens:1024 });
  await expect(client.complete({ ...input, user:'X'.repeat(20000) })).rejects.toMatchObject({ code:'MODEL_CONTEXT_BUDGET', outcome:'failed' });
  revision = 'revision-two';
  await expect(client.complete(input)).rejects.toMatchObject({ code:'ANALYSIS_CONFIGURATION_CHANGED', outcome:'failed' });
  await expect(resolveCourseModel(resolve, undefined)).rejects.toThrow('ANALYSIS_CONFIGURATION_CHANGED');
  expect(complete).toHaveBeenCalledTimes(1);
});
