import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { workspaceDatabaseTarget, assertDatabaseTarget } from '../scripts/workspace-database-target.js';

it('uses the default only without a selection; rejects corrupt and replaced recovery targets',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'codelab-db-target-'));
  try{
    expect(await workspaceDatabaseTarget(root)).toEqual({name:'codelab-workspace-postgres-v2',id:undefined});
    await mkdir(path.join(root,'.data'));
    const file=path.join(root,'.data/workspace-database.json');
    for(const value of ['{broken',JSON.stringify({name:'unrelated-database',id:'a'.repeat(64)}),JSON.stringify({name:'codelab-recovered',id:'short'})]){
      await writeFile(file,value);
      await expect(workspaceDatabaseTarget(root)).rejects.toThrow('WORKSPACE_DATABASE_TARGET_INVALID');
    }
    await writeFile(file,JSON.stringify({name:'codelab-recovered-test',id:'a'.repeat(64)}));
    const target=await workspaceDatabaseTarget(root);
    expect(target.name).toBe('codelab-recovered-test');
    expect(()=>assertDatabaseTarget(target,{Id:'b'.repeat(64)})).toThrow('WORKSPACE_DATABASE_TARGET_REPLACED');
    expect(()=>assertDatabaseTarget(target,{Id:'a'.repeat(64)})).not.toThrow();
  }finally{await rm(root,{recursive:true,force:true});}
});
