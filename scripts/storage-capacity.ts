import { lstat, opendir, statfs } from 'node:fs/promises';
import path from 'node:path';

export type CapacityPolicy = { warningFreeBytes: number; criticalFreeBytes: number; warningUsedRatio: number; criticalUsedRatio: number };
export const defaultCapacityPolicy: CapacityPolicy = {
  warningFreeBytes: 10 * 1024 ** 3, criticalFreeBytes: 2 * 1024 ** 3,
  warningUsedRatio: 0.85, criticalUsedRatio: 0.95,
};
export function capacityLevel(total: number, available: number, policy = defaultCapacityPolicy) {
  if (![total, available].every(Number.isSafeInteger) || total <= 0 || available < 0 || available > total)
    throw new Error('INVALID_CAPACITY_MEASUREMENT');
  const usedRatio = 1 - available / total;
  return available <= policy.criticalFreeBytes || usedRatio >= policy.criticalUsedRatio ? 'critical'
    : available <= policy.warningFreeBytes || usedRatio >= policy.warningUsedRatio ? 'warning' : 'ok';
}

/** Metadata only, never follows symlinks, never deletes. Incomplete scans cannot be healthy. */
export async function inspectDirectory(directory: string, maxEntries = 100000, deadlineMs = 10000) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || !Number.isFinite(deadlineMs) || deadlineMs < 1)
    throw new Error('INVALID_SCAN_BUDGET');
  const started = Date.now(), root = path.resolve(directory);
  let entries = 0, files = 0, logicalBytes = 0, skippedLinks = 0;
  const issues = new Set<string>();
  const pending = [root];
  try {
    const metadata = await lstat(root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('UNSAFE_SCAN_ROOT');
    while (pending.length) {
      if (Date.now() - started >= deadlineMs) { issues.add('DEADLINE'); break; }
      const current = pending.pop()!;
      // Recheck before traversal; this is an operator snapshot of service-owned
      // directories, not a race-proof filesystem authorization boundary.
      const info = await lstat(current);
      if (info.isSymbolicLink()) { skippedLinks++; continue; }
      if (!info.isDirectory()) { issues.add('DIRECTORY_CHANGED'); continue; }
      for await (const entry of await opendir(current)) {
        if (++entries > maxEntries || Date.now() - started >= deadlineMs) {
          issues.add(entries > maxEntries ? 'ENTRY_LIMIT' : 'DEADLINE'); pending.length = 0; break;
        }
        const item = path.join(current, entry.name);
        const stat = await lstat(item);
        if (stat.isSymbolicLink()) skippedLinks++;
        else if (stat.isDirectory()) pending.push(item);
        else if (stat.isFile()) { files++; logicalBytes += stat.size; }
        else issues.add('SPECIAL_FILE');
      }
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    issues.add(code === 'ENOENT' ? 'PATH_MISSING_OR_CHANGED' : 'SCAN_FAILED');
  }
  if (skippedLinks) issues.add('LINKS_SKIPPED');
  let filesystem: { totalBytes: number; availableBytes: number; level: string } | undefined;
  try {
    const stat = await statfs(root);
    const totalBytes = stat.blocks * stat.bsize, availableBytes = stat.bavail * stat.bsize;
    filesystem = { totalBytes, availableBytes, level: capacityLevel(totalBytes, availableBytes) };
  } catch { issues.add('FILESYSTEM_MEASUREMENT_FAILED'); }
  return { files, entries, logicalBytes, skippedLinks, complete: issues.size === 0,
    issues: [...issues], filesystem, elapsedMs: Date.now() - started };
}
