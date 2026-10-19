type Finding = {
  citations: readonly { path: string; start: number; end: number }[];
  confidence?: string;
  severity?: string;
  nextStep?: string;
};

/** Reading order only; valid-looking citations are not proof of correctness. */
export function prioritizeFindings<T extends Finding>(findings: readonly T[]): T[] {
  const score = (finding: T) => {
    const cited = finding.citations.some(c => c.path.trim() && Number.isSafeInteger(c.start)
      && Number.isSafeInteger(c.end) && c.start > 0 && c.end >= c.start);
    return [Number(cited), Number(cited && finding.confidence === 'direct'),
      Number(Boolean(finding.nextStep?.trim())), ({ high: 3, medium: 2, low: 1 }[finding.severity ?? ''] ?? 0)];
  };
  return findings.map((finding, index) => ({ finding, index, scores: score(finding) }))
    .sort((a, b) => {
      for (let i = 0; i < a.scores.length; i++) {
        if (a.scores[i] !== b.scores[i]) return b.scores[i] - a.scores[i];
      }
      return a.index - b.index;
    }).map(item => item.finding);
}
