import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, writeFile, open, lstat, realpath, chown } from 'node:fs/promises';
import path from 'node:path';
import { transferOutput } from './output-transfer-v2.js';
import {
  CORE_CASE_IDS, canonicalJson, createSourceManifest, createArtifactManifest, validateRunResponse,
  validateSourceFiles, sha256, LIMITS_V1, validateRelativePath,
  type RunnerExecuteRequest, type RunnerExecuteResponse, type CaseResult,
  type Evidence, type ArtifactPayload,
} from '@codelab/contracts/v2';
import { DurableRunnerStore, type OwnerIdentity, type PlannedResource } from './durable-store.js';
import { dockerCommand, executionFingerprint, restrictedContainerArgs, restrictedBrowserArgs, isolatedNetworkArgs, verifyIsolatedNetwork,
  type TrustedRunnerEnvironment } from './environment-v2.js';

export class AmbiguousDockerDispatch extends Error {}
class ExecutionFailure extends Error {
  constructor(readonly reason: string, readonly stage: 'build' | 'page_service' | 'base_checks' | 'prepare',
    readonly buildError = false) { super(reason); }
}
const ownerFor = (request: RunnerExecuteRequest): OwnerIdentity => ({
  runId: request.context.runId, ownerKind: 'execution', ownerId: request.context.executionAttemptId,
  ownerToken: request.ownerToken,
});
const labelArgs = (plan: PlannedResource) => Object.entries(plan.labels).flatMap(([key,value]) => ['--label', `${key}=${value}`]);

/** Bounded, non-following reads; container-produced paths are never trusted as host paths. */
export async function readArtifact(directory: string, filename: string, maximum: number) {
  validateRelativePath(filename);
  if (filename.includes('/')) throw new Error('ARTIFACT_FILENAME_INVALID');
  const target = path.join(directory, filename), stat = await lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum ||
      await realpath(target) !== path.join(await realpath(directory), filename))
    throw new Error('ARTIFACT_FILE_INVALID');
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const actual = await handle.stat();
    if (!actual.isFile() || actual.size !== stat.size) throw new Error('ARTIFACT_FILE_CHANGED');
    const bytes = Buffer.alloc(actual.size);
    let offset = 0;
    while (offset < bytes.length) {
      const chunk = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!chunk.bytesRead) throw new Error('ARTIFACT_FILE_CHANGED');
      offset += chunk.bytesRead;
    }
    if ((await handle.stat()).size !== actual.size) throw new Error('ARTIFACT_FILE_CHANGED');
    return bytes;
  } finally { await handle.close(); }
}

