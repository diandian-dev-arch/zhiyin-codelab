import { z } from 'zod';

const citation = z.object({
  path: z.string().min(1).max(400), start: z.number().int().positive(), end: z.number().int().positive(),
}).refine(value => value.end >= value.start);
const identifier = z.string().min(1).max(80);
export const evidenceFlowSchema = z.object({
  id: identifier, title: z.string().min(1).max(180), summary: z.string().min(1).max(1200),
  steps: z.array(z.object({
    id: identifier, title: z.string().min(1).max(180), responsibility: z.string().min(1).max(800),
    symbol: z.string().min(1).max(180).optional(), input: z.string().max(500).optional(), output: z.string().max(500).optional(),
    citations: z.array(citation).min(1).max(6),
  })).min(3).max(8),
  edges: z.array(z.object({
    from: identifier, to: identifier, relation: z.enum(['call', 'data', 'inferred']),
    evidence: z.array(citation).max(6), explanation: z.string().min(1).max(800),
  })).max(16),
  gaps: z.array(z.string().min(1).max(600)).max(12),
});
