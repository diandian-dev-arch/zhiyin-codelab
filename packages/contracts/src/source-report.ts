import { z } from 'zod';
import type { EvidenceFlow, SourceReportQualityFields } from './source.js';

export const readingCitationSchema = z.object({ path: z.string().min(1).max(400), start: z.number().int().positive(), end: z.number().int().positive() })
  .refine(c => c.end >= c.start);
export type SourceCitation = z.infer<typeof readingCitationSchema>;
const sourceRef = z.object({ section: z.enum(['modules', 'flows', 'findings', 'readingPath']), index: z.number().int().nonnegative() });
const sourcedText = z.object({ text: z.string().min(1).max(240), sourceRefs: z.array(sourceRef).min(1).max(6), citations: z.array(readingCitationSchema).min(1).max(6) });
export const readingBriefSchema = z.object({
  version: z.literal(1),
  purpose: sourcedText.extend({ audience: z.string().min(1).max(160).optional(), input: z.string().min(1).max(160).optional(), output: z.string().min(1).max(160).optional() }),
  scenes: z.array(z.object({
    sourceRef: z.object({ section: z.literal('flows'), index: z.number().int().nonnegative() }),
    businessSummary: z.string().min(1).max(500),
    activities: z.array(z.object({ text: z.string().min(1).max(120), citations: z.array(readingCitationSchema).min(1).max(6) })).max(6).optional(),
  })).max(5).optional(),
  takeaway: sourcedText.optional(),
});
export type ReadingBrief = z.infer<typeof readingBriefSchema>;
export const findingGuidanceSchema = z.object({
  condition: z.string().min(1).max(500).optional(),
  verificationSteps: z.array(z.object({ action: z.string().min(1).max(300), expectedObservation: z.string().min(1).max(300) })).min(1).max(3).optional(),
  remediation: z.string().min(1).max(600).optional(),
});
export type SourceReportSection = z.infer<typeof findingGuidanceSchema> & {
  title: string; body: string; citations: SourceCitation[]; severity?: string; confidence?: string; nextStep?: string; decision?: string;
};
export type SourceProjectReportData = SourceReportQualityFields & {
  overview: string; stack: string[]; modules: SourceReportSection[]; flows: SourceReportSection[];
  findings: SourceReportSection[]; readingPath: SourceReportSection[]; limitations: string[];
  evidenceFlows?: EvidenceFlow[]; readingBrief?: ReadingBrief;
  verification?: { originalTitle: string; decision: string; reason: string; citations: SourceCitation[] }[];
};

type SourceSections = Pick<SourceProjectReportData, 'modules' | 'flows' | 'findings' | 'readingPath'>;
// Existence and citation checks are necessary, not proof of semantic accuracy.
export function validatedReadingBrief(raw: unknown, report: SourceSections, wasRead?: (citation: SourceCitation) => boolean): ReadingBrief | undefined {
  const parsed = readingBriefSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const validRefs = (refs: ReadingBrief['purpose']['sourceRefs']) => refs.every(ref => !!report[ref.section][ref.index]);
  const validCitations = (citations: SourceCitation[], refs: ReadingBrief['purpose']['sourceRefs']) => citations.every(c =>
    (!wasRead || wasRead(c)) && refs.some(ref => report[ref.section][ref.index]?.citations.some(origin =>
      origin.path === c.path && origin.start <= c.start && origin.end >= c.end)));
  const brief = parsed.data;
  if (!validRefs(brief.purpose.sourceRefs) || !validCitations(brief.purpose.citations, brief.purpose.sourceRefs)) return undefined;
  const scenes = brief.scenes?.filter(scene => !!report.flows[scene.sourceRef.index] && (!scene.activities || scene.activities.every(a => validCitations(a.citations, [scene.sourceRef]))));
  if (scenes && new Set(scenes.map(s => s.sourceRef.index)).size !== scenes.length) return undefined;
  return { ...brief, scenes, takeaway: brief.takeaway && validRefs(brief.takeaway.sourceRefs) && validCitations(brief.takeaway.citations, brief.takeaway.sourceRefs) ? brief.takeaway : undefined };
}

// Review emits findings in check order. Use an explicit index map; never guess by title.
export function remapReadingBrief(raw: unknown, findingMap: Map<number, number>, changed: Set<string>): unknown {
  const parsed = readingBriefSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const brief = parsed.data;
  const remap = (item: ReadingBrief['purpose']) => {
    const refs = [];
    for (const ref of item.sourceRefs) {
      if (changed.has(`${ref.section}:${ref.index}`)) return undefined;
      if (ref.section === 'findings') {
        const index = findingMap.get(ref.index);
        if (index === undefined) return undefined;
        refs.push({ ...ref, index });
      } else refs.push(ref);
    }
    return { ...item, sourceRefs: refs };
  };
  const purpose = remap(brief.purpose);
  if (!purpose) return undefined;
  return { ...brief, purpose, takeaway: brief.takeaway ? remap(brief.takeaway) : undefined,
    scenes: brief.scenes?.filter(scene => !changed.has(`flows:${scene.sourceRef.index}`)) };
}
