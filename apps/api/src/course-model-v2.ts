import { canonicalJson } from '@codelab/contracts/v2';
import type { DB } from './db.js';
import { ModelRequestError, type SummaryProviderV2 } from './model-provider-v2.js';
import type { SourceProviderResolver } from './user-model-settings.js';
import { providerConfigurationV2 } from './analysis-input-v2.js';
import { checkSourceRequestBudget, sourceContextPolicy, sourceTokenCounter } from './source-context.js';

export type CourseModelSnapshot = {
  billingUserId: string;
  configuration: SummaryProviderV2['configuration'];
};
export class CourseModelError extends Error {
  readonly code = 'MODEL_NOT_CONFIGURED';
  readonly statusCode = 409;
  constructor() { super('请先配置你自己的模型；基础检查不需要模型密钥'); }
}

/** Called inside enqueue's transaction, with the same lock as personal settings edits. */
export async function freezeCourseModel(tx: DB, resolve: SourceProviderResolver, actor: string): Promise<CourseModelSnapshot> {
  await tx.query('SELECT pg_advisory_xact_lock(41724)');
  const provider = await resolve(actor, tx);
  if (!provider?.configuration.credentialRevision)
    throw new CourseModelError();
  return { billingUserId: actor, configuration: providerConfigurationV2(provider.configuration) };
}

/** No fallback: legacy tasks without an explicit payer cannot consume a personal or platform key. */
export async function resolveCourseModel(resolve: SourceProviderResolver, snapshot: CourseModelSnapshot | undefined): Promise<SummaryProviderV2> {
  const changed = () => new ModelRequestError('ANALYSIS_CONFIGURATION_CHANGED', 'failed');
  if (!snapshot?.billingUserId || !snapshot.configuration?.credentialRevision) throw changed();
  async function current() {
    const provider = await resolve(snapshot!.billingUserId);
    if (!provider || canonicalJson(providerConfigurationV2(provider.configuration)) !== canonicalJson(providerConfigurationV2(snapshot!.configuration))) throw changed();
    return provider;
  }
  const provider = await current();
  return {
    ...provider,
    async complete(input) {
      input.signal.throwIfAborted();
      const live = await current();
      input.signal.throwIfAborted();
      // Apply the user's output cap to course requests too. Course aggregate budgets remain stricter.
      const request = { ...input, maxOutputTokens: Math.min(input.maxOutputTokens, live.sourceContext?.maxOutputTokens ?? input.maxOutputTokens) };
      if (live.sourceContext) {
        try { checkSourceRequestBudget(sourceContextPolicy(live.sourceContext), sourceTokenCounter(live.sourceContext.tokenizer), request); }
        catch { throw new ModelRequestError('MODEL_CONTEXT_BUDGET', 'failed'); }
      }
      return live.complete(request);
    },
  };
}
