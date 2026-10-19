import assert from 'node:assert/strict';
import { execFile, fork } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DurableRunnerStore, type OwnerIdentity } from '../apps/runner/src/durable-store.js';
import { DockerResourceAdapter } from '../apps/runner/src/docker-resources.js';
import { reapOwner, inspectReadiness } from '../apps/runner/src/resource-reaper.js';

const exec = promisify(execFile);
const docker = async (args: string[]) => (await exec('docker', args, {
  windowsHide: true, timeout: 180000, maxBuffer: 1024 * 1024,
})).stdout.trim();
const file = fileURLToPath(import.meta.url);

if (process.argv[2] === 'child') {
  // A pending Promise alone does not keep Node alive at the removal barrier.
  const keepAlive = setInterval(() => {}, 1000);
  process.once('message', async (input: { root: string; owner: OwnerIdentity }) => {
    const store = await DurableRunnerStore.open(input.root);
    class InterruptedRemoval extends DockerResourceAdapter {
      override async remove(kind: 'container' | 'network', id: string) {
        await super.remove(kind, id);
        process.send?.({ state: 'removed', id });
        await new Promise<never>(() => {});
      }
    }
    try { await reapOwner(store, new InterruptedRemoval(), input.owner); }
    catch { process.send?.({ state: 'failed' }); clearInterval(keepAlive); process.exitCode = 1; }
  });
} else if (process.argv[2] === 'linux') {
  const verificationId = process.env.REAPER_VERIFICATION_ID!;
  assert.match(verificationId, /^[a-f0-9-]{36}$/);
  const image = process.env.REAPER_VERIFICATION_IMAGE!;
  assert.match(image, /^sha256:[a-f0-9]{64}$/);
  const results: unknown[] = [];
  const registration = () => {
    const now = Date.now();
    return { owner: { runId: randomUUID(), ownerId: randomUUID(), ownerKind: 'execution' as const, ownerToken: randomUUID() },
      startedAt: new Date(now).toISOString(), workDeadlineAt: new Date(now + 270000).toISOString(),
      hardDeadlineAt: new Date(now + 300000).toISOString(), leaseUntil: new Date(now + 30000).toISOString(), remainingWorkMs: 270000 };
  };
  for (const scenario of ['network-in-use', 'killed-after-removal'] as const) {
    const root = `/verification/${scenario}`;
    const store = await DurableRunnerStore.open(root);
    const input = registration(), operationId = randomUUID();
    await store.registerOwner(input);
    await store.reserveOperation(input.owner, { operationId, requestHash: 'a'.repeat(64), kind: 'execute' });
    const token = (await store.beginOperation(input.owner, operationId)).dispatchToken!;
    await store.ensureWorkspace(input.owner, operationId, token);
    const kind = scenario === 'network-in-use' ? 'network' : 'container';
    const role = kind === 'network' ? 'network' : 'build';
    const planned = await store.planResource(input.owner, operationId, token, kind, role);
    await store.markResourceCreateStarted(input.owner, operationId, token, role);
    const labels = Object.entries({ ...planned.labels, 'codelab.verification': verificationId }).flatMap(([key, value]) => ['--label', `${key}=${value}`]);
    const resourceId = await docker(kind === 'network'
      ? ['network', 'create', '--internal', ...labels, planned.name]
      : ['run', '-d', '--name', planned.name, ...labels, '--network', 'none', '--memory', '64m', '--pids-limit', '32',
        '--entrypoint', 'node', image, '-e', 'setInterval(()=>{},1000)']);
    await store.recordResourceCreated(input.owner, operationId, token, role, resourceId);
    // Production completed action: no live producer is permitted to create new resources.
    await store.finishOperation(input.owner, operationId, token, 'completed', { syntheticSetup: true });
    let blocker: string | undefined;
    if (scenario === 'network-in-use') {
      blocker = await docker(['run', '-d', '--name', `codelab-reaper-blocker-${verificationId}`, '--label', `codelab.verification=${verificationId}`,
        '--network', planned.name, '--memory', '64m', '--pids-limit', '32', '--entrypoint', 'node', image, '-e', 'setInterval(()=>{},1000)']);
      const pending = await reapOwner(store, new DockerResourceAdapter(), input.owner);
      assert.equal(pending.state, 'cleanup_pending');
      assert.ok(pending.residualResourceIds.includes(`network:${resourceId}`));
      assert.equal((await inspectReadiness(store, new DockerResourceAdapter())).state, 'cleanup_pending');
      await assert.rejects(store.registerOwner(registration()), { code: 'RUNNER_BUSY' });
      assert.ok(await new DockerResourceAdapter().inspect('network', resourceId));
      // The foreign endpoint is owned by this verification, not by the reaper owner.
      assert.equal(await docker(['inspect', '--format', '{{index .Config.Labels "codelab.verification"}}', blocker]), verificationId);
      await docker(['rm', '--force', blocker]);
      results.push({ scenario, beforeRecovery: pending, foreignEndpointPreserved: true, admissionBlocked: true });
    } else {
      const child = fork(file, ['child'], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      const exited = once(child, 'exit');
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const message = once(child, 'message');
        child.send({ root, owner: input.owner });
        const [value] = await Promise.race([message, exited.then(() => { throw new Error('REAPER_EXITED_EARLY'); }),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('REAPER_BARRIER_TIMEOUT')), 20000); })]);
        assert.deepEqual(value, { state: 'removed', id: resourceId });
        assert.equal(await new DockerResourceAdapter().inspect(kind, resourceId), null);
        assert.notEqual((await store.inspect()).owners[0].phase, 'clean');
        assert.equal(child.kill('SIGKILL'), true);
        const [, signal] = await exited;
        assert.equal(signal, 'SIGKILL');
        await assert.rejects(store.registerOwner(registration()), { code: 'RUNNER_BUSY' });
        results.push({ scenario, resourceAbsentBeforeReceipt: true, signal, admissionBlocked: true });
      } finally {
        clearTimeout(timer);
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await exited;
      }
    }
    const reopened = await DurableRunnerStore.open(root);
    const receipt = await reapOwner(reopened, new DockerResourceAdapter(), input.owner);
    assert.equal(receipt.state, 'clean');
    assert.deepEqual(receipt.residualResourceIds, []);
    assert.equal(await new DockerResourceAdapter().inspect(kind, resourceId), null);
    assert.deepEqual(await reapOwner(reopened, new DockerResourceAdapter(), input.owner), receipt);
    assert.equal((await inspectReadiness(reopened, new DockerResourceAdapter())).state, 'ready');
    const next = registration();
    await reopened.registerOwner(next);
    assert.equal((await reapOwner(reopened, new DockerResourceAdapter(), next.owner)).state, 'clean');
    results.push({ scenario, finalReceipt: receipt, repeatedReceiptIdentical: true, nextOwnerAdmitted: true });
  }
  await writeFile('/verification/result.json', JSON.stringify({ state: 'passed', environment: 'Docker Desktop Linux control image', results }, null, 2));
  console.log('REAPER_FAULTS_PASSED');
} else {
  const id = randomUUID(), name = `codelab-reaper-verification-${id}`;
  const root = path.resolve('.data/reaper-verification', id);
  await mkdir(root, { recursive: true });
  const image = await docker(['inspect', '--format', '{{.Image}}', 'codelab-desktop-control']);
  assert.match(image, /^sha256:[a-f0-9]{64}$/);
  const hashes = await Promise.all(['scripts/verify-reaper-faults.ts', 'apps/runner/src/durable-store.ts',
    'apps/runner/src/resource-reaper.ts', 'apps/runner/src/docker-resources.ts'].map(async source => ({ source,
      sha256: createHash('sha256').update(await readFile(source)).digest('hex') })));
  let passed = false;
  try {
    const mounts = [[file, '/app/scripts/verify-reaper-faults.ts'], [path.resolve('apps/runner/src'), '/app/apps/runner/src'],
      [path.resolve('packages/contracts/src'), '/app/packages/contracts/src']].flatMap(([source, target]) => ['--mount', `type=bind,source=${source},target=${target},readonly`]);
    const output = await docker(['run', '--name', name, '--label', `codelab.verification=${id}`, '--network', 'none',
      '--memory', '384m', '--cpus', '1', '--pids-limit', '128', ...mounts,
      '--mount', `type=bind,source=${root},target=/verification`, '-v', '/var/run/docker.sock:/var/run/docker.sock',
      '-e', `REAPER_VERIFICATION_ID=${id}`, '-e', `REAPER_VERIFICATION_IMAGE=${image}`,
      '--entrypoint', 'node', image, '--import', 'tsx', '/app/scripts/verify-reaper-faults.ts', 'linux']);
    assert.equal(output, 'REAPER_FAULTS_PASSED');
    passed = true;
  } catch (error) {
    const diagnostic = error as { stderr?: string; stdout?: string; message?: string };
    await writeFile(path.join(root, 'failure.txt'), diagnostic.stderr ?? diagnostic.message ?? 'Unknown failure');
    console.error('REAPER_FAULTS_FAILED: private diagnostic result retained; no raw command output printed'); process.exitCode = 1;
  }
  finally {
    // All fallback targets must carry this exact run's label; never global prune.
    for (const kind of ['container', 'network'] as const) {
      const ids = (await docker(kind === 'container'
        ? ['ps', '-aq', '--no-trunc', '--filter', `label=codelab.verification=${id}`]
        : ['network', 'ls', '-q', '--no-trunc', '--filter', `label=codelab.verification=${id}`])).split(/\s+/).filter(Boolean);
      for (const resourceId of ids) {
        assert.match(resourceId, /^[a-f0-9]{64}$/);
        const actual = await docker([kind, 'inspect', '--format', kind === 'container'
          ? '{{index .Config.Labels "codelab.verification"}}' : '{{index .Labels "codelab.verification"}}', resourceId]);
        assert.equal(actual, id);
        await docker(kind === 'container' ? ['rm', '--force', resourceId] : ['network', 'rm', resourceId]);
      }
      assert.equal(await docker(kind === 'container'
        ? ['ps', '-aq', '--no-trunc', '--filter', `label=codelab.verification=${id}`]
        : ['network', 'ls', '-q', '--no-trunc', '--filter', `label=codelab.verification=${id}`]), '', 'VERIFICATION_RESOURCES_REMAIN');
    }
    await writeFile(path.join(root, 'host-result.json'), JSON.stringify({ passed, image, hashes, cleanup: 'removed-own-labelled-resources', finishedAt: new Date().toISOString() }, null, 2));
    console.log(JSON.stringify({ passed, resultDirectory: root, cleanup: 'removed-own-labelled-resources' }));
  }
}
