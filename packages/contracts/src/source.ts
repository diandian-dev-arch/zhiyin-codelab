export { evidenceFlowSchema } from './evidence-flow.js';
export { readingBriefSchema, findingGuidanceSchema, validatedReadingBrief, remapReadingBrief } from './source-report.js';
export type { SourceCitation, SourceReportSection, SourceProjectReportData, ReadingBrief } from './source-report.js';
/** Ordinary static source imports. Course execution has its own, smaller limits. */
export const sourceImportLimits = {
  zipBytes: 100 * 1024 * 1024,
  expandedBytes: 500 * 1024 * 1024,
  entries: 20_000,
  retainedBytes: 16 * 1024 * 1024,
  fileBytes: 512 * 1024,
  concurrentImports: 2,
  uploadTimeoutMs: 120_000,
} as const;

export type SourceCoverage = {
  indexedFiles: number;
  planningFiles: number;
  readFiles: number;
  readLines: number;
  totalLines: number;
  charactersRead: number;
  characterBudget: number;
};

export type SourceAnalysisMode = "quick" | "deep";
/** Optional evidence-backed scene; legacy prose flows remain the fallback. */
export type EvidenceFlow = {
  id: string;
  title: string;
  summary: string;
  steps: {
    id: string;
    title: string;
    responsibility: string;
    symbol?: string;
    input?: string;
    output?: string;
    citations: { path: string; start: number; end: number }[];
  }[];
  edges: {
    from: string;
    to: string;
    relation: 'call' | 'data' | 'inferred';
    evidence: { path: string; start: number; end: number }[];
    explanation: string;
  }[];
  gaps: string[];
};
export type SourceAnalysisOptions = {
  version: 1;
  mode: SourceAnalysisMode;
  modules: string[];
  cost?: { limitCny?: number; inputPerMillion: number; outputPerMillion: number; label: string };
  reuse?: boolean;
  incrementalFrom?: string;
};
export const sourceAnalysisProfiles = {
  quick: {
    label: "快速概览",
    characters: 100_000,
    investigationRounds: 0,
    timeoutMs: 510_000,
    leaseSeconds: 540,
  },
  deep: {
    label: "深入分析",
    characters: 180_000,
    investigationRounds: 2,
    timeoutMs: 810_000,
    leaseSeconds: 840,
  },
} as const;
export type SourceModule = {
  id: string;
  label: string;
  fileCount: number;
  lines: number;
  examples: string[];
};

export type SourceContextSummary = {
  policy: {
    contextWindowTokens: number | null;
    maxOutputTokens: number;
    tokenizer: "utf8-conservative" | "cl100k_base" | "o200k_base";
    inputTokenLimit: number;
    safetyTokens: number;
    capacitySource: "application-fallback" | "operator-configured";
    counting: "utf8-conservative-estimate" | "configured-tokenizer-text-count";
  };
  sourceTokenLimit: number;
  estimatedSourceTokens: number;
  callsWithUsage: number;
  callsWithoutUsage: number;
  knownInputTokens: number | null;
  knownOutputTokens: number | null;
};

export type SourceCallBudget = {
  inputBytes: number;
  inputTokens: number;
  outputTokens: number;
  safetyTokens: number;
  counting: SourceContextSummary["policy"]["counting"];
};
export type SourceCallReceipt = {
  state: "returned" | "failed" | "unknown";
  durationMs: number;
  usage: { inputTokens: number; outputTokens: number } | null;
  requestId: string | null;
  errorCode: string | null;
};
export type SourceUsageSummary = {
  recording: "available" | "historical-unavailable";
  registeredCalls: number;
  returnedCalls: number;
  failedCalls: number;
  pendingCalls: number;
  unknownCalls: number;
  callsWithUsage: number;
  callsWithoutUsage: number;
  knownInputTokens: number | null;
  knownOutputTokens: number | null;
};

// Quality describes whether this analysis finished its configured checks, not
// whether every file was read or the project is correct/safe at runtime.
export type SourceReportLimitReason = 'EVIDENCE_FLOW_REJECTED' | 'COUNTEREVIDENCE_PLAN_INVALID' | 'READING_ENHANCEMENT_REJECTED' | 'COST_BUDGET_LIMITED' | 'CONTEXT_BUDGET_LIMITED' | 'OUTPUT_BUDGET_LIMITED';
export type SourceReportQualityFields = {
  reportQuality?: 'complete' | 'limited';
  reportLimitReasons?: SourceReportLimitReason[];
  analysisWarnings?: string[];
};
export function sourceReportQuality(report: SourceReportQualityFields): 'complete' | 'limited' | 'unknown' {
  // Old warnings remain meaningful; never relabel an unclassified old report
  // as complete just because its task status is succeeded.
  if (report.analysisWarnings?.length || report.reportLimitReasons?.length || report.reportQuality === 'limited') return 'limited';
  return report.reportQuality === 'complete' ? 'complete' : 'unknown';
}
