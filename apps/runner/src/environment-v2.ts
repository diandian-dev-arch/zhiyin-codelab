import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import {
  createCoursePack, CORE_CASE_IDS, hashTaskPack, MEASUREMENT_FIELDS,
  measuredEnvironmentSchema, measurementFingerprintSchema, sha256Schema, sha256,
  type MeasuredEnvironment, type MeasurementFingerprint, type TaskPackManifest,
} from '@codelab/contracts/v2';

const exec = promisify(execFile);
export async function dockerCommand(args: string[], timeout = 5000, maxBuffer = 1024 * 1024) {
  return exec('docker', ['--host=unix:///var/run/docker.sock', ...args], {
    encoding: 'utf8', timeout, maxBuffer, windowsHide: true,
  });
}
export const restrictedContainerArgs = (memory: string) => [
  '--user', '1000:1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
  '--read-only', '--pids-limit', '128', '--cpus', '1',
  '--memory', memory, '--memory-swap', memory,
  '--log-driver', 'local', '--log-opt', 'max-size=1m', '--log-opt', 'max-file=2',
  '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m,uid=1000,gid=1000',
];
export const isolatedNetworkArgs = ['network', 'create', '--internal', '--ipv6=false',
  '--opt', 'com.docker.network.bridge.gateway_mode_ipv4=isolated'];
export function validateIsolatedNetwork(value: any) {
  if (!value || value.Driver !== 'bridge' || value.Internal !== true || value.EnableIPv6 !== false ||
      value.Options?.['com.docker.network.bridge.gateway_mode_ipv4'] !== 'isolated' ||
      !Array.isArray(value.IPAM?.Config) || value.IPAM.Config.length === 0 ||
      value.IPAM.Config.some((c: any) => !c || typeof c.Subnet !== 'string' || !!c.Gateway))
    throw new Error('ISOLATED_NETWORK_REQUIRED');
}
export async function verifyIsolatedNetwork(id: string, timeout = 5000) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('DOCKER_ID_INVALID');
  const value = JSON.parse((await dockerCommand(['network', 'inspect', id], timeout)).stdout)[0];
  if (value?.Id !== id) throw new Error('NETWORK_IDENTITY_MISMATCH');
  validateIsolatedNetwork(value);
}
async function measureIsolatedNetwork() {
  const name = `codelab-network-measure-${randomUUID()}`, label = 'codelab.environment-measure';
  try {
    const id = (await dockerCommand([...isolatedNetworkArgs, '--label', `${label}=${name}`, name], 10000)).stdout.trim();
    await verifyIsolatedNetwork(id);
  } finally {
    let value;
    try { value = JSON.parse((await dockerCommand(['network', 'inspect', name])).stdout)[0]; }
    catch (error) {
      if (!/No such (?:object|network)|network .* not found/i.test(String((error as {stderr?: string}).stderr))) throw error;
    }
    if (value) {
      if (value.Labels?.[label] !== name || !/^[a-f0-9]{64}$/.test(value.Id)) throw new Error('PREFLIGHT_OWNERSHIP_MISMATCH');
      await dockerCommand(['network', 'rm', value.Id]);
    }
  }
}
export type TrustedRunnerEnvironment = {
  pack: TaskPackManifest;
  measurement: MeasuredEnvironment;
  buildImage: string;
  webImage: string;
  browserImage: string;
};
export const restrictedBrowserArgs = (memory: string) => [
  ...restrictedContainerArgs(memory), '--pids-limit', '256', '--security-opt',
  `seccomp=${fileURLToPath(new URL('../../../deploy/executor/seccomp-chromium-userns.json', import.meta.url))}`,
];

