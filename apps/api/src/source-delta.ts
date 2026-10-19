/** Compare retained, redacted source only. Never infer renames or reuse old citations. */
export function sourceDelta(before: Record<string,string>, after: Record<string,string>) {
  const added = Object.keys(after).filter(p=>!Object.hasOwn(before,p)).sort();
  const modified = Object.keys(after).filter(p=>Object.hasOwn(before,p) && before[p]!==after[p]).sort();
  const removed = Object.keys(before).filter(p=>!Object.hasOwn(after,p)).sort();
  return {added,modified,removed,unchanged:Object.keys(after).length-added.length-modified.length};
}
