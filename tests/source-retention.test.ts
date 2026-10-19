import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, expect, it } from 'vitest';
import { migrate } from '../apps/api/src/db';
import { isolatedTestDB, type IsolatedTestDatabase } from './isolated-db';
import { changeSourceRetentionHold as hold, planSourceDeletion as plan, executeSourceDeletion as remove } from '../apps/api/src/source-retention';

let db: IsolatedTestDatabase;
let ownerId: string, projectId: string, analysisId: string;
beforeEach(async () => {
  db = await isolatedTestDB(); await migrate(db);
  ownerId = randomUUID(); projectId = randomUUID(); analysisId = randomUUID();
  await db.query("INSERT INTO users(id,email,name,role,password_hash) VALUES($1,$2,'fixture','student','not-a-login')", [ownerId,`${ownerId}@test.local`]);
  await db.query("INSERT INTO source_projects(id,owner_id,name,sha256,files,omitted) VALUES($1,$2,'private-name',$3,$4,'[]')",
    [projectId,ownerId,'a'.repeat(64),JSON.stringify({ 'private-path.ts':'private-code-marker' })]);
  await db.query("INSERT INTO source_analyses(id,project_id,status,report) VALUES($1,$2,'succeeded',$3)",
    [analysisId,projectId,JSON.stringify({ overview:'private-report-marker' })]);
}, 60000);
afterEach(async () => { await db?.close(); });
const target = () => ({ projectId, ownerId });
async function request() {
  return { ...target(), fingerprint:(await plan(db,target())).fingerprint, requestId:randomUUID(),
    reason:'清理隔离测试资料', authorizationReference:'fixture-authorization-only', externalReferencesReviewed:true,
    confirm:'DELETE_SOURCE_PROJECT_AND_ALL_ANALYSES' };
}

it('previews privately, removes exactly one project atomically, and replays its durable receipt', async () => {
  const other = randomUUID();
  await db.query("INSERT INTO source_projects(id,owner_id,name,sha256,files,omitted) VALUES($1,$2,'keep',$3,'{}','[]')", [other,ownerId,'b'.repeat(64)]);
  await db.query("INSERT INTO source_model_calls(id,analysis_id,call_no,state,budget,finished_at,duration_ms) VALUES($1,$2,1,'unknown','{}',now(),1)", [randomUUID(),analysisId]);
  const preview = await plan(db,target());
  expect(preview).toMatchObject({ deletionAuthorized:false, blockers:[], counts:{files:1,analyses:1,modelCalls:1} });
  expect(JSON.stringify(preview)).not.toContain('private-');
  const input = await request(), result = await remove(db,input);
  expect(result.replayed).toBe(false);
  expect(await remove(db,input)).toMatchObject({eventId:result.eventId,replayed:true});
  expect((await db.query('SELECT id FROM source_projects')).rows).toEqual([{id:other}]);
  expect((await db.query('SELECT id FROM source_analyses')).rows).toEqual([]);
  expect((await db.query('SELECT id FROM source_model_calls')).rows).toEqual([]);
  const ledger=(await db.query('SELECT * FROM source_retention_events')).rows;
  expect(ledger).toHaveLength(1); expect(JSON.stringify(ledger)).not.toContain('private-');
  await expect(remove(db,{...input,reason:'改写原操作理由'})).rejects.toThrow('RETENTION_REQUEST_CONFLICT');
  await expect(db.exec('DELETE FROM source_retention_events')).rejects.toThrow();
  await expect(db.exec("UPDATE source_retention_events SET reason='改写日志内容'")).rejects.toThrow();
  await expect(db.exec('TRUNCATE source_retention_events')).rejects.toThrow();
});

it('requires exact owner, explicit authorization fields and unchanged project/history/hold snapshot', async () => {
  await expect(plan(db,{...target(),ownerId:randomUUID()})).rejects.toThrow('RETENTION_SOURCE_NOT_FOUND');
  const input=await request();
  await expect(remove(db,{...input,externalReferencesReviewed:false})).rejects.toThrow();
  await expect(remove(db,{...input,authorizationReference:''})).rejects.toThrow();
  await expect(remove(db,{...input,confirm:'delete'})).rejects.toThrow();
  await db.query("UPDATE source_analyses SET report='{}' WHERE id=$1",[analysisId]);
  await expect(remove(db,input)).rejects.toThrow('RETENTION_SOURCE_PLAN_STALE');
  const newer=await request();
  await db.query("UPDATE source_projects SET files='{}' WHERE id=$1",[projectId]);
  await expect(remove(db,newer)).rejects.toThrow('RETENTION_SOURCE_PLAN_STALE');
  expect((await db.query('SELECT id FROM source_retention_events')).rows).toEqual([]);
});

it.each(['queued','running'])('blocks %s analysis even with explicit confirmation', async status => {
  await db.query('UPDATE source_analyses SET status=$2 WHERE id=$1',[analysisId,status]);
  await expect(remove(db,await request())).rejects.toThrow('RETENTION_SOURCE_BLOCKED_ACTIVE_ANALYSIS');
});

