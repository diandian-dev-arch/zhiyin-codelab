import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { workspaceDatabaseTarget, assertDatabaseTarget } from './workspace-database-target.js';
import { connectDesktopDatabase } from './desktop-database.js';
import { checkRestoredHttp } from './restore-http-check.js';
import { createUserModelService, loadModelVaultKey } from '../apps/api/src/user-model-settings.js';

const root=process.cwd(), target=await workspaceDatabaseTarget(root);
const info=JSON.parse((await promisify(execFile)('docker',['inspect',target.name],{windowsHide:true})).stdout)[0];
assertDatabaseTarget(target,info);
const id=info.Config.Labels?.['codelab.recovery'];
if (!/^[a-f0-9-]{36}$/.test(id??'') || !target.id) throw new Error('RECOVERED_DATABASE_REQUIRED');
const db=await connectDesktopDatabase();
const result: Record<string,unknown>={state:'verifying',externalModelCalls:0};
try {
  const service=createUserModelService(db,await loadModelVaultKey(db));
  const profiles=(await db.query('SELECT user_id FROM user_model_settings')).rows;
  for(const profile of profiles) if (!await service.resolve(profile.user_id)) throw new Error('RECOVERED_PROFILE_UNREADABLE');
  result.decryptedProfiles=profiles.length;
  const credentials=JSON.parse(await readFile('.data/business-v2/development-credentials.json','utf8'));
  result.http=await checkRestoredHttp({
    databaseUrl:`postgres://postgres:${encodeURIComponent(credentials.databasePassword)}@127.0.0.1:${info.NetworkSettings.Ports['5432/tcp'][0].HostPort}/codelab`,
    evidenceRoot:path.resolve('.data/business-v2/evidence-v2'),password:credentials.loginPassword,
  });
  result.state='passed';
}catch(error){
  result.state='failed';
  result.code=error instanceof Error && /^[A-Z_]+$/.test(error.message)?error.message:'RECOVERY_HTTP_CHECK_FAILED';
  process.exitCode=1;
}finally{
  await db.close();
  await writeFile(path.join('.data/takeover-recovery',id,'http-result.json'),JSON.stringify(result,null,2),{mode:0o600});
  console.log(JSON.stringify(result));
}
