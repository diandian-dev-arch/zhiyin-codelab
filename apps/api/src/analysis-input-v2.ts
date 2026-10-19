import { canonicalJson, sha256, type ReportValidationContext } from '@codelab/contracts/v2';
import type { SummaryProviderV2 } from './model-provider-v2.js';

/** The common sealed source, excluding mutable teacher text and later supplemental evidence. */
export async function sealedAnalysisInputHashV2(context: ReportValidationContext) {
  return sha256(canonicalJson({
    version: 'sealed-analysis-source-v1',
    rule: context.rule,
    baseResults: context.baseResults,
    baseManifest: context.baseManifest,
  }));
}

export function providerConfigurationV2(configuration: SummaryProviderV2['configuration']) {
  return {
    provider: configuration.provider,
    model: configuration.model,
    endpoint: configuration.endpoint,
    ...(configuration.temperature === undefined ? {} : { temperature: configuration.temperature }),
    ...(configuration.enableThinking === undefined ? {} : { enableThinking: configuration.enableThinking }),
    ...(configuration.credentialRevision === undefined ? {} : { credentialRevision: configuration.credentialRevision }),
  };
}

export function assertProviderConfigurationV2(frozen: SummaryProviderV2['configuration'], provider: SummaryProviderV2) {
  if (canonicalJson(providerConfigurationV2(frozen)) !== canonicalJson(providerConfigurationV2(provider.configuration)))
    throw new Error('ANALYSIS_CONFIGURATION_CHANGED');
}
