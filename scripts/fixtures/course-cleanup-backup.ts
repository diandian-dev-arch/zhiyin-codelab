import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {cp,mkdir,readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import type {DB} from '../../apps/api/src/db.js';
import {ArtifactStore} from '../../apps/api/src/artifacts-v2.js';
import {withFrozenCourseHistory} from '../../apps/api/src/course-retention-scope.js';
import {recordCourseAuthorization} from '../../apps/api/src/course-retention-authorization.js';
import {executeCourseDeletion} from '../../apps/api/src/course-deletion.js';
import {cleanNextCourseEvidence} from '../../apps/api/src/course-evidence-cleanup.js';
import {createArtifactManifest,sha256,type Evidence} from '../../packages/contracts/src/v2/index.js';
import {killCleanupAt} from './course-cleanup-crash.js';

async function diskInventory(root:string):Promise<Record<string,string>>{
  const result:Record<string,string>={};
  async function visit(relative:string){
    for(const entry of await readdir(path.join(root,relative),{withFileTypes:true})){
      const key=path.join(relative,entry.name);
      assert(!entry.isSymbolicLink());
      if(entry.isDirectory())await visit(key);
      else {assert(entry.isFile());result[key]=createHash('sha256').update(await readFile(path.join(root,key))).digest('hex');}
    }
  }
  await visit('');return result;
}

/** Only for the verifier's generated, isolated database and private backup directory. */
export async function prepareCourseCleanupBackup(db:DB,backup:string,studentId:string,isolatedUrl:string){
  const taskId=randomUUID(),ruleId=randomUUID(),submissionId=randomUUID(),runId=randomUUID(),executionId=randomUUID();
  const classId=(await db.query('SELECT id FROM classes ORDER BY id LIMIT 1')).rows[0].id;
  const h='b'.repeat(64),manifestId=randomUUID();
  await db.query("INSERT INTO tasks(id,class_id,title,description) VALUES($1,$2,'cleanup backup fixture','generated only')",[taskId,classId]);
  await db.query(`INSERT INTO rules(id,task_id,version,template_version,criteria,contract_version,rule_snapshot,idempotency_key,request_hash)
    VALUES($1::uuid,$2,1,'vue-board-v1','[]',2,'{"version":2}',$1::text,$3)`,[ruleId,taskId,h]);
  await db.query(`INSERT INTO submissions(id,task_id,user_id,rule_id,sha256,files,request_id,contract_version,source_manifest,source_manifest_sha256)
    VALUES($1::uuid,$2,$3,$4,$5,'{}',$1::text,2,'{"version":1,"files":[]}',$5)`,[submissionId,taskId,studentId,ruleId,h]);
  await db.query(`INSERT INTO runs(id,submission_id,rule_id,status,contract_version,execution_config,request_id,idempotency_key,request_hash)
    VALUES($1::uuid,$2,$3,'completed',2,'{}',$1::text,$1::text,$4)`,[runId,submissionId,ruleId,h]);
  const context={runId,submissionId,executionAttemptId:executionId,originalZipSha256:h,sourceManifestSha256:h,ruleId,ruleHash:h,packManifestHash:h,templateHash:h};
  const bytes=new TextEncoder().encode('generated course recovery evidence');
  const evidence:Evidence[]=await Promise.all([0,1,2].map(async()=>{
    const evidenceId=randomUUID();
    return {evidenceId,manifestId,runId,submissionId,executionAttemptId:executionId,originalZipSha256:h,sourceManifestSha256:h,
      analysisAttemptId:null,operationId:null,scope:'run',criterionId:null,caseId:null,phase:'diagnostic',collector:'runner',
      contentOrigin:'platform_diagnostic',ruleHash:h,packManifestHash:h,sha256:await sha256(bytes),byteSize:bytes.length,
      mediaType:'text/plain; charset=utf-8',storageKey:`runs/${runId}/${manifestId}/${evidenceId}.txt`,capturedAt:new Date().toISOString()};
  }));
  const manifest=await createArtifactManifest({manifestId,context,source:'base',analysisAttemptId:null,operationId:null,evidence,completeness:'partial'});
  await db.query(`INSERT INTO execution_attempts(id,run_id,attempt_no,owner_phase,pipeline_started_at,work_deadline_at,pipeline_deadline_at,
    base_sealed_at,base_results,base_manifest,actual_fingerprint,cleanup_state,cleanup_receipt)
    VALUES($1,$2,1,'closed',now(),now()+interval '270 seconds',now()+interval '300 seconds',now(),'[]',$3,'{}','clean','{"fixture":true}')`,
    [executionId,runId,JSON.stringify(manifest)]);
  const sourceRoot=path.join(backup,'source-evidence'),savedRoot=path.join(backup,'evidence-backup'),restoredRoot=path.join(backup,'restored-evidence');
  await mkdir(sourceRoot,{recursive:true});
  const store=new ArtifactStore({root:sourceRoot});
  await store.storeManifest(manifest,evidence.map(e=>({evidenceId:e.evidenceId,encoding:'base64' as const,data:Buffer.from(bytes).toString('base64')})));
  const fingerprint=await withFrozenCourseHistory(db,{taskId,studentId},async(_tx,s)=>s.fingerprint);
  const authorization=await recordCourseAuthorization(db,{taskId,studentId,fingerprint,requestId:randomUUID(),ttlSeconds:3600,
    reason:'generated cleanup restore fixture',policyReference:'fixture-only',authorizationReference:'fixture-only',externalReferencesReviewed:true,confirm:'AUTHORIZE_EXACT_COURSE_HISTORY'});
  const request={taskId,studentId,fingerprint,authorizationId:authorization.authorizationId,requestId:randomUUID(),confirm:'DELETE_EXACT_COURSE_HISTORY'};
  const deleted=await executeCourseDeletion(db,request);
  const initialFiles=await diskInventory(sourceRoot);
  const beforeKill=await killCleanupAt(isolatedUrl,sourceRoot,deleted.batchId,'before-unlink');
  // Taking the same lock confirms the terminated client's transaction released it.
  await db.transaction(async tx=>{await tx.exec("SET LOCAL lock_timeout='3s'; LOCK TABLE submissions,runs IN SHARE ROW EXCLUSIVE MODE");});
  assert.deepEqual(await diskInventory(sourceRoot),initialFiles);
  assert.deepEqual((await db.query('SELECT state,attempts FROM course_evidence_cleanup_files WHERE batch_id=$1',[deleted.batchId])).rows,
    Array.from({length:3},()=>({state:'pending',attempts:0})));
  assert.deepEqual(await cleanNextCourseEvidence(db,store,deleted.batchId),{state:'processed',outcome:'removed'});
  const afterKill=await killCleanupAt(isolatedUrl,sourceRoot,deleted.batchId,'after-unlink');
  await db.transaction(async tx=>{await tx.exec("SET LOCAL lock_timeout='3s'; LOCK TABLE submissions,runs IN SHARE ROW EXCLUSIVE MODE");});
  const queue=async(connection:DB)=>(await connection.query('SELECT * FROM course_evidence_cleanup_files WHERE batch_id=$1 ORDER BY storage_key COLLATE "C"',[deleted.batchId])).rows;
  const before=await queue(db);
  assert.deepEqual(before.map(r=>[r.state,r.attempts]),[['removed',1],['pending',0],['pending',0]]);
  const sourceFiles=await diskInventory(sourceRoot);assert.equal(Object.keys(sourceFiles).length,1);
  await cp(sourceRoot,savedRoot,{recursive:true,errorOnExist:true,force:false});
  assert.deepEqual(await diskInventory(savedRoot),sourceFiles);
  return async(target:DB)=>{
    await cp(savedRoot,restoredRoot,{recursive:true,errorOnExist:true,force:false});
    assert.deepEqual(await diskInventory(restoredRoot),sourceFiles);
    assert.deepEqual(await queue(target),before);
    assert.deepEqual(await executeCourseDeletion(target,request),{...deleted,replayed:true});
    const restored=new ArtifactStore({root:restoredRoot});
    assert.deepEqual(await cleanNextCourseEvidence(target,restored,deleted.batchId),{state:'processed',outcome:'already_missing'});
    assert.deepEqual(await cleanNextCourseEvidence(target,restored,deleted.batchId),{state:'processed',outcome:'removed'});
    assert.deepEqual(await cleanNextCourseEvidence(target,restored,deleted.batchId),{state:'complete'});
    const after=await queue(target);assert.deepEqual(after[0],before[0]);
    assert.deepEqual(after.map(r=>[r.state,r.attempts]),[['removed',1],['already_missing',1],['removed',1]]);
    assert.deepEqual(await diskInventory(restoredRoot),{});
    assert.deepEqual(await diskInventory(sourceRoot),sourceFiles);
    assert.deepEqual(await diskInventory(savedRoot),sourceFiles);
    assert.deepEqual(await queue(db),before);
    return {files:3,restoredFileHashes:sourceFiles,initialStates:['removed','pending-missing','pending-present'],
      finalStates:after.map(r=>r.state),completedReceiptUnchanged:true,deletionReplayed:true,sourceFilesUnchanged:true,
      interruption:'forced child termination before unlink and after unlink before receipt',processTerminations:[beforeKill,afterKill]};
  };
}
