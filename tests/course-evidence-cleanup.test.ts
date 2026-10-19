import { randomUUID } from 'node:crypto';
import { mkdtemp,rm,readFile,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach,afterEach,it,expect } from 'vitest';
import { migrate,type DB } from '../apps/api/src/db';
import { isolatedTestDB,type IsolatedTestDatabase } from './isolated-db';
import { ArtifactStore } from '../apps/api/src/artifacts-v2';
import { cleanNextCourseEvidence } from '../apps/api/src/course-evidence-cleanup';
import { createArtifactManifest,encodeBase64,sha256,type Evidence } from '../packages/contracts/src/v2';

let db:IsolatedTestDatabase,store:ArtifactStore,directory:string,batchId:string,evidence:Evidence;
beforeEach(async()=>{
  db=await isolatedTestDB();await migrate(db);
  directory=await mkdtemp(path.join(tmpdir(),'codelab-cleanup-fixture-'));store=new ArtifactStore({root:directory});
  const runId=randomUUID(),submissionId=randomUUID(),manifestId=randomUUID(),evidenceId=randomUUID(),authorizationId=randomUUID(),h='a'.repeat(64);
  const bytes=new TextEncoder().encode('isolated cleanup fixture');
  const context={runId,submissionId,executionAttemptId:randomUUID(),originalZipSha256:h,sourceManifestSha256:h,ruleId:randomUUID(),ruleHash:h,packManifestHash:h,templateHash:h};
  evidence={evidenceId,manifestId,runId,submissionId,originalZipSha256:h,sourceManifestSha256:h,
    executionAttemptId:context.executionAttemptId,analysisAttemptId:null,operationId:null,scope:'run',criterionId:null,caseId:null,
    phase:'diagnostic',collector:'runner',contentOrigin:'platform_diagnostic',ruleHash:h,packManifestHash:h,
    sha256:await sha256(bytes),byteSize:bytes.length,mediaType:'text/plain; charset=utf-8',
    storageKey:`runs/${runId}/${manifestId}/${evidenceId}.txt`,capturedAt:new Date().toISOString()};
  const manifest=await createArtifactManifest({manifestId,context,source:'base',analysisAttemptId:null,operationId:null,evidence:[evidence],completeness:'partial'});
  await store.storeManifest(manifest,[{evidenceId,encoding:'base64',data:encodeBase64(bytes)}]);
  // Constructed post-delete queue fixture: this does NOT test or bypass course deletion.
  await db.query(`INSERT INTO course_retention_authorizations(id,request_id,request_hash,task_id,student_id,fingerprint,
    policy_reference,authorization_reference,reason,external_references_reviewed,created_at,expires_at)
    VALUES($1,$2,$3,$4,$5,$3,'fixture-policy','fixture-consent','fixture-only',true,now()-interval '2 hours',now()-interval '1 hour')`,
    [authorizationId,randomUUID(),h,randomUUID(),randomUUID()]);
  batchId=randomUUID();
  await db.query('INSERT INTO course_evidence_cleanup_batches(id,authorization_id,run_ids,submission_ids) VALUES($1,$2,$3,$4)',[batchId,authorizationId,[runId],[submissionId]]);
  await db.query('INSERT INTO course_evidence_cleanup_files(batch_id,storage_key,evidence) VALUES($1,$2,$3)',[batchId,evidence.storageKey,JSON.stringify(evidence)]);
},60000);
afterEach(async()=>{
  await db?.close();
  if(directory&&path.dirname(directory)===tmpdir()&&path.basename(directory).startsWith('codelab-cleanup-fixture-'))await rm(directory,{recursive:true,force:true});
});
it('persists exact completion and never reopens a completed cleanup receipt',async()=>{
  expect(await cleanNextCourseEvidence(db,store,batchId)).toEqual({state:'processed',outcome:'removed'});
  expect(await cleanNextCourseEvidence(db,store,batchId)).toEqual({state:'complete'});
  expect((await db.query('SELECT state,attempts FROM course_evidence_cleanup_files')).rows).toEqual([{state:'removed',attempts:1}]);
  await expect(db.exec("UPDATE course_evidence_cleanup_files SET state='pending',finished_at=NULL,attempts=attempts+1")).rejects.toThrow('immutable');
  await expect(db.exec('DELETE FROM course_evidence_cleanup_files')).rejects.toThrow();
  await expect(db.exec('TRUNCATE course_evidence_cleanup_batches CASCADE')).rejects.toThrow();
});
it('resumes from committed intent after file removal succeeds but receipt transaction rolls back',async()=>{
  const failing:DB={...db,transaction:fn=>db.transaction(tx=>fn({...tx,query:async(sql,params)=>{
    if(sql.startsWith('UPDATE course_evidence_cleanup_files'))throw new Error('fixture receipt write failure');
    return tx.query(sql,params);
  }}))};
  await expect(cleanNextCourseEvidence(failing,store,batchId)).rejects.toThrow('fixture receipt write failure');
  expect((await db.query('SELECT state,attempts FROM course_evidence_cleanup_files')).rows).toEqual([{state:'pending',attempts:0}]);
  await expect(readFile(path.join(directory,evidence.storageKey))).rejects.toThrow();
  expect(await cleanNextCourseEvidence(db,store,batchId)).toEqual({state:'processed',outcome:'already_missing'});
});
it('retains corrupt bytes, records retryable progress and redacts arbitrary storage errors',async()=>{
  const file=path.join(directory,evidence.storageKey);await writeFile(file,'corrupt');
  expect(await cleanNextCourseEvidence(db,store,batchId)).toEqual({state:'blocked',errorCode:'ARTIFACT_STORAGE_MISMATCH'});
  expect(await readFile(file,'utf8')).toBe('corrupt');
  expect(await cleanNextCourseEvidence(db,{removeVerifiedEvidence:async()=>{throw new Error('secret-private-path');}},batchId))
    .toEqual({state:'blocked',errorCode:'RETENTION_CLEANUP_STORAGE_FAILED'});
  expect((await db.query('SELECT state,attempts,last_error FROM course_evidence_cleanup_files')).rows)
    .toEqual([{state:'pending',attempts:2,last_error:'RETENTION_CLEANUP_STORAGE_FAILED'}]);
});
it('refuses file cleanup while a submission in the committed batch still exists',async()=>{
  const user=randomUUID(),classId=randomUUID(),task=randomUUID(),rule=randomUUID();
  await db.query("INSERT INTO users(id,email,name,role,password_hash) VALUES($1,$2,'fixture','teacher','fixture')",[user,`${user}@fixture.local`]);
  await db.query("INSERT INTO classes(id,name,teacher_id) VALUES($1,'fixture',$2)",[classId,user]);
  await db.query("INSERT INTO tasks(id,class_id,title,description) VALUES($1,$2,'fixture','fixture')",[task,classId]);
  await db.query("INSERT INTO rules(id,task_id,version,template_version,criteria) VALUES($1,$2,1,'fixture','[]')",[rule,task]);
  await db.query("INSERT INTO submissions(id,task_id,user_id,rule_id,sha256,files,request_id) VALUES($1,$2,$3,$4,$5,'{}','fixture')",
    [evidence.submissionId,task,user,rule,'a'.repeat(64)]);
  await expect(cleanNextCourseEvidence(db,store,batchId)).rejects.toThrow('DATABASE_NOT_DELETED');
  expect(await readFile(path.join(directory,evidence.storageKey),'utf8')).toBe('isolated cleanup fixture');
});
it('rejects inconsistent queue identity without touching the evidence and continues other files next',async()=>{
  await db.query('INSERT INTO course_evidence_cleanup_files(batch_id,storage_key,evidence) VALUES($1,$2,$3)',[batchId,'!invalid',JSON.stringify(evidence)]);
  expect(await cleanNextCourseEvidence(db,store,batchId)).toEqual({state:'blocked',errorCode:'RETENTION_CLEANUP_INVALID_EVIDENCE'});
  expect(await readFile(path.join(directory,evidence.storageKey),'utf8')).toBe('isolated cleanup fixture');
  // Lower-attempt rows go first, so a blocked row does not starve unrelated pending files.
  expect(await cleanNextCourseEvidence(db,store,batchId)).toEqual({state:'processed',outcome:'removed'});
});
it.skipIf(!process.env.CODELAB_TEST_POSTGRES_URL)('serializes independent consumers so only one removes a file',async()=>{
  const peer=db.connectPeer();try{
    const results=await Promise.all([cleanNextCourseEvidence(db,store,batchId),cleanNextCourseEvidence(peer,store,batchId)]);
    expect(results.filter(r=>r.state==='processed')).toHaveLength(1);
    expect(results.filter(r=>r.state==='complete')).toHaveLength(1);
  }finally{await peer.close();}
});