it('blocks unresolved paid calls on a terminal job and preserves both records', async () => {
  await db.query("INSERT INTO source_model_calls(id,analysis_id,call_no,state,budget) VALUES($1,$2,1,'started','{}')",[randomUUID(),analysisId]);
  await expect(remove(db,await request())).rejects.toThrow('RETENTION_SOURCE_BLOCKED_UNSETTLED_MODEL_CALL');
  expect((await db.query('SELECT id FROM source_model_calls')).rows).toHaveLength(1);
});

it('preserves holds and releases, prevents cross-project release and requires a new plan after release', async () => {
  const input=await request();
  const command={...target(),action:'hold',requestId:randomUUID(),reason:'等待独立评测'};
  const held=await hold(db,command);
  expect(await hold(db,command)).toMatchObject({eventId:held.eventId,replayed:true});
  await expect(remove(db,input)).rejects.toThrow('RETENTION_SOURCE_BLOCKED_ACTIVE_RETENTION_HOLD');
  await expect(hold(db,{...command,reason:'不同操作内容'})).rejects.toThrow('RETENTION_REQUEST_CONFLICT');
  await expect(hold(db,{...target(),action:'release',requestId:randomUUID(),holdId:randomUUID(),reason:'结束测试保留'})).rejects.toThrow('RETENTION_HOLD_NOT_FOUND');
  const otherId=randomUUID();
  await db.query("INSERT INTO source_projects(id,owner_id,name,sha256,files,omitted) VALUES($1,$2,'other',$3,'{}','[]')",[otherId,ownerId,'c'.repeat(64)]);
  const otherHold=await hold(db,{...command,projectId:otherId,requestId:randomUUID()});
  await expect(hold(db,{...target(),action:'release',requestId:randomUUID(),holdId:otherHold.eventId,reason:'跨项目解除应拒绝'})).rejects.toThrow('RETENTION_HOLD_NOT_FOUND');
  const release={...target(),action:'release',requestId:randomUUID(),holdId:held.eventId,reason:'结束测试保留'};
  await hold(db,release);
  await expect(hold(db,{...release,requestId:randomUUID()})).rejects.toThrow('RETENTION_HOLD_ALREADY_RELEASED');
  await expect(remove(db,input)).rejects.toThrow('RETENTION_SOURCE_PLAN_STALE');
  await remove(db,await request());
  expect((await db.query('SELECT id FROM source_retention_events WHERE project_id=$1',[projectId])).rows).toHaveLength(3);
  expect((await plan(db,{projectId:otherId,ownerId})).blockers).toContain('ACTIVE_RETENTION_HOLD');
});

it('rolls back the ledger and all dependent deletions when the final delete fails', async () => {
  await db.exec('CREATE TABLE deletion_test_reference(project_id uuid REFERENCES source_projects(id))');
  await db.query('INSERT INTO deletion_test_reference VALUES($1)',[projectId]);
  await db.query("INSERT INTO source_model_calls(id,analysis_id,call_no,state,budget,finished_at,duration_ms) VALUES($1,$2,1,'failed','{}',now(),1)",[randomUUID(),analysisId]);
  await expect(remove(db,await request())).rejects.toThrow();
  expect((await db.query('SELECT id FROM source_retention_events')).rows).toHaveLength(0);
  expect((await db.query('SELECT id FROM source_analyses')).rows).toHaveLength(1);
  expect((await db.query('SELECT id FROM source_model_calls')).rows).toHaveLength(1);
});

it.skipIf(!process.env.CODELAB_TEST_POSTGRES_URL)('serializes two independent deletion callers to one durable receipt', async () => {
  const peer=db.connectPeer();
  try {
    const input=await request();
    const results=await Promise.all([remove(db,input),remove(peer,input)]);
    expect(results.map(r=>r.replayed).sort()).toEqual([false,true]);
    expect(results[0].eventId).toBe(results[1].eventId);
    expect((await db.query('SELECT id FROM source_retention_events')).rows).toHaveLength(1);
  } finally { await peer.close(); }
});

it.skipIf(!process.env.CODELAB_TEST_POSTGRES_URL)('never commits deletion together with a competing successful new hold', async () => {
  const peer=db.connectPeer();
  try {
    const input=await request();
    const results=await Promise.allSettled([
      hold(db,{...target(),action:'hold',requestId:randomUUID(),reason:'并发评测保留'}),
      remove(peer,input),
    ]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    const events=(await db.query('SELECT action FROM source_retention_events')).rows;
    expect(events).toHaveLength(1);
    const remains=(await db.query('SELECT id FROM source_projects WHERE id=$1',[projectId])).rows.length;
    expect(remains).toBe(events[0].action==='hold' ? 1 : 0);
  } finally { await peer.close(); }
});
