import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { readdir, lstat, open, copyFile } from 'node:fs/promises';
import path from 'node:path';

// Immutable supervisor: child output never shares the export protocol's stdout.
const modes = {
  build: { directory:'/out', bytes:32*1024*1024, count:256, command:'sh', args:['/opt/build.sh'] },
  check: { directory:'/artifacts', bytes:16*1024*1024, count:64, input:'check-request.json', command:'node', args:['/opt/check-v2.mjs'] },
  probe: { directory:'/artifacts', bytes:11*1024*1024, count:12, input:'probe-request.json', command:'node', args:['/opt/probe-v2.mjs'] },
};
const mode=modes[process.argv[2]];
if(!mode || process.argv.length!==3) throw new Error('OUTPUT_MODE_INVALID');
let log=Buffer.alloc(0);
const capture=chunk=>{if(log.length<60000)log=Buffer.concat([log,chunk.subarray(0,60000-log.length)]);};
try {
  if(mode.input) await copyFile(`/input/${mode.input}`,`${mode.directory}/${mode.input}`);
  const child=spawn(mode.command,mode.args,{detached:true,stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',capture);child.stderr.on('data',capture);
  const code=await new Promise((resolve,reject)=>{
    child.once('error',reject);
    child.once('exit',(code)=>{
      // End surviving descendants before traversing untrusted output paths.
      try{process.kill(-child.pid,'SIGKILL');}catch(e){if(e.code!=='ESRCH')return reject(e);}
      resolve(code ?? 137);
    });
  });
  const files=[];let total=0,visited=0;
  async function collect(directory, prefix='', depth=0) {
    if(depth>16)throw new Error('OUTPUT_DEPTH_LIMIT');
    const entries=await readdir(directory);
    if(entries.length>mode.count)throw new Error('OUTPUT_FILE_LIMIT');
    for(const name of entries){
      if(++visited>mode.count*2)throw new Error('OUTPUT_FILE_LIMIT');
      const relative=prefix+name,target=path.join(directory,name),stat=await lstat(target);
      if(stat.isSymbolicLink())throw new Error('OUTPUT_LINK_REJECTED');
      if(stat.isDirectory()){await collect(target,relative+'/',depth+1);continue;}
      if(relative===mode.input)continue;
      if(process.argv[2]==='probe' && (!/^(probe-result\.json|probe-[AB]-[0-9]\.png)$/.test(relative) ||
          stat.size>(relative.endsWith('.png')?1024*1024:65536))) throw new Error('OUTPUT_PROBE_FILE_INVALID');
      if(!stat.isFile() || stat.nlink!==1)throw new Error('OUTPUT_FILE_TYPE_REJECTED');
      if(files.length>=mode.count || stat.size>mode.bytes-total)throw new Error('OUTPUT_SIZE_LIMIT');
      const handle=await open(target,constants.O_RDONLY|constants.O_NOFOLLOW);
      try{
        const info=await handle.stat();
        if(!info.isFile() || info.size!==stat.size || info.ino!==stat.ino)throw new Error('OUTPUT_CHANGED');
        const bytes=Buffer.alloc(info.size);let offset=0;
        while(offset<bytes.length){const read=await handle.read(bytes,offset,bytes.length-offset,offset);if(!read.bytesRead)throw new Error('OUTPUT_CHANGED');offset+=read.bytesRead;}
        if((await handle.stat()).size!==info.size)throw new Error('OUTPUT_CHANGED');
        total+=bytes.length;files.push({path:relative,data:bytes.toString('base64')});
      }finally{await handle.close();}
    }
  }
  if(code===0)await collect(mode.directory);
  process.stdout.write(JSON.stringify({version:1,code,log:log.toString('utf8'),files}));
}catch(e){
  process.stdout.write(JSON.stringify({version:1,code:125,log:log.toString('utf8'),files:[],error:/^OUTPUT_[A-Z_]+$/.test(e.message)?e.message:'OUTPUT_EXPORT_FAILED'}));
}
