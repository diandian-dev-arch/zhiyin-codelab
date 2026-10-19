export type SourceRange = { start: number; end: number };
export type SourceRanges = Record<string, SourceRange[]>;

/** Only complete, actually returned lines enter the citation ledger. No gap is inferred read. */
export class SourceReader {
  readonly ranges: SourceRanges = Object.create(null);
  readonly excerpts: { path: string; source: string }[] = [];
  private remaining: number;
  private tokensRead = 0;
  private tokenReserve = 0;
  constructor(
    private readonly files: Record<string, string>,
    budget = 100_000,
    private readonly tokenBudget?: {
      limit: number;
      count: (text: string) => number;
    },
  ) {
    if (!Number.isSafeInteger(budget) || budget < 0 || budget > 180_000)
      throw new Error("INVALID_SOURCE_BUDGET");
    this.remaining = budget;
    if (
      tokenBudget &&
      (!Number.isSafeInteger(tokenBudget.limit) || tokenBudget.limit < 0)
    )
      throw new Error("INVALID_SOURCE_BUDGET");
  }
  read(path: string, start = 1, count = 180, maxCharacters = 7000) {
    if (!Object.hasOwn(this.files, path))
      throw new Error("INVALID_SOURCE_SELECTION");
    if (
      !Number.isSafeInteger(start) ||
      start < 1 ||
      !Number.isSafeInteger(count) ||
      count < 1 ||
      count > 220 ||
      !Number.isSafeInteger(maxCharacters) ||
      maxCharacters < 0 ||
      maxCharacters > 7000
    )
      throw new Error("INVALID_SOURCE_RANGE");
    const lines = this.files[path].split("\n");
    let source = "",
      end = start - 1;
    for (
      let i = start - 1;
      i < Math.min(lines.length, start - 1 + count);
      i++
    ) {
      const line = `${i + 1}: ${lines[i]}\n`;
      if (
        source.length + line.length > maxCharacters ||
        source.length + line.length > this.remaining
      )
        break;
      source += line;
      end = i + 1;
    }
    if (!source) return undefined;
    let tokens = 0;
    if (this.tokenBudget) {
      const available = Math.max(0, this.remainingTokens - this.tokenReserve);
      const count = (text: string) =>
        this.tokenBudget!.count(JSON.stringify({ path, source: text })) + 1;
      tokens = count(source);
      if (tokens > available) {
        // Keep complete original lines only. Binary search may leave spare tokens;
        // correctness depends on the measured accepted prefix, not monotonic BPE.
        const candidates = source.match(/[^\n]*\n/g)!;
        let low = 0,
          high = candidates.length,
          best = "",
          bestTokens = 0;
        while (low <= high) {
          const n = Math.floor((low + high) / 2),
            candidate = candidates.slice(0, n).join("");
          const cost = count(candidate);
          if (cost <= available) {
            best = candidate;
            bestTokens = cost;
            low = n + 1;
          } else high = n - 1;
        }
        source = best;
        tokens = bestTokens;
        if (!source) return undefined;
        end = start + source.split("\n").length - 2;
      }
      this.tokensRead += tokens;
    }
    this.remaining -= source.length;
    const ranges = [...(this.ranges[path] ?? []), { start, end }].sort(
      (a, b) => a.start - b.start,
    );
    const merged: SourceRange[] = [];
    for (const range of ranges) {
      const last = merged.at(-1);
      if (last && range.start <= last.end + 1)
        last.end = Math.max(last.end, range.end);
      else merged.push({ ...range });
    }
    this.ranges[path] = merged;
    const excerpt = { path, source };
    this.excerpts.push(excerpt);
    return excerpt;
  }
  search(term: string) {
    if (!term.trim() || term.length > 100)
      throw new Error("INVALID_SOURCE_SEARCH");
    const hits: { path: string; line: number; preview: string }[] = [];
    let truncated = false;
    for (const path of Object.keys(this.files).sort()) {
      const lines = this.files[path].split("\n");
      for (let i = 0; i < lines.length; i++)
        if (lines[i].toLowerCase().includes(term.toLowerCase())) {
          if (hits.length >= 30) {
            truncated = true;
            break;
          }
          hits.push({ path, line: i + 1, preview: lines[i].slice(0, 240) });
        }
      if (truncated) break;
    }
    // Search snippets locate files but do not authorize a report citation until read().
    return { term, hits, truncated };
  }
  get remainingCharacters() {
    return this.remaining;
  }
  get remainingTokens() {
    return this.tokenBudget
      ? this.tokenBudget.limit - this.tokensRead
      : Number.MAX_SAFE_INTEGER;
  }
  get estimatedSourceTokens() {
    return this.tokensRead;
  }
  reserveTokens(tokens: number) {
    if (!Number.isSafeInteger(tokens) || tokens < 0)
      throw new Error("INVALID_SOURCE_BUDGET");
    this.tokenReserve = tokens;
  }
}

/** Give every search a turn before taking more matches from an earlier query. */
export function readSearchContexts(
  reader: SourceReader,
  searches: ReturnType<SourceReader["search"]>[],
  options: { maxContexts?: number; reserveCharacters?: number } = {},
) {
  const maxContexts = options.maxContexts ?? 6;
  const queues = searches.map((search) => [...search.hits]);
  const readContexts: { path: string; source: string }[] = [];
  const used = new Set<string>();
  while (readContexts.length < maxContexts) {
    let progressed = false;
    for (const queue of queues) {
      if (readContexts.length >= maxContexts) break;
      while (queue.length) {
        const hit = queue.shift()!;
        if (
          used.has(hit.path) ||
          citationWasRead(
            { path: hit.path, start: hit.line, end: hit.line },
            reader.ranges,
          )
        )
          continue;
        const excerpt = reader.read(
          hit.path,
          Math.max(1, hit.line - 15),
          100,
          Math.max(
            0,
            Math.min(
              3500,
              reader.remainingCharacters - (options.reserveCharacters ?? 0),
            ),
          ),
        );
        if (!excerpt) continue;
        used.add(hit.path);
        readContexts.push(excerpt);
        progressed = true;
        break;
      }
    }
    if (!progressed) break;
  }
  return readContexts;
}

export function citationWasRead(
  cite: SourceRange & { path: string },
  ranges: SourceRanges,
) {
  return (
    Object.hasOwn(ranges, cite.path) &&
    ranges[cite.path].some(
      (r) =>
        cite.start >= r.start && cite.end <= r.end && cite.end >= cite.start,
    )
  );
}