/** Preflight launches only immutable trusted image commands, with no mounts or credentials. */
async function measure(image: string, command: string[], browser = false) {
  const name = `codelab-desktop-measure-${randomUUID()}`;
  const label = 'codelab.environment-measure';
  try {
    const result = await dockerCommand(['run', '--rm', '--name', name,
      '--label', `${label}=${name}`, '--network', 'none',
      ...(browser ? restrictedBrowserArgs('768m') : restrictedContainerArgs('768m')), '--entrypoint', 'node', image, ...command], 25000);
    return JSON.parse(result.stdout);
  } finally {
    // A CLI timeout is not proof of absence. Only remove the exact matching ID.
    let container;
    try { container = JSON.parse((await dockerCommand(['container', 'inspect', name])).stdout)[0]; }
    catch (error) {
      if (!/No such (?:object|container)/i.test(String((error as {stderr?: string}).stderr))) throw error;
    }
    if (container) {
      if (container.Config?.Labels?.[label] !== name || !/^[a-f0-9]{64}$/.test(container.Id))
        throw new Error('PREFLIGHT_OWNERSHIP_MISMATCH');
      await dockerCommand(['container', 'rm', '--force', container.Id]);
    }
  }
}
export async function measureRunnerEnvironment(env = process.env): Promise<TrustedRunnerEnvironment> {
  await measureIsolatedNetwork();
  const image = z.string().regex(/^sha256:[a-f0-9]{64}$/);
  const images = z.object({
    RUNNER_BUILD_IMAGE: image, RUNNER_WEB_IMAGE: image, RUNNER_BROWSER_IMAGE: image,
  }).parse(env);
  for (const id of Object.values(images)) {
    const actual = JSON.parse((await dockerCommand(['image', 'inspect', id])).stdout)[0];
    if (actual.Id !== id || actual.Os !== 'linux' || actual.Architecture !== 'amd64')
      throw new Error('EXECUTION_IMAGE_MISMATCH');
  }
  const build = z.object({ templateHash: sha256Schema, dependencyLockHash: sha256Schema,
    buildScriptSha256: sha256Schema }).strict().parse(
      await measure(images.RUNNER_BUILD_IMAGE, ['/opt/measure-build.mjs']));
  const browser = await measure(images.RUNNER_BROWSER_IMAGE, ['/opt/check-v2.mjs', '--measure'], true);
  const implementationHash = sha256Schema.parse(browser.checkerImplementationHash);
  const pack = await createCoursePack({
    packVersion: 'desktop-core-probe-v2-sandbox', templateVersion: 'vue-board-v1',
    templateHash: build.templateHash, dependencyLockHash: build.dependencyLockHash,
    initializationVersion: 'clean-browser-context-v1',
    caseImplementationHashes: Object.fromEntries(CORE_CASE_IDS.map(id => [id, implementationHash])),
    probeImplementationHashes: { FILTER_ORDER_CHECK: implementationHash },
  });
  pack.criteria.push({ criterionId: 'readability', displayCode: 'CK-06', title: '人工可读性',
    mode: 'manual', expectedBehavior: '教师阅读源码与说明，判断命名和职责划分是否清楚。' });
  pack.contentHash = await hashTaskPack(pack);
  const values = measurementFingerprintSchema.partial().parse({
    packManifestHash: pack.contentHash, templateHash: build.templateHash,
    dependencyLockHash: build.dependencyLockHash, initializationVersion: pack.initializationVersion,
    aggregationVersion: pack.aggregationVersion,
    buildImage: { identifierType: 'local_image_id', value: images.RUNNER_BUILD_IMAGE },
    webImage: { identifierType: 'local_image_id', value: images.RUNNER_WEB_IMAGE },
    browserImage: { identifierType: 'local_image_id', value: images.RUNNER_BROWSER_IMAGE },
    playwrightVersion: browser.playwrightVersion, chromiumVersion: browser.browserVersion,
    ...browser.environment, resourceTimeoutConfigVersion: `quota-v4i-${await sha256(await readFile(new URL('../../../deploy/executor/seccomp-chromium-userns.json', import.meta.url)))}`,
  });
  const measurement = measuredEnvironmentSchema.parse({ completeness: 'partial', values,
    missingFields: MEASUREMENT_FIELDS.filter(field => !(field in values)) });
  if (measurement.missingFields.join(',') !== 'ruleHash,parametersHash')
    throw new Error('ENVIRONMENT_MEASUREMENT_INCOMPLETE');
  return { pack, measurement, buildImage: images.RUNNER_BUILD_IMAGE,
    webImage: images.RUNNER_WEB_IMAGE, browserImage: images.RUNNER_BROWSER_IMAGE };
}

export function executionFingerprint(environment: TrustedRunnerEnvironment, ruleHash: string,
  parametersHash: string): MeasurementFingerprint {
  return measurementFingerprintSchema.parse({ ...environment.measurement.values, ruleHash, parametersHash });
}
