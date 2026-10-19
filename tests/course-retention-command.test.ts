import {randomUUID} from 'node:crypto';
import {afterEach,it,expect} from 'vitest';
import {isolatedTestDB,type IsolatedTestDatabase} from './isolated-db';
import {migrate} from '../apps/api/src/db';
import {seed} from '../apps/api/src/seed';
import {runCourseRetentionCommand} from '../apps/api/src/course-retention-command';
let db:IsolatedTestDatabase;
afterEach(async()=>{await db?.close();});
it('requires deployed schema before any maintenance operation',async()=>{
  db=await isolatedTestDB();await db.exec('CREATE TABLE schema_migrations(version integer)');
  await expect(runCourseRetentionCommand(db,'delete',{})).rejects.toThrow('RETENTION_MIGRATION_REQUIRED');
});
it('runs explicit preview authorization revocation deletion replay and cleanup status without model calls',async()=>{
  db=await isolatedTestDB();await migrate(db);await seed(db,randomUUID());
  const taskId=(await db.query('SELECT id FROM tasks LIMIT 1')).rows[0].id;
  const studentId=(await db.query("SELECT id FROM users WHERE role='student' LIMIT 1")).rows[0].id;
  const ruleId=randomUUID(),submissionId=randomUUID(),h='a'.repeat(64),target={taskId,studentId};
  await db.query(`INSERT INTO rules(id,task_id,version,template_version,criteria,contract_version,rule_snapshot,idempotency_key,request_hash)
    VALUES($1::uuid,$2,2,'vue-board-v1','[]',2,'{"version":2}',$1::text,$3)`,[ruleId,taskId,h]);
  await db.query(`INSERT INTO submissions(id,task_id,user_id,rule_id,sha256,files,request_id,contract_version,source_manifest,source_manifest_sha256)
    VALUES($1::uuid,$2,$3,$4,$5,'{}',$1::text,2,'{"version":1,"files":[]}',$5)`,[submissionId,taskId,studentId,ruleId,h]);
  const plan:any=await runCourseRetentionCommand(db,'plan',target);expect(plan.deletionAuthorized).toBe(false);
  const frozen:any=await runCourseRetentionCommand(db,'freeze',target);
  const authorizationInput={...target,fingerprint:frozen.fingerprint,requestId:randomUUID(),ttlSeconds:3600,reason:'fixture command',
    policyReference:'fixture-only',authorizationReference:'fixture-only',externalReferencesReviewed:true,confirm:'AUTHORIZE_EXACT_COURSE_HISTORY'};
  const revoked:any=await runCourseRetentionCommand(db,'authorize',authorizationInput);
  await runCourseRetentionCommand(db,'revoke',{authorizationId:revoked.authorizationId,requestId:randomUUID(),reason:'fixture revoke'});
  const request={...target,authorizationId:revoked.authorizationId,requestId:randomUUID(),fingerprint:frozen.fingerprint,confirm:'DELETE_EXACT_COURSE_HISTORY'};
  await expect(runCourseRetentionCommand(db,'delete',request)).rejects.toThrow('AUTHORIZATION_REVOKED');
  const authorized:any=await runCourseRetentionCommand(db,'authorize',{...authorizationInput,requestId:randomUUID()});
  request.authorizationId=authorized.authorizationId;
  await expect(runCourseRetentionCommand(db,'delete',{...request,confirm:'yes'})).rejects.toThrow();
  const deleted:any=await runCourseRetentionCommand(db,'delete',request);
  expect(await runCourseRetentionCommand(db,'delete',request)).toEqual({...deleted,replayed:true});
  const state:any=await runCourseRetentionCommand(db,'status',{batchId:deleted.batchId});
  expect(state.complete).toBe(true);expect(state.batch.submissions).toBe(1);expect(state.files).toEqual([]);
  await expect(runCourseRetentionCommand(db,'cleanup',{batchId:deleted.batchId,confirm:'yes'})).rejects.toThrow();
  const store={removeVerifiedEvidence:async()=>{throw new Error('EMPTY_QUEUE_MUST_NOT_TOUCH_STORAGE');}};
  expect(await runCourseRetentionCommand(db,'cleanup',{batchId:deleted.batchId,confirm:'CLEAN_COMMITTED_COURSE_EVIDENCE'},store))
    .toEqual({batchId:deleted.batchId,state:'complete'});
  expect((await db.query('SELECT id FROM submissions WHERE id=$1',[submissionId])).rows).toEqual([]);
},60000);
