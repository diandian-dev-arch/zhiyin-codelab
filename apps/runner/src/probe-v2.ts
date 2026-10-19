import { randomUUID } from "node:crypto";
import { mkdir, chown, writeFile } from "node:fs/promises";
import path from "node:path";
import { transferOutput } from './output-transfer-v2.js';
import { canonicalJson, createArtifactManifest, sha256, validateProbeRequest, validateProbeResponse, probeCaptureSchema,
  type RunnerProbeRequest, type RunnerProbeResponse, type RuleSnapshot, type Evidence } from "@codelab/contracts/v2";
import { DurableRunnerStore, RunnerStoreError } from "./durable-store.js";
import { readArtifact, AmbiguousDockerDispatch } from "./engine-v2.js";
import { dockerCommand, restrictedBrowserArgs, type TrustedRunnerEnvironment } from "./environment-v2.js";

export async function loadProbeContext(store: DurableRunnerStore, request: RunnerProbeRequest) {
  const snapshot = await store.inspect();
  const base = snapshot.operations.find(op => op.ownerId === request.owner.ownerId && op.runId === request.context.runId &&
    op.ownerKind === request.owner.ownerKind && op.kind === (request.owner.ownerKind === "execution" ? "execute" : "prepare_probe"));
  if (!base) throw new RunnerStoreError("PROBE_BASE_REQUIRED",409);
  const saved = await store.queryOperation(request.owner,base.operationId);
  if (saved.operation.state !== "completed") throw new RunnerStoreError("PROBE_BASE_NOT_COMPLETE",409);
  const workspace = store.workspacePath(request.owner);
  const trusted = JSON.parse((await readArtifact(workspace,"execution-context.json",256*1024)).toString("utf8"));
  if (canonicalJson(trusted.context) !== canonicalJson(request.context)) throw new RunnerStoreError("PROBE_CONTEXT_MISMATCH",409);
  if(request.owner.ownerKind === "analysis" && (trusted.analysisAttemptId !== request.analysisAttemptId || trusted.probeOperationId !== request.operationId))
    throw new RunnerStoreError("PROBE_PREPARATION_IDENTITY_MISMATCH",409);
  const rule = trusted.rule as RuleSnapshot;
  try { await validateProbeRequest(request,rule); }
  catch { throw new RunnerStoreError("INVALID_PROBE_REQUEST",400); }
  if (!rule.requiredCaseIds.includes("FILTER-03")) throw new RunnerStoreError("PROBE_CASE_NOT_ENABLED",422);
  const owner = snapshot.owners.find(item=>item.ownerId===request.owner.ownerId && item.ownerKind===request.owner.ownerKind);
  if (!owner || request.workDeadlineAt !== owner.workDeadlineAt || request.hardDeadlineAt !== owner.hardDeadlineAt)
    throw new RunnerStoreError("PROBE_DEADLINE_MISMATCH",409);
  const network = owner.resources.find(item=>item.role==="network")?.createdResourceId;
  const web = owner.resources.find(item=>item.role==="web")?.createdResourceId;
  if (!network || !web) throw new RunnerStoreError("PROBE_PAGE_UNAVAILABLE",409);
  return { rule,workspace,network };
}

