import type { SourceCitation } from '@codelab/contracts/source';
export type { SourceCitation } from '@codelab/contracts/source';
export type SourceContent = { path: string; content: string; startLine?: number; totalLines?: number };
export function citationRange(citation: SourceCitation, full: boolean) {
  return full ? '' : `&start=${Math.max(1, citation.start - 5)}&end=${citation.end + 10}`;
}
export type EvidenceContext = {
  owner: { kind: 'scene' | 'module' | 'finding' | 'reading' | 'verification'; key: string };
  contextTitle: string;
  contextText?: string;
  citations: SourceCitation[];
  selectedIndex: number;
};
