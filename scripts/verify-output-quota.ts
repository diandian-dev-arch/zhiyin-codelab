import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {restrictedContainerArgs} from '../apps/runner/src/environment-v2.js';
const exec=promisify(execFile),id=randomUUID(),label=`codelab.output-quota=${id}`;
const directory=path.resolve('docs/verification/2026-09-28',`output-quota-${id}`);
const docker=async(args:string[])=>(await exec('docker',args,{timeout:30000,maxBuffer:1024*1024,windowsHide:true})).stdout;
const image=JSON.parse(await docker(['image','inspect','codelab-build:v2-desktop']))[0].Id;
const owned:string[]=[],results:unknown[]=[],cleanup:unknown[]=[];let failure:string|undefined;
await mkdir(directory,{recursive:true});
try{
  for(const [target,megabytes] of [['/out',64],['/artifacts',32]] as const){
    const name=`codelab-quota-${id}-${megabytes}`;owned.push(name);
    const code=`const fs=require('node:fs'),assert=require('node:assert/strict');let written=0,blocked=false;
      const fd=fs.openSync('${target}/bounded-fill','wx');try{const block=Buffer.alloc(1024*1024,1);
        for(let i=0;i<${megabytes+2};i++){written+=fs.writeSync(fd,block);}}
      catch(e){assert.equal(e.code,'ENOSPC');blocked=true;}finally{fs.closeSync(fd);}
      assert.equal(blocked,true);assert.equal(written,${megabytes}*1024*1024);
      console.log(JSON.stringify({target:'${target}',written,blocked,error:'ENOSPC'}));`;
    await docker(['create','--name',name,'--label',label,'--network','none',...restrictedContainerArgs('256m'),
      '--tmpfs',`${target}:rw,nosuid,nodev,noexec,size=${megabytes}m,uid=1000,gid=1000`,'--entrypoint','node',image,'-e',code]);
    const info=JSON.parse(await docker(['inspect',name]))[0];
    assert.ok(info.Mounts.every((mount:any)=>mount.Type==='tmpfs'));
    await docker(['start',name]);assert.equal((await docker(['wait',name])).trim(),'0');
    results.push({imageId:image,configured:info.HostConfig.Tmpfs,observation:JSON.parse(await docker(['logs',name]))});
  }
}catch(error){failure=error instanceof Error?error.message:'OUTPUT_QUOTA_FAILED';process.exitCode=1;}
finally{
  for(const name of owned){try{const info=JSON.parse(await docker(['inspect',name]))[0];assert.equal(info.Config.Labels['codelab.output-quota'],id);
    await docker(['rm','-f',info.Id]);cleanup.push({name,removed:true});
  }catch{failure??='CLEANUP_FAILED';cleanup.push({name,removed:false});process.exitCode=1;}}
  await writeFile(path.join(directory,'result.json'),JSON.stringify({id,date:new Date().toISOString(),passed:!failure,
    source:'trusted-bounded-tmpfs-fill',results,cleanup,failure},null,2));
  console.log(JSON.stringify({passed:!failure,evidence:path.relative(process.cwd(),directory),failure}));
}