export async function executeProbeV2(store: DurableRunnerStore, environment: TrustedRunnerEnvironment,
  volumeName: string, request: RunnerProbeRequest, dispatchToken: string): Promise<RunnerProbeResponse> {
  if (!/^codelab-[a-z0-9][a-z0-9_-]{0,80}$/.test(volumeName)) throw new Error("RUNNER_VOLUME_INVALID");
  const { rule,workspace,network } = await loadProbeContext(store,request);
  if (rule.packManifestHash !== environment.pack.contentHash) throw new RunnerStoreError("UNSUPPORTED_EXECUTION_PACK",422);
  const definition = rule.packManifest.probes.find(item=>item.probeId===request.probeId)!;
  const deadline = Math.min(Date.parse(request.workDeadlineAt),store.now()+request.remainingWorkMs);
  const budget = (max: number) => {
    const remaining=Math.floor(deadline-store.now());
    if (remaining<=0) throw new Error("PROBE_TIME_BUDGET");
    return Math.min(max,remaining);
  };
  const directory=path.join(workspace,"probe");
  await mkdir(directory,{mode:0o755});
  await chown(directory,1000,1000);
  await writeFile(path.join(directory,"probe-request.json"),JSON.stringify({definition,parameters:request.parameters,
    remainingWorkMs:budget(20_000)}),{flag:"wx",mode:0o444});
  const resource=await store.planResource(request.owner,request.operationId,dispatchToken,"container","probe");
  const timeout=budget(10_000);
  await store.markResourceCreateStarted(request.owner,request.operationId,dispatchToken,"probe");
  let id: string;
  try {
    id=(await dockerCommand(["container","create",...Object.entries(resource.labels).flatMap(([key,value])=>["--label",`${key}=${value}`]),
      "--name",resource.name,"--network",network,...restrictedBrowserArgs("1536m"),"--shm-size","256m",
      "--mount",`type=volume,source=${volumeName},volume-subpath=resources/${request.owner.ownerKind}-${request.owner.ownerId}/probe,target=/input,readonly`,
      '--tmpfs','/artifacts:rw,nosuid,nodev,noexec,size=32m,uid=1000,gid=1000',
      environment.browserImage,"node","/opt/export-output.mjs","probe"],timeout)).stdout.trim();
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("DOCKER_ID_INVALID");
    await store.recordResourceCreated(request.owner,request.operationId,dispatchToken,"probe",id);
  } catch { throw new AmbiguousDockerDispatch("PROBE_CREATE_OUTCOME_UNKNOWN"); }
  const {code}=await transferOutput(id,directory,'probe',budget(30_000));
  if (code!==0) throw new Error("PROBE_PROCESS_FAILED");
  const bytes=await readArtifact(directory,"probe-result.json",65536);
  const output=JSON.parse(bytes.toString("utf8"));
  if (output.checkerImplementationHash!==definition.implementationHash || output.browserVersion!==environment.measurement.values.chromiumVersion ||
      output.playwrightVersion!==environment.measurement.values.playwrightVersion ||
      ["viewport","locale","timezone","clockPolicy","randomPolicy","pageServerPolicy"].some(key=>
        canonicalJson(output.environment?.[key])!==canonicalJson((environment.measurement.values as Record<string,unknown>)[key])))
    throw new Error("PROBE_ENVIRONMENT_MISMATCH");
  if (output.observation?.format!=="filter-order-probe-v1" || output.observation?.baseResultsModified!==false)
    throw new Error("PROBE_OUTPUT_INVALID");
  const manifestId=randomUUID(),evidenceId=randomUUID(), context=request.context;
  const evidence: Evidence = { evidenceId,manifestId,runId:context.runId,submissionId:context.submissionId,
    originalZipSha256:context.originalZipSha256,sourceManifestSha256:context.sourceManifestSha256,
    executionAttemptId:context.executionAttemptId,analysisAttemptId:request.analysisAttemptId,operationId:request.operationId,
    scope:"case",criterionId:"filter",caseId:"FILTER-03",phase:"probe",collector:"runner",contentOrigin:"checker_observation",
    ruleHash:context.ruleHash,packManifestHash:context.packManifestHash,sha256:await sha256(bytes),byteSize:bytes.length,
    mediaType:"application/json",storageKey:`runs/${context.runId}/${manifestId}/${evidenceId}.json`,capturedAt:new Date().toISOString() };
  if(!Array.isArray(output.observation.captures) || output.observation.captures.length>10) throw new Error('PROBE_CAPTURE_REQUIRED');
  const captures = output.observation.captures.map((value:unknown)=>probeCaptureSchema.parse(value));
  const allEvidence: Evidence[] = [evidence];
  const artifacts: RunnerProbeResponse['artifacts'] = [{evidenceId,encoding:'base64',data:bytes.toString('base64')}];
  for (const capture of captures) {
    if(!output.observation.paths.some((p:any)=>p.pathId===capture.pathId && p.executedSteps.some((s:any)=>s.stepId===capture.stepId)))
      throw new Error('PROBE_CAPTURE_UNEXECUTED_STEP');
    if(capture.screenshot.status!=='captured') continue;
    if(capture.screenshot.evidenceId) throw new Error('PROBE_CAPTURE_UNTRUSTED_ID');
    const png = await readArtifact(directory,capture.screenshot.filename,1024*1024);
    if(png.length!==capture.screenshot.byteSize || await sha256(png)!==capture.screenshot.sha256 ||
      !png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('PROBE_CAPTURE_BYTES_INVALID');
    const imageId=randomUUID(); capture.screenshot.evidenceId=imageId;
    allEvidence.push({...evidence,evidenceId:imageId,mediaType:'image/png',contentOrigin:'rendered_page',
      storageKey:`runs/${context.runId}/${manifestId}/${imageId}.png`,sha256:capture.screenshot.sha256,
      byteSize:png.length,capturedAt:capture.capturedAt});
    artifacts.push({evidenceId:imageId,encoding:'base64',data:png.toString('base64')});
  }
  const complete = output.observation.paths.every((p:any)=>p.status==='completed') &&
    definition.plannedPaths.every(p=>p.plannedSteps.every(s=>captures.some((c:any)=>c.pathId===p.pathId && c.stepId===s.stepId &&
      c.state.status==='captured' && c.screenshot.status==='captured')));
  const manifest=await createArtifactManifest({manifestId,context,source:"supplemental",analysisAttemptId:request.analysisAttemptId,
    operationId:request.operationId,evidence:allEvidence,completeness:complete ? "complete":"partial"});
  return validateProbeResponse({protocolVersion:2,context,analysisAttemptId:request.analysisAttemptId,operationId:request.operationId,
    requestHash:request.requestHash,probeId:request.probeId,supplementalManifest:manifest,
    artifacts,stepCaptures:captures,resourceState:request.owner.ownerKind === "execution" ? "retained_for_initial_analysis" : "retained_for_reanalysis"},request,rule);
}