export async function executeV2(store: DurableRunnerStore, environment: TrustedRunnerEnvironment,
  volumeName: string, request: RunnerExecuteRequest, dispatchToken: string): Promise<RunnerExecuteResponse> {
  if (!/^codelab-[a-z0-9][a-z0-9_-]{0,80}$/.test(volumeName)) throw new Error('RUNNER_VOLUME_INVALID');
  const owner = ownerFor(request);
  const actual = executionFingerprint(environment, request.context.ruleHash, request.ruleSnapshot.parametersHash);
  // Approval never supplies measured values. All observed runtime fields came from immutable images.
  if (canonicalJson(actual) !== canonicalJson(request.approvedFingerprint))
    throw new ExecutionFailure('ACTUAL_ENVIRONMENT_MISMATCH', 'prepare');
  if (request.ruleSnapshot.packManifestHash !== environment.pack.contentHash ||
      !request.ruleSnapshot.requiredCaseIds.length ||
      request.ruleSnapshot.requiredCaseIds.some(id => !(CORE_CASE_IDS as readonly string[]).includes(id)))
    throw new ExecutionFailure('UNSUPPORTED_EXECUTION_PACK', 'prepare');

  const manifestId = randomUUID(), evidence: Evidence[] = [], artifacts: ArtifactPayload[] = [];
  const timings: RunnerExecuteResponse['timings'] = [];
  let outcome: RunnerExecuteResponse['outcome'] = 'complete';
  let caseResults: CaseResult[] = [];
  let sourceHash: string | null = null;
  let failure: ExecutionFailure | null = null;
  let workspace: string | undefined;
  const clock = () => Math.floor(store.now());
  const deadline = Math.min(Date.parse(request.workDeadlineAt), clock() + request.remainingWorkMs);
  const budget = (max: number) => {
    const remaining = Math.floor(deadline - clock());
    if (remaining <= 0) throw new ExecutionFailure('TIME_BUDGET', 'prepare');
    return Math.min(max, remaining);
  };
  const timed = async <T>(stage: RunnerExecuteResponse['timings'][number]['stage'], action: () => Promise<T>) => {
    const start = clock();
    try { return await action(); }
    catch(error) {
      if(error instanceof Error && error.message==='OUTPUT_TIME_BUDGET')throw new ExecutionFailure('TIME_BUDGET',stage as ExecutionFailure['stage']);
      throw error;
    }
    finally { timings.push({ stage, startedAt: new Date(start).toISOString(),
      finishedAt: new Date(clock()).toISOString(), durationMs: Math.max(0, clock() - start) }); }
  };
  const addEvidence = async (bytes: Buffer, options: {
    caseId?: string; phase: Evidence['phase']; contentOrigin: Evidence['contentOrigin'];
    mediaType: Evidence['mediaType']; capturedAt?: string;
  }) => {
    const evidenceId = randomUUID(), context = request.context;
    const extension = options.mediaType === 'image/png' ? 'png' : options.mediaType === 'application/json' ? 'json' : 'txt';
    evidence.push({ evidenceId, manifestId, runId: context.runId, submissionId: context.submissionId,
      originalZipSha256: context.originalZipSha256, sourceManifestSha256: context.sourceManifestSha256,
      executionAttemptId: context.executionAttemptId, analysisAttemptId: null, operationId: null,
      scope: options.caseId ? 'case' : 'run', criterionId: options.caseId
        ? request.ruleSnapshot.packManifest.cases.find(entry => entry.caseId === options.caseId)!.criterionId : null,
      caseId: options.caseId ?? null, phase: options.phase, collector: 'runner', contentOrigin: options.contentOrigin,
      ruleHash: context.ruleHash, packManifestHash: context.packManifestHash, sha256: await sha256(bytes),
      byteSize: bytes.length, mediaType: options.mediaType,
      storageKey: `runs/${context.runId}/${manifestId}/${evidenceId}.${extension}`,
      capturedAt: options.capturedAt ?? new Date().toISOString() });
    artifacts.push({ evidenceId, encoding: 'base64', data: bytes.toString('base64') });
    return evidenceId;
  };
  const plan = (kind: PlannedResource['kind'], role: PlannedResource['role']) =>
    store.planResource(owner, request.operationId, dispatchToken, kind, role);
  const create = async (resource: PlannedResource, args: string[]) => {
    // Exhaustion before dispatch is known; only an attempted Docker create is ambiguous.
    const timeout = budget(10000);
    await store.markResourceCreateStarted(owner, request.operationId, dispatchToken, resource.role);
    try {
      const command = resource.kind === 'network' ? isolatedNetworkArgs : ['container','create'];
      const result = await dockerCommand([...command, ...labelArgs(resource), ...args], timeout);
      const id = result.stdout.trim();
      if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('DOCKER_ID_INVALID');
      await store.recordResourceCreated(owner, request.operationId, dispatchToken, resource.role, id);
      return id;
    } catch (error) {
      // A timeout/transport failure may have reached Docker. Do not issue another create.
      // The HTTP service exits so the independent reaper can prove this producer is gone.
      throw new AmbiguousDockerDispatch('DOCKER_CREATE_OUTCOME_UNKNOWN');
    }
  };
  const mount = (directory: string, target: string, readOnly = false) => [
    '--mount', `type=volume,source=${volumeName},volume-subpath=resources/execution-${owner.ownerId}/${directory},target=${target}${readOnly ? ',readonly' : ''}`,
  ];
  const waitForExit = async (id: string, max: number, stage: ExecutionFailure['stage']) => {
    try {
      const output = (await dockerCommand(['wait', id], budget(max))).stdout.trim();
      if (!/^\d+$/.test(output)) throw new Error('INVALID_EXIT_STATUS');
      const state = JSON.parse((await dockerCommand(['inspect', '--format', '{{json .State}}', id])).stdout);
      if (state.OOMKilled) throw new ExecutionFailure('RESOURCE_LIMIT', stage);
      return Number(output);
    } catch (error) {
      if (error instanceof ExecutionFailure) throw error;
      throw new ExecutionFailure('TIME_BUDGET', stage);
    }
  };

  try {
    await timed('prepare', async () => {
      workspace = await store.ensureWorkspace(owner, request.operationId, dispatchToken);
      await writeFile(path.join(workspace, 'execution-context.json'), JSON.stringify({
        rule: request.ruleSnapshot, context: request.context,
      }), { flag: 'wx', mode: 0o400 });
      for (const subdir of ['submission', 'out', 'artifacts']) {
        const target = path.join(workspace, subdir);
        await mkdir(target, { mode: 0o755 });
        await chown(target, 1000, 1000);
      }
      const { decodedFiles } = validateSourceFiles(request.files);
      const materialized: Record<string,string> = {};
      for (const [name, bytes] of Object.entries(decodedFiles)) {
        const target = path.join(workspace, 'submission', name);
        await mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
        await writeFile(target, bytes, { flag: 'wx', mode: 0o444 });
        materialized[name] = (await open(target, 'r').then(async handle => {
          try { return await handle.readFile(); } finally { await handle.close(); }
        })).toString('base64');
      }
      sourceHash = (await createSourceManifest(materialized)).sourceManifestSha256;
      if (sourceHash !== request.context.sourceManifestSha256) throw new Error('SOURCE_MATERIALIZATION_MISMATCH');
    });
    await timed('build', async () => {
      const resource = await plan('container', 'build');
      const id = await create(resource, ['--name', resource.name, '--network', 'none',
        ...restrictedContainerArgs('1024m'), '--tmpfs', '/workspace:rw,nosuid,nodev,size=256m,uid=1000,gid=1000',
        ...mount('submission','/submission',true), '--tmpfs','/out:rw,nosuid,nodev,noexec,size=64m,uid=1000,gid=1000',
        '--entrypoint','node',environment.buildImage,'/opt/export-output.mjs','build']);
      const exported = await transferOutput(id,path.join(workspace!,'out'),'build',budget(90000));
      const code=exported.code;
      const state=JSON.parse((await dockerCommand(['inspect','--format','{{json .State}}',id])).stdout);
      if(state.OOMKilled)throw new ExecutionFailure('RESOURCE_LIMIT','build');
      const log=Buffer.from(new TextDecoder('utf-8').decode(Buffer.from(exported.log || '(构建进程没有输出)').subarray(0,LIMITS_V1.textEvidenceMaxBytes-100),{stream:true}));
      await addEvidence(log, { phase: 'build', contentOrigin: 'student_console', mediaType: 'text/plain; charset=utf-8' });
      if(exported.error || /ENOSPC|No space left on device/.test(exported.log)) throw new ExecutionFailure('RESOURCE_LIMIT','build');
      if (code !== 0) throw new ExecutionFailure('BUILD_ERROR','build',true);
    });
    let network: string, web: string;
    await timed('page_service', async () => {
      const networkPlan = await plan('network','network');
      network = await create(networkPlan, [networkPlan.name]);
      await verifyIsolatedNetwork(network, budget(5000));
      const resource = await plan('container','web');
      web = await create(resource, ['--name',resource.name,'--network',network,'--network-alias','project',
        ...restrictedContainerArgs('128m'), ...mount('out','/site',true), environment.webImage]);
      await dockerCommand(['start',web], budget(5000));
      await dockerCommand(['exec',web,'node','-e',
        "const end=Date.now()+5000;async function check(){while(Date.now()<end){try{let r=await fetch('http://127.0.0.1:8080');if(r.status===200)return;}catch{}await new Promise(r=>setTimeout(r,100));}process.exit(1)}check()"], budget(7000));
    });
    await timed('base_checks', async () => {
      const requestFile = path.join(workspace!, 'artifacts', 'check-request.json');
      await writeFile(requestFile, JSON.stringify({
        caseDefinitions: request.ruleSnapshot.packManifest.cases.filter(c => request.ruleSnapshot.requiredCaseIds.includes(c.caseId)),
        parameterValues: request.ruleSnapshot.parameterValues, remainingWorkMs: budget(75000),
      }), { flag: 'wx', mode: 0o444 });
      const resource = await plan('container','check');
      const id = await create(resource, ['--name',resource.name,'--network',network!,
        ...restrictedBrowserArgs('1536m'), '--shm-size','256m', ...mount('artifacts','/input',true),
        '--tmpfs','/artifacts:rw,nosuid,nodev,noexec,size=32m,uid=1000,gid=1000',
        environment.browserImage,'node','/opt/export-output.mjs','check']);
      const {code} = await transferOutput(id,path.join(workspace!,'artifacts'),'check',budget(90000));
      if (code !== 0) throw new ExecutionFailure('CHECKER_PROCESS_FAILED','base_checks');
      const output = JSON.parse((await readArtifact(path.join(workspace!, 'artifacts'), 'check-result.json', 1024*1024)).toString('utf8'));
      if (output.checkerImplementationHash !== environment.pack.cases[0].implementationHash ||
        output.browserVersion !== actual.chromiumVersion || output.playwrightVersion !== actual.playwrightVersion ||
        ['viewport','locale','timezone','clockPolicy','randomPolicy','pageServerPolicy'].some(key =>
          canonicalJson(output.environment?.[key]) !== canonicalJson(actual[key as keyof typeof actual])))
        throw new ExecutionFailure('ACTUAL_ENVIRONMENT_MISMATCH','base_checks');
      if (!Array.isArray(output.files) || output.files.length > 30 || !Array.isArray(output.caseResults))
        throw new Error('CHECKER_OUTPUT_INVALID');
      const fileIds = new Map<string,string>();
      for (const file of output.files) {
        if (!request.ruleSnapshot.requiredCaseIds.includes(file.caseId) || fileIds.has(file.filename)) throw new Error('CHECKER_FILE_SCOPE_INVALID');
        const bytes = await readArtifact(path.join(workspace!, 'artifacts'), file.filename,
          file.mediaType === 'image/png' ? LIMITS_V1.pngMaxBytes : LIMITS_V1.textEvidenceMaxBytes);
        fileIds.set(file.filename, await addEvidence(bytes, { ...file, phase: 'base' }));
      }
      const mapRefs = (ids: string[]) => ids.map(id => {
        const mapped = fileIds.get(id);
        if (!mapped) throw new Error('CHECKER_REFERENCE_INVALID');
        return mapped;
      });
      caseResults = output.caseResults.map((result: CaseResult) => ({ ...result,
        evidenceIds: mapRefs(result.evidenceIds), executedSteps: result.executedSteps.map(step => ({
          ...step, evidenceIds: mapRefs(step.evidenceIds),
        })),
      }));
    });
  } catch (error) {
    if (error instanceof AmbiguousDockerDispatch) throw error;
    failure = error instanceof ExecutionFailure ? error : new ExecutionFailure('INFRA_ERROR','prepare');
    outcome = failure.buildError ? 'build_error' : failure.reason === 'TIME_BUDGET' ? 'interrupted' : 'infra_error';
    await addEvidence(Buffer.from(JSON.stringify({ reasonCode: failure.reason, stage: failure.stage })), {
      phase: 'diagnostic', contentOrigin: 'platform_diagnostic', mediaType: 'application/json',
    });
    caseResults = request.ruleSnapshot.packManifest.cases.filter(c => request.ruleSnapshot.requiredCaseIds.includes(c.caseId)).map(c => ({
      criterionId: c.criterionId, caseId: c.caseId, verdict: 'not_run', preconditionStatus: 'blocked',
      reasonCode: failure!.reason, expected: c.expected, observed: `本次运行在 ${failure!.stage} 阶段停止：${failure!.reason}。未确认该功能结果。`,
      executedSteps: [], unexecutedStepIds: c.plannedSteps.map(step => step.stepId),
      blockedBy: [{ kind: 'execution_stage', id: failure!.stage, reasonCode: failure!.reason }],
      evidenceIds: evidence.filter(item => item.scope === 'run').map(item => item.evidenceId),
    }));
  }
  const baseManifest = await createArtifactManifest({ manifestId, context: request.context, source: 'base',
    analysisAttemptId: null, operationId: null, evidence, completeness: failure ? 'partial' : 'complete' });
  return validateRunResponse({ protocolVersion: 2, context: { ...request.context, operationId: request.operationId,
    requestHash: request.requestHash, observedSourceManifestSha256: sourceHash,
    sourceVerificationReason: sourceHash === null ? 'SOURCE_NOT_MATERIALIZED' : null },
    actualFingerprint: { completeness: 'complete', values: actual, missingFields: [] },
    outcome, caseResults, baseManifest, artifacts, timings, resourceState: 'retained_for_initial_analysis',
  }, { rule: request.ruleSnapshot, expectedContext: { ...request.context, operationId: request.operationId,
    requestHash: request.requestHash }, approvedFingerprint: request.approvedFingerprint });
}
