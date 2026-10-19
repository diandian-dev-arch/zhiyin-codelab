import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { dockerCommand } from '../apps/runner/src/environment-v2';
import { transferOutput } from '../apps/runner/src/output-transfer-v2';
vi.mock('../apps/runner/src/environment-v2',()=>({dockerCommand:vi.fn()}));
const directories:string[]=[];
afterEach(async()=>{vi.resetAllMocks();for(const dir of directories.splice(0))await rm(dir,{recursive:true,force:true});});
async function directory(){const dir=await mkdtemp(path.join(tmpdir(),'codelab-transfer-'));directories.push(dir);return dir;}
function reply(files:unknown[],code=0){vi.mocked(dockerCommand).mockResolvedValue({stdout:JSON.stringify({version:1,code,log:'bounded build log',files}),stderr:''} as any);}
it('transfers bounded files only after complete bundle validation',async()=>{
  const dir=await directory();reply([{path:'assets/app.js',data:Buffer.from('export {}').toString('base64')}]);
  expect((await transferOutput('container',dir,'build',5000)).code).toBe(0);
  expect(await readFile(path.join(dir,'assets/app.js'),'utf8')).toBe('export {}');
  expect(vi.mocked(dockerCommand).mock.calls[0][0]).toEqual(['start','--attach','container']);
});
it.each(['../escape','/absolute','valid/../../escape'])('rejects %s before writing any file',async bad=>{
  const dir=await directory();reply([{path:'first.txt',data:'eA=='},{path:bad,data:'eA=='}]);
  await expect(transferOutput('container',dir,'build',5000)).rejects.toThrow();
  expect(await readdir(dir)).toEqual([]);
});
it('rejects oversized probe bytes and duplicate paths before persistence',async()=>{
  const dir=await directory();reply([{path:'probe-result.json',data:Buffer.alloc(1024*1024+1).toString('base64')}]);
  await expect(transferOutput('container',dir,'probe',5000)).rejects.toThrow('OUTPUT_BYTES_INVALID');
  reply([{path:'a',data:'eA=='},{path:'a',data:'eA=='}]);
  await expect(transferOutput('container',dir,'build',5000)).rejects.toThrow('OUTPUT_PATH_INVALID');
  expect(await readdir(dir)).toEqual([]);
});
it('does not persist failed child output',async()=>{
  const dir=await directory();reply([{path:'partial',data:'eA=='}],1);
  expect((await transferOutput('container',dir,'build',5000)).code).toBe(1);
  expect(await readdir(dir)).toEqual([]);
});
it('accepts ten step images plus JSON while retaining per-file limits',async()=>{
  const dir=await directory();
  reply([{path:'probe-result.json',data:Buffer.from('{}').toString('base64')},
    ...Array.from({length:10},(_,i)=>({path:`probe-${i<4?'A':'B'}-${i}.png`,data:Buffer.from('fixture').toString('base64')}))]);
  expect((await transferOutput('container',dir,'probe',5000)).code).toBe(0);
  expect(await readdir(dir)).toHaveLength(11);
  const rejected=await directory();
  reply([{path:'probe-A-0.png',data:Buffer.alloc(1024*1024+1).toString('base64')}]);
  await expect(transferOutput('container',rejected,'probe',5000)).rejects.toThrow('OUTPUT_BYTES_INVALID');
  expect(await readdir(rejected)).toEqual([]);
});
