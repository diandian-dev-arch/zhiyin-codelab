import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export function assertWorkspaceRuntime(version = process.versions.node, platform = process.platform) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error('WORKSPACE_NODE_VERSION_INVALID');
  const major = Number(match[1]), minor = Number(match[2]);
  if (major < 22 || (major === 22 && minor < 14)) throw new Error('WORKSPACE_NODE_TOO_OLD');
  // Node's Windows libuv OSVERSIONINFOW initialization fix landed in 24.16.
  // This is a known-defect exclusion, not a claim about every historical crash.
  if (platform === 'win32' && major === 24 && minor < 16)
    throw new Error('WORKSPACE_NODE_WINDOWS_PATCH_REQUIRED');
}

export async function selectWorkspaceRuntime(root: string, override = process.env.CODELAB_NODE_EXECUTABLE) {
  let executable = override || undefined;
  if (!executable) {
    try {
      const config = JSON.parse(await readFile(path.join(root, '.data/workspace-runtime.json'), 'utf8'));
      if (typeof config.executable !== 'string' || !config.executable) throw new Error('INVALID');
      executable = config.executable;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('WORKSPACE_RUNTIME_CONFIG_INVALID');
    }
  }
  executable ??= process.execPath;
  if (!path.isAbsolute(executable)) throw new Error('WORKSPACE_NODE_ABSOLUTE_PATH_REQUIRED');
  return executable;
}

export async function inspectWorkspaceRuntime(executable: string) {
  let metadata: { node: string; uv: string; executable: string; platform: NodeJS.Platform };
  try {
    const { stdout } = await promisify(execFile)(executable, ['-p',
      'JSON.stringify({node:process.versions.node,uv:process.versions.uv,executable:process.execPath,platform:process.platform})'], {
      windowsHide: true, timeout: 10_000, maxBuffer: 4096,
      // Do not pass API keys or inherited Node preload flags to the probe.
      env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, TMP: process.env.TMP },
    });
    metadata = JSON.parse(stdout);
    if (typeof metadata.node !== 'string' || typeof metadata.uv !== 'string' ||
        !path.isAbsolute(metadata.executable) || metadata.platform !== process.platform) throw new Error('INVALID');
  } catch { throw new Error('WORKSPACE_NODE_PROBE_FAILED'); }
  assertWorkspaceRuntime(metadata.node, metadata.platform);
  return metadata;
}
