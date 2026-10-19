import { evidenceFlowSchema as flowSchema } from '@codelab/contracts/source';
import type { EvidenceFlow } from '@codelab/contracts/source';
import { citationWasRead, type SourceRanges } from './source-reader.js';

/** A range check is not semantic proof. Direct edges need an independent verifier. */
export type EvidenceRelationVerifier = (edge: EvidenceFlow['edges'][number], flow: EvidenceFlow) => boolean;
export type EvidenceFlowResult = { flows: EvidenceFlow[]; rejected: number; reasons: string[] };

export function validateEvidenceFlows(raw: unknown, ranges: SourceRanges, verifyRelation?: EvidenceRelationVerifier): EvidenceFlowResult {
  if (raw === undefined) return { flows: [], rejected: 0, reasons: [] };
  if (!Array.isArray(raw) || raw.length > 5) return { flows: [], rejected: 1, reasons: ['INVALID_FLOW_COLLECTION'] };
  const result: EvidenceFlowResult = { flows: [], rejected: 0, reasons: [] };
  const ids = new Set<string>();
  // Reject duplicate flow identities as a group rather than arbitrarily trusting the first.
  const duplicates = new Set(raw.flatMap(item => item && typeof item.id === 'string' && raw.filter(other => other?.id === item.id).length > 1 ? [item.id] : []));
  for (const item of raw) {
    const parsed = flowSchema.safeParse(item);
    let reason = '';
    if (!parsed.success) reason = 'INVALID_FLOW_SHAPE';
    else {
      const flow = parsed.data;
      const stepIds = new Set(flow.steps.map(step => step.id));
      const edgeKeys = flow.edges.map(edge => `${edge.from}\0${edge.to}\0${edge.relation}`);
      if (ids.has(flow.id) || duplicates.has(flow.id) || stepIds.size !== flow.steps.length) reason = 'DUPLICATE_FLOW_ID';
      else if (new Set(edgeKeys).size !== edgeKeys.length || flow.edges.some(edge => !stepIds.has(edge.from) || !stepIds.has(edge.to) || edge.from === edge.to)) reason = 'INVALID_FLOW_EDGE';
      else if (flow.steps.some(step => step.citations.some(cite => !citationWasRead(cite, ranges))) || flow.edges.some(edge => edge.evidence.some(cite => !citationWasRead(cite, ranges)))) reason = 'UNREAD_FLOW_EVIDENCE';
      else if (flow.edges.some(edge => edge.relation !== 'inferred' && (!edge.evidence.length || !verifyRelation?.(edge, flow)))) reason = 'UNVERIFIED_FLOW_RELATION';
      else if (flow.edges.some(edge => edge.relation === 'inferred') && !flow.gaps.length) reason = 'MISSING_FLOW_GAP';
      if (!reason) { ids.add(flow.id); result.flows.push(flow); }
    }
    if (reason) { result.rejected++; if (!result.reasons.includes(reason)) result.reasons.push(reason); }
  }
  return result;
}
