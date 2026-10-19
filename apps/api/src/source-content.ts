import { z } from 'zod';

export const sourceContentQuery = z.object({
  path: z.string().min(1).max(400),
  analysisId: z.string().uuid().optional(),
  start: z.coerce.number().int().positive().safe().optional(),
  end: z.coerce.number().int().positive().safe().optional(),
}).strict().refine(q => (q.start === undefined && q.end === undefined) ||
  (q.start !== undefined && q.end !== undefined && q.end >= q.start), '无效的源码行段');

export function sourceContent(content: string, query: { start?: number; end?: number }) {
  const lines = content.split('\n');
  if (query.start === undefined) return { content, startLine: 1, totalLines: lines.length };
  return { content: lines.slice(query.start - 1, query.end).join('\n'), startLine: query.start, totalLines: lines.length };
}
