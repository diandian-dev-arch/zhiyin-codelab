import type { SourceAnalysisOptions, SourceCallBudget, SourceCallReceipt } from '@codelab/contracts/source';
import type { SummaryProviderV2 } from './model-provider-v2.js';
import { sourceContextPolicy } from './source-context.js';

export type CostPolicy = NonNullable<SourceAnalysisOptions['cost']>;
// A dated conservative tariff, not a live invoice. No inferred holiday calendar:
// always reserve at peak rates with no cache discount, even across time boundaries.
export function officialSourcePrice(provider: Pick<SummaryProviderV2, 'configuration'>): CostPolicy | null {
  const url = new URL(provider.configuration.endpoint);
  if (url.origin !== 'https://api.deepseek.com') return null;
  const rates = provider.configuration.model === 'deepseek-flash' ? [2, 8]
    : provider.configuration.model === 'deepseek-v4-pro' ? [9, 27] : null;
  return rates ? { inputPerMillion: rates[0], outputPerMillion: rates[1],
    label: 'DeepSeek 官方 · 2026-09-29 · 高峰未缓存价' } : null;
}
export function priceTokens(price: CostPolicy, input: number, output: number) {
  return Math.ceil((input * price.inputPerMillion + output * price.outputPerMillion)) / 1_000_000;
}
export function reserveCall(price: CostPolicy, budget: SourceCallBudget) {
  return priceTokens(price, budget.inputTokens + budget.safetyTokens, budget.outputTokens);
}
export class SourceCostBudgetError extends Error {
  constructor() { super('SOURCE_COST_BUDGET'); }
}
export function createCostGuard(price?: CostPolicy) {
  let committed = 0;
  return {
    before(budget: SourceCallBudget) {
      if (!price) return;
      if (price.limitCny !== undefined && committed + reserveCall(price, budget) > price.limitCny + 1e-9)
        throw new SourceCostBudgetError();
    },
    allocate(budget: SourceCallBudget, minimumOutput = Math.min(1024, budget.outputTokens), reserveCny = 0) {
      if (!price || price.limitCny === undefined) return budget;
      const fits = (outputTokens: number) => committed + reserveCny + reserveCall(price, { ...budget, outputTokens }) <= price.limitCny! + 1e-9;
      if (!fits(minimumOutput)) throw new SourceCostBudgetError();
      let low = minimumOutput, high = budget.outputTokens;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (fits(middle)) low = middle;
        else high = middle - 1;
      }
      return { ...budget, outputTokens: low };
    },
    received(budget: SourceCallBudget, usage: SourceCallReceipt['usage']) {
      if (price) committed += usage ? priceTokens(price, usage.inputTokens, usage.outputTokens) : reserveCall(price, budget);
    },
  };
}
export function quoteSource(provider: SummaryProviderV2, options: SourceAnalysisOptions) {
  const price = options.cost ?? officialSourcePrice(provider);
  const policy = sourceContextPolicy(provider.sourceContext);
  // Plans share one repair; draft and verification may each repair once.
  // This is an allocation ceiling, not a prediction.
  const calls = options.mode === 'deep' ? 9 : 7;
  return { price, maxCalls: calls,
    allocationCny: price ? priceTokens(price, calls * (policy.inputTokenLimit + policy.safetyTokens), calls * policy.maxOutputTokens) : null,
    source: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing' };
}
export function sameAnalysisScope(a: SourceAnalysisOptions, b: SourceAnalysisOptions) {
  return a.mode === b.mode && a.incrementalFrom === b.incrementalFrom && JSON.stringify([...a.modules].sort()) === JSON.stringify([...b.modules].sort());
}
export function summarizeSourceCost(price: CostPolicy | undefined, calls: {usage: SourceCallReceipt['usage']; budget: SourceCallBudget}[]) {
  if (!price) return null;
  return { price, knownCny: calls.reduce((n,c) => n + (c.usage ? priceTokens(price,c.usage.inputTokens,c.usage.outputTokens) : 0),0),
    reservedCny: calls.reduce((n,c) => n + (!c.usage ? reserveCall(price,c.budget) : 0),0),
    unknownCalls: calls.filter(c => !c.usage).length };
}
