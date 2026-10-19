import {it,expect} from 'vitest';
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {unzipSync} from 'fflate';
import {root,templateFiles,templateZip,hashTemplateFiles} from '../apps/api/src/template';

it('matches the independent executor measurement algorithm and the delivered ZIP bytes',async()=>{
  const files=await templateFiles();
  const actual=hashTemplateFiles(files);
  // Execute the original measurement script with only its trusted absolute input paths relocated.
  let script=await readFile(path.join(root,'deploy/executor/measure-build.mjs'),'utf8');
  script=script.replaceAll("'/opt/template-reference'",JSON.stringify(path.join(root,'templates/vue-board-v1')))
    .replaceAll("'/opt/template/package-lock.json'",JSON.stringify(path.join(root,'templates/vue-board-v1/package-lock.json')))
    .replaceAll("'/opt/build.sh'",JSON.stringify(path.join(root,'deploy/executor/build.sh')));
  const measured=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',windowsHide:true}));
  expect(actual).toBe(measured.templateHash);
  expect(hashTemplateFiles(unzipSync(await templateZip(files)))).toBe(actual);
  expect(hashTemplateFiles(Object.fromEntries(Object.entries(files).reverse()))).toBe(actual);
  expect(hashTemplateFiles({...files,'index.html':Buffer.concat([files['index.html'],Buffer.from('\n')])})).not.toBe(actual);
  expect(hashTemplateFiles({...files,'unexpected.txt':Buffer.from('extra')})).not.toBe(actual);
});
