import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { DurableRunnerStore } from "../apps/runner/src/durable-store";
import { createRunnerAppV2 } from "../apps/runner/src/app-v2";
import { loadProbeContext } from "../apps/runner/src/probe-v2";
import { createRunnerClientV2 } from "../apps/api/src/runner-client-v2";
import { createDevelopmentPack, createRuleSnapshot, hashRuleSnapshot, hashProbeRequest,
  createArtifactManifest, validateProbeResponse, sha256, type RunnerProbeRequest, type RuleSnapshot,
  type RunnerProbeResponse, type Evidence } from "../packages/contracts/src/v2/index";
const hash="a".repeat(64), token="unit-probe-service-token", headers={authorization:`Bearer ${token}`};
let directory: string, store: DurableRunnerStore, request: RunnerProbeRequest, rule: RuleSnapshot;
let app: Awaited<ReturnType<typeof createRunnerAppV2>> | undefined;
beforeEach(async()=>{
  directory=await mkdtemp(path.join(tmpdir(),"codelab-probe-test-"));
  store=await DurableRunnerStore.open(directory);
  const pack=await createDevelopmentPack("new-filter",{packVersion:"probe-http-unit-v1",templateVersion:"vue-board-v1",templateHash:hash,
    dependencyLockHash:hash,initializationVersion:"clean-ui-v1",caseImplementationHashes:{"NEW-01":hash,"FILTER-03":hash},probeImplementationHashes:{FILTER_ORDER_CHECK:hash}});
  rule=await createRuleSnapshot({ruleId:randomUUID(),taskId:randomUUID(),version:1,packManifest:pack,enabledCriterionIds:["create","filter"],
    parameterValues:{},confirmedBy:randomUUID(),confirmedAt:new Date().toISOString()});
  const context={runId:randomUUID(),executionAttemptId:randomUUID(),submissionId:randomUUID(),originalZipSha256:hash,sourceManifestSha256:hash,
    ruleId:rule.ruleId,ruleHash:await hashRuleSnapshot(rule),packManifestHash:pack.contentHash,templateHash:hash};
  const now=Date.now(),owner={runId:context.runId,ownerKind:"execution" as const,ownerId:context.executionAttemptId,ownerToken:randomUUID()};
  request={protocolVersion:2,context,owner,analysisAttemptId:randomUUID(),operationId:randomUUID(),requestId:randomUUID(),requestHash:hash,
    probeId:"FILTER_ORDER_CHECK",parameters:{},budgetConfigVersion:"probe-measured-limits-v2",workDeadlineAt:new Date(now+60_000).toISOString(),
    hardDeadlineAt:new Date(now+90_000).toISOString(),remainingWorkMs:20_000};
  request.requestHash=await hashProbeRequest(request);
  await store.registerOwner({owner,startedAt:new Date(now).toISOString(),workDeadlineAt:request.workDeadlineAt,hardDeadlineAt:request.hardDeadlineAt,
    leaseUntil:new Date(now+30_000).toISOString(),remainingWorkMs:60_000});
  const baseId=randomUUID();
  await store.reserveOperation(owner,{operationId:baseId,kind:"execute",requestHash:hash});
  const dispatch=await store.beginOperation(owner,baseId);
  const workspace=await store.ensureWorkspace(owner,baseId,dispatch.dispatchToken!);
  await writeFile(path.join(workspace,"execution-context.json"),JSON.stringify({rule,context}));
  for(const role of ["network","web"] as const){
    await store.planResource(owner,baseId,dispatch.dispatchToken!,role==="network"?"network":"container",role);
    await store.markResourceCreateStarted(owner,baseId,dispatch.dispatchToken!,role);
    await store.recordResourceCreated(owner,baseId,dispatch.dispatchToken!,role,role==="network"?hash:"b".repeat(64));
  }
  // Synthetic durable setup; this test never creates a Docker resource.
  await store.finishOperation(owner,baseId,dispatch.dispatchToken!,"completed",{testOnly:true});
});
afterEach(async()=>{await app?.close();app=undefined;await rm(directory,{recursive:true,force:true});});
async function responseFor():Promise<RunnerProbeResponse>{
  const manifestId=randomUUID(), evidenceId=randomUUID(),bytes=Buffer.from('{"testOnly":true}'),c=request.context;
  const evidence:Evidence={evidenceId,manifestId,runId:c.runId,submissionId:c.submissionId,originalZipSha256:c.originalZipSha256,
    sourceManifestSha256:c.sourceManifestSha256,executionAttemptId:c.executionAttemptId,analysisAttemptId:request.analysisAttemptId,
    operationId:request.operationId,scope:"case",criterionId:"filter",caseId:"FILTER-03",phase:"probe",collector:"runner",
    contentOrigin:"checker_observation",ruleHash:c.ruleHash,packManifestHash:c.packManifestHash,sha256:await sha256(bytes),byteSize:bytes.length,
    mediaType:"application/json",storageKey:`runs/${c.runId}/${manifestId}/${evidenceId}.json`,capturedAt:new Date().toISOString()};
  const supplementalManifest=await createArtifactManifest({manifestId,context:c,source:"supplemental",analysisAttemptId:request.analysisAttemptId,
    operationId:request.operationId,evidence:[evidence],completeness:"complete"});
  return {protocolVersion:2,context:c,analysisAttemptId:request.analysisAttemptId,operationId:request.operationId,requestHash:request.requestHash,
    probeId:"FILTER_ORDER_CHECK",supplementalManifest,artifacts:[{evidenceId,encoding:"base64",data:bytes.toString("base64")}],resourceState:"retained_for_initial_analysis"};
}
it("binds supplemental identity and validates actual evidence bytes",async()=>{
  const response=await responseFor();
  await expect(validateProbeResponse(response,request,rule)).resolves.toEqual(response);
  await expect(validateProbeResponse({...response,analysisAttemptId:randomUUID()},request,rule)).rejects.toThrow("PROBE_RESPONSE_IDENTITY_MISMATCH");
  const corrupt=structuredClone(response);corrupt.artifacts[0].data=Buffer.from("different bytes").toString("base64");
  await expect(validateProbeResponse(corrupt,request,rule)).rejects.toThrow();
});
it('binds supplemental PNG to one actual path/step and refuses incomplete or tampered capture claims',async()=>{
  const response=await responseFor();
  const base=response.supplementalManifest.evidence[0];
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE1sAAAAASUVORK5CYII=','base64');
  const imageId=randomUUID(), capturedAt=new Date().toISOString();
  const image={...base,evidenceId:imageId,mediaType:'image/png' as const,contentOrigin:'rendered_page' as const,
    byteSize:png.length,sha256:await sha256(png),capturedAt,storageKey:`runs/${base.runId}/${base.manifestId}/${imageId}.png`};
  response.supplementalManifest=await createArtifactManifest({...response.supplementalManifest,evidence:[base,image],completeness:'partial'});
  response.artifacts.push({evidenceId:imageId,encoding:'base64',data:png.toString('base64')});
  response.stepCaptures=[{pathId:'A',stepId:'setup:open-clean-context',capturedAt,
    state:{status:'captured',controlValue:'all',visible:[]},screenshot:{status:'captured',filename:'probe-A-0.png',evidenceId:imageId,byteSize:png.length,sha256:image.sha256}}];
  const rawCapture=structuredClone(response.stepCaptures[0]);
  if(rawCapture.screenshot.status==='captured') delete rawCapture.screenshot.evidenceId;
  const jsonBytes=Buffer.from(JSON.stringify({observation:{captures:[rawCapture],paths:[{pathId:'A',executedSteps:[{stepId:rawCapture.stepId}]}]}}));
  response.artifacts[0].data=jsonBytes.toString('base64');
  response.supplementalManifest=await createArtifactManifest({...response.supplementalManifest,
    evidence:[{...base,byteSize:jsonBytes.length,sha256:await sha256(jsonBytes)},image]});
  await expect(validateProbeResponse(response,request,rule)).resolves.toEqual(response);
  const noCapture=structuredClone(response);delete noCapture.stepCaptures;
  await expect(validateProbeResponse(noCapture,request,rule)).rejects.toThrow('PROBE_CAPTURE_REQUIRED');
  const crossPath=structuredClone(response);crossPath.stepCaptures![0].pathId='B';
  await expect(validateProbeResponse(crossPath,request,rule)).rejects.toThrow('PROBE_CAPTURE_IMAGE_INVALID');
  const duplicate=structuredClone(response);duplicate.stepCaptures!.push(duplicate.stepCaptures![0]);
  await expect(validateProbeResponse(duplicate,request,rule)).rejects.toThrow('PROBE_CAPTURE_STEP_INVALID');
  const missing=structuredClone(response);missing.supplementalManifest=await createArtifactManifest({...missing.supplementalManifest,completeness:'complete'});
  await expect(validateProbeResponse(missing,request,rule)).rejects.toThrow('PROBE_CAPTURE_INCOMPLETE');
  const corrupt=structuredClone(response);corrupt.artifacts[1].data=Buffer.from('tampered').toString('base64');
  await expect(validateProbeResponse(corrupt,request,rule)).rejects.toThrow();
  const wrongStep=structuredClone(response);wrongStep.stepCaptures![0].stepId='setup:create-mixed-tasks';
  await expect(validateProbeResponse(wrongStep,request,rule)).rejects.toThrow('PROBE_CAPTURE_OBSERVATION_MISMATCH');
});
it("rejects stolen owners, cross-run context and extended deadlines before probe dispatch",async()=>{
  await expect(loadProbeContext(store,{...request,owner:{...request.owner,ownerToken:randomUUID()}})).rejects.toThrow();
  await expect(loadProbeContext(store,{...request,context:{...request.context,submissionId:randomUUID()}})).rejects.toThrow("PROBE_CONTEXT_MISMATCH");
  const changed={...request,workDeadlineAt:new Date(Date.parse(request.workDeadlineAt)+1000).toISOString(),hardDeadlineAt:new Date(Date.parse(request.hardDeadlineAt)+1000).toISOString()};changed.requestHash=await hashProbeRequest(changed);
  await expect(loadProbeContext(store,changed)).rejects.toThrow("PROBE_DEADLINE_MISMATCH");
});
it("dispatches one probe, replays its result and refuses a second operation",async()=>{
  const response=await responseFor(),probe=vi.fn(async()=>response);
  app=await createRunnerAppV2({store,token,volumeName:"codelab-test",environment:{pack:rule.packManifest,measurement:{completeness:"partial",values:{resourceTimeoutConfigVersion:"probe-measured-limits-v2"},missingFields:[]},buildImage:hash,webImage:hash,browserImage:hash},probe});
  const stale={...request,budgetConfigVersion:"desktop-team-limits-v1"};stale.requestHash=await hashProbeRequest(stale);
  expect((await app.inject({method:"POST",url:"/v2/probe",headers,payload:stale})).statusCode).toBe(422);
  expect(probe).not.toHaveBeenCalled();
  const first=await app.inject({method:"POST",url:"/v2/probe",headers,payload:request});
  expect(first.statusCode).toBe(200);
  expect((await app.inject({method:"POST",url:"/v2/probe",headers,payload:request})).json()).toEqual(first.json());
  const second={...request,operationId:randomUUID()};second.requestHash=await hashProbeRequest(second);
  expect((await app.inject({method:"POST",url:"/v2/probe",headers,payload:second})).statusCode).toBe(409);
  expect(probe).toHaveBeenCalledOnce();
  const invalid={...request,operationId:randomUUID(),parameters:{selector:"body"}};
  invalid.requestHash=await hashProbeRequest(invalid);
  expect((await app.inject({method:"POST",url:"/v2/probe",headers,payload:invalid})).statusCode).toBe(400);
  await rm(store.workspacePath(request.owner),{recursive:true,force:true});
  expect((await app.inject({method:"POST",url:"/v2/probe",headers,payload:request})).json()).toEqual(first.json());
  const conflict={...request,remainingWorkMs:19_000};conflict.requestHash=await hashProbeRequest(conflict);
  expect((await app.inject({method:"POST",url:"/v2/probe",headers,payload:conflict})).statusCode).toBe(409);
});
it("rejects model-supplied selectors before touching resource state",async()=>{
  const changed={...request,parameters:{selector:"body"}};changed.requestHash=await hashProbeRequest(changed);
  const before=await store.inspect();
  await expect(loadProbeContext(store,changed)).rejects.toThrow();
  expect(await store.inspect()).toEqual(before);
});
it("client verifies returned evidence and never retries a lost probe response",async()=>{
  const response=await responseFor();
  const transport=vi.fn(async()=>new Response(JSON.stringify(response),{status:200}));
  const client=createRunnerClientV2({baseUrl:"http://127.0.0.1:13200",token:"x".repeat(40),fetchImpl:transport});
  await expect(client.probe(request,rule)).resolves.toEqual(response);
  response.artifacts[0].data=Buffer.from("tampered").toString("base64");
  await expect(client.probe(request,rule)).rejects.toThrow("RUNNER_PROBE_RESPONSE_INVALID");
  transport.mockRejectedValueOnce(new Error("lost response"));
  await expect(client.probe(request,rule)).rejects.toThrow("RUNNER_TRANSPORT_FAILED");
  expect(transport).toHaveBeenCalledTimes(3);
});
