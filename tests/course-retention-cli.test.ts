import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {it,expect} from 'vitest';
import {isolatedTestDB} from './isolated-db';
import {migrate} from '../apps/api/src/db';
import {seed} from '../apps/api/src/seed';
import {ArtifactStore} from '../apps/api/src/artifacts-v2';
import {createArtifactManifest,encodeBase64,sha256,type Evidence} from '../packages/contracts/src/v2';

it.skipIf(!process.env.CODELAB_TEST_POSTGRES_URL)('executes actual CLI deletion and nonempty file cleanup with isolated database and storage roots',async()=>{
  const db=await isolatedTestDB();
  const directory=await mkdtemp(path.join(tmpdir(),'codelab-retention-cli-'));
  try{
    await migrate(db);await seed(db,randomUUID());
    const schema=(await db.query('SELECT current_schema() AS name')).rows[0].name;
    expect(schema).toMatch(/^codelab_test_[a-f0-9]+$/);
    const url=new URL(process.env.CODELAB_TEST_POSTGRES_URL!);
    url.searchParams.set('options',`-c search_path=${schema},pg_catalog`);
    const call=async(action:string,input:unknown,expectedCode=0)=>{
      const file=path.join(directory,randomUUID()+'.json');await writeFile(file,JSON.stringify(input));
      let stdout='',stderr='',code=0;
      try{
        const result=await promisify(execFile)(process.execPath,['--import','tsx','--import','./tests/fixtures/retention-cli-loader.mjs',
          'scripts/course-retention.ts','--desktop',action,file],{windowsHide:true,timeout:45000,maxBuffer:1024*1024,
          env:{...process.env,CODELAB_TEST_POSTGRES_URL:url.toString(),CODELAB_TEST_CLI_ROOT:directory}});
        stdout=result.stdout;stderr=result.stderr;
      }catch(error){
        // Never surface execFile's command/environment or database credentials in assertions.
        const e=error as {code?:number;stdout?:string;stderr?:string};code=typeof e.code==='number'?e.code:-1;
        stdout=e.stdout??'';stderr=e.stderr??'';
      }
      expect(code,stderr).toBe(expectedCode);
      if(expectedCode){expect(stdout).toBe('');expect(stderr.trim()).toMatch(/^RETENTION_[A-Z_]+$/);return;}
      expect(stderr).toBe('');return JSON.parse(stdout);
    };
    const taskId=(await db.query('SELECT id FROM tasks LIMIT 1')).rows[0].id;
    const studentId=(await db.query("SELECT id FROM users WHERE role='student' LIMIT 1")).rows[0].id;
    const ruleId=randomUUID(),submissionId=randomUUID(),h='a'.repeat(64),target={taskId,studentId};
    await db.query(`INSERT INTO rules(id,task_id,version,template_version,criteria,contract_version,rule_snapshot,idempotency_key,request_hash)
      VALUES($1::uuid,$2,2,'vue-board-v1','[]',2,'{"version":2}',$1::text,$3)`,[ruleId,taskId,h]);
    await db.query(`INSERT INTO submissions(id,task_id,user_id,rule_id,sha256,files,request_id,contract_version,source_manifest,source_manifest_sha256)
      VALUES($1::uuid,$2,$3,$4,$5,'{}',$1::text,2,'{"version":1,"files":[]}',$5)`,[submissionId,taskId,studentId,ruleId,h]);
    const runId=randomUUID(),executionId=randomUUID(),manifestId=randomUUID(),evidenceId=randomUUID();
    const bytes=new TextEncoder().encode('generated nonempty CLI evidence');
    const evidence:Evidence={evidenceId,manifestId,runId,submissionId,originalZipSha256:h,sourceManifestSha256:h,
      executionAttemptId:executionId,analysisAttemptId:null,operationId:null,scope:'run',criterionId:null,caseId:null,
      phase:'diagnostic',collector:'runner',contentOrigin:'platform_diagnostic',ruleHash:h,packManifestHash:h,
      sha256:await sha256(bytes),byteSize:bytes.length,mediaType:'text/plain; charset=utf-8',
      storageKey:`runs/${runId}/${manifestId}/${evidenceId}.txt`,capturedAt:new Date().toISOString()};
    const manifest=await createArtifactManifest({manifestId,context:{runId,submissionId,executionAttemptId:executionId,
      originalZipSha256:h,sourceManifestSha256:h,ruleId,ruleHash:h,packManifestHash:h,templateHash:h},
      source:'base',analysisAttemptId:null,operationId:null,evidence:[evidence],completeness:'partial'});
    const evidenceRoot=path.join(directory,'.data/business-v2/evidence-v2');
    await new ArtifactStore({root:evidenceRoot}).storeManifest(manifest,[{evidenceId,encoding:'base64',data:encodeBase64(bytes)}]);
    const evidenceFile=path.join(evidenceRoot,evidence.storageKey),unrelated=path.join(evidenceRoot,'unrelated.txt');
    await writeFile(unrelated,'must survive');
    await db.query(`INSERT INTO runs(id,submission_id,rule_id,status,contract_version,execution_config,request_id,idempotency_key,request_hash)
      VALUES($1::uuid,$2,$3,'completed',2,'{}',$1::text,$1::text,$4)`,[runId,submissionId,ruleId,h]);
    await db.query(`INSERT INTO execution_attempts(id,run_id,attempt_no,owner_phase,pipeline_started_at,work_deadline_at,pipeline_deadline_at,
      base_manifest,cleanup_state,cleanup_receipt) VALUES($1,$2,1,'closed',now()-interval '5 minutes',now()-interval '1 minute',now(),$3,'clean','{"fixture":true}')`,
      [executionId,runId,JSON.stringify(manifest)]);
    expect((await call('plan',target)).deletionAuthorized).toBe(false);
    const {fingerprint}=await call('freeze',target);
    const auth={...target,fingerprint,requestId:randomUUID(),ttlSeconds:3600,reason:'generated CLI fixture',
      policyReference:'fixture-only',authorizationReference:'fixture-only',externalReferencesReviewed:true,confirm:'AUTHORIZE_EXACT_COURSE_HISTORY'};
    const first=await call('authorize',auth);
    await call('revoke',{authorizationId:first.authorizationId,requestId:randomUUID(),reason:'fixture revoke'});
    const deletion={...target,fingerprint,authorizationId:first.authorizationId,requestId:randomUUID(),confirm:'DELETE_EXACT_COURSE_HISTORY'};
    await call('delete',deletion,1);
    expect((await db.query('SELECT id FROM submissions WHERE id=$1',[submissionId])).rows).toHaveLength(1);
    deletion.authorizationId=(await call('authorize',{...auth,requestId:randomUUID()})).authorizationId;
    await call('delete',{...deletion,confirm:'yes'},1);
    const deleted=await call('delete',deletion);
    expect(await call('delete',deletion)).toEqual({...deleted,replayed:true});
    expect((await call('status',{batchId:deleted.batchId})).complete).toBe(false);
    expect(await readFile(evidenceFile)).toEqual(Buffer.from(bytes));
    await call('cleanup',{batchId:deleted.batchId,confirm:'yes'},1);
    expect(await readFile(evidenceFile)).toEqual(Buffer.from(bytes));
    // Corrupt bytes must be retained for diagnosis, with a retryable receipt.
    await writeFile(evidenceFile,'corrupt fixture');
    expect(await call('cleanup',{batchId:deleted.batchId,confirm:'CLEAN_COMMITTED_COURSE_EVIDENCE'}))
      .toMatchObject({state:'blocked',errorCode:'ARTIFACT_STORAGE_MISMATCH'});
    expect(await readFile(evidenceFile,'utf8')).toBe('corrupt fixture');
    await writeFile(evidenceFile,bytes);
    expect(await call('cleanup',{batchId:deleted.batchId,confirm:'CLEAN_COMMITTED_COURSE_EVIDENCE'}))
      .toEqual({batchId:deleted.batchId,state:'processed',outcome:'removed'});
    await expect(readFile(evidenceFile)).rejects.toMatchObject({code:'ENOENT'});
    expect(await call('cleanup',{batchId:deleted.batchId,confirm:'CLEAN_COMMITTED_COURSE_EVIDENCE'}))
      .toEqual({batchId:deleted.batchId,state:'complete'});
    expect((await call('status',{batchId:deleted.batchId})).files).toEqual([{state:'removed',files:1,attempts:2}]);
    expect(await readFile(unrelated,'utf8')).toBe('must survive');
    expect((await db.query('SELECT id FROM submissions WHERE id=$1',[submissionId])).rows).toHaveLength(0);
  }finally{
    await db.close();
    // Exact mkdtemp directory owned by this test; no project or user data resides here.
    if(path.dirname(directory)===tmpdir()&&path.basename(directory).startsWith('codelab-retention-cli-'))
      await rm(directory,{recursive:true,force:true});
  }
},180000);
