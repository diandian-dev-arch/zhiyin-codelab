import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertWorkspaceRuntime, inspectWorkspaceRuntime, selectWorkspaceRuntime } from '../scripts/workspace-runtime.js';

it('excludes affected Windows Node 24 builds without rejecting other supported platforms', () => {
  for (const version of ['24.0.0', '24.15.0'])
    expect(() => assertWorkspaceRuntime(version, 'win32')).toThrow('WORKSPACE_NODE_WINDOWS_PATCH_REQUIRED');
  for (const version of ['24.16.0', '24.19.0', '22.14.0'])
    expect(() => assertWorkspaceRuntime(version, 'win32')).not.toThrow();
  expect(() => assertWorkspaceRuntime('24.15.0', 'linux')).not.toThrow();
  expect(() => assertWorkspaceRuntime('22.13.1', 'linux')).toThrow('WORKSPACE_NODE_TOO_OLD');
  expect(() => assertWorkspaceRuntime('24.19.0-custom', 'win32')).toThrow('WORKSPACE_NODE_VERSION_INVALID');
});

it('selects project runtime and never falls back from broken configuration', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codelab-runtime-'));
  try {
    expect(await selectWorkspaceRuntime(root, '')).toBe(process.execPath);
    await mkdir(path.join(root, '.data'));
    const file = path.join(root, '.data/workspace-runtime.json');
    const selected = path.join(root, 'node with spaces', 'node.exe');
    await writeFile(file, JSON.stringify({ executable: selected }));
    expect(await selectWorkspaceRuntime(root, '')).toBe(selected);
    expect(await selectWorkspaceRuntime(root, process.execPath)).toBe(process.execPath);
    await writeFile(file, '{invalid');
    await expect(selectWorkspaceRuntime(root, '')).rejects.toThrow('WORKSPACE_RUNTIME_CONFIG_INVALID');
    expect(await selectWorkspaceRuntime(root, process.execPath)).toBe(process.execPath);
    await expect(selectWorkspaceRuntime(root, 'relative-node')).rejects.toThrow('WORKSPACE_NODE_ABSOLUTE_PATH_REQUIRED');
    await expect(inspectWorkspaceRuntime(path.join(root, 'missing-node.exe'))).rejects.toThrow('WORKSPACE_NODE_PROBE_FAILED');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('probes the real executable version rather than trusting its filename', async () => {
  let rejected = false;
  try { assertWorkspaceRuntime(); } catch { rejected = true; }
  if (rejected) {
    await expect(inspectWorkspaceRuntime(process.execPath)).rejects.toThrow('WORKSPACE_NODE_WINDOWS_PATCH_REQUIRED');
  } else {
    expect(await inspectWorkspaceRuntime(process.execPath)).toMatchObject({
      node: process.versions.node, uv: process.versions.uv, platform: process.platform,
    });
  }
});
