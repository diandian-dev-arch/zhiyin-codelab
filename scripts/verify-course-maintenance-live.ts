// Read-only business verification. Never registers authorization or runs delete/cleanup.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,writeFile} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import path from 'node:path';
import {connectDesktopDatabase} from './desktop-database.js';
const id=randomUUID(),date=new Date(Date.now()+8*3600_000).toISOString().slice(0,10);
const directory=path.resolve('docs/verification',date,`course-cli-live-${id}`);
const privateDirectory=path.resolve('.data/course-cli-verification',id);
await mkdir(directory,{recursive:true});await mkdir(privateDirectory,{recursive:true});
const db=await connectDesktopDatabase(),exec=promisify(execFile);
async function snapshot(){
 const result:Record<string,string>={};
 for(const {tablename} of(await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'sessions' ORDER BY tablename")).rows){
  assert.match(tablename,/^[a-z_]+$/);
  const rows=(await db.query(`SELECT to_jsonb(t) AS v FROM "${tablename}" t ORDER BY to_jsonb(t)::text COLLATE "C"`)).rows;
  result[tablename]=createHash('sha256').update(JSON.stringify(rows)).digest('hex');
 }return result;
}
const result:Record<string,unknown>={state:'running',externalModelCalls:0,businessWrites:0};
try{
 const target=(await db.query(`SELECT s.task_id AS "taskId",s.user_id AS "studentId" FROM submissions s JOIN runs r ON r.submission_id=s.id
 JOIN retention_holds h ON h.run_id=r.id WHERE NOT EXISTS(SELECT 1 FROM retention_hold_releases l WHERE l.hold_id=h.id)
 ORDER BY s.id LIMIT 1`)).rows[0];assert(target,'HELD_TARGET_REQUIRED');
 const file=path.join(privateDirectory,'target.json');await writeFile(file,JSON.stringify(target),{flag:'wx',mode:0o600});
 const before=await snapshot();
 const run=async(action:string)=>JSON.parse((await exec(process.execPath,['--import','tsx','scripts/course-retention.ts','--desktop',action,file],
  {windowsHide:true,timeout:45000,maxBuffer:1024*1024})).stdout);
 const plan=await run('plan'),frozen=await run('freeze');
 assert.equal(plan.deletionAuthorized,false);assert.equal(frozen.deletionAuthorized,false);
 assert(frozen.impact.blockers.some((b:string)=>b.includes('HOLD')),'HOLD_NOT_ENFORCED');
 assert.match(frozen.fingerprint,/^[a-f0-9]{64}$/);
 assert.deepEqual(await snapshot(),before,'BUSINESS_CHANGED');
 Object.assign(result,{state:'passed',target,plan,frozen,businessTablesUnchanged:true});
}catch{result.state='failed';result.error='COURSE_CLI_READONLY_VERIFICATION_FAILED';process.exitCode=1;}
finally{await db.close();await writeFile(path.join(directory,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({directory,state:result.state,businessWrites:0,externalModelCalls:0}));}
