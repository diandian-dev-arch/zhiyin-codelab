export type InitialAnalysisModeV2 = 'off' | 'summary' | 'agent';
export function parseInitialAnalysisModeV2(value: unknown): InitialAnalysisModeV2 {
  if (value === 'off' || value === 'summary' || value === 'agent') return value;
  throw new Error('INITIAL_ANALYSIS_MODE_INVALID');
}
/** Only initial analysis; explicit archived reanalysis remains the Agent workflow. */
export function readInitialAnalysisModeV2(env: NodeJS.ProcessEnv = process.env): InitialAnalysisModeV2 {
  return parseInitialAnalysisModeV2(env.CODELAB_INITIAL_ANALYSIS_MODE ?? 'agent');
}
