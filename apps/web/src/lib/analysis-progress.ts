export const analysisStages = ['识别项目结构', '追踪核心业务', '整理解读与源码依据'] as const;

const stageByEvent: Record<string, number> = {
  map: 0, plan: 0, read: 0, delta: 0,
  investigate_plan: 1, investigate: 1, search: 1, investigate_done: 1,
  synthesize: 2, validate: 2, repair: 2, verify_plan: 2,
  read_verify: 2, verify: 2, repair_verification: 2, verified: 2,
};

// Events can interleave (verification may search/read again). Never move backwards.
export function analysisStage(events: readonly { kind: string }[]): number {
  return events.reduce((stage, event) => Math.max(stage, stageByEvent[event.kind] ?? 0), 0);
}

export function readableHistory<T extends { id: string; status: string; report?: unknown }>(
  analyses: readonly T[], currentId?: string,
): T | undefined {
  return analyses.find(analysis => analysis.id !== currentId && analysis.status === 'succeeded' && !!analysis.report);
}
