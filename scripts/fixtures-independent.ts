import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { zipSync } from 'fflate';
import { templateFiles, root } from '../apps/api/src/template.js';
import { createSourceManifest, sha256, CORE_CASE_IDS } from '../packages/contracts/src/v2/index.js';
const files = await templateFiles();
for (const name of ['App.vue', 'TaskRow.vue', 'domain.ts'])
  files[`src/${name}`] = await readFile(path.join(root, 'fixtures/independent-source', name));
async function archive(sampleId: string, content: Record<string, Buffer>, failures: string[], description: string) {
const bytes = Buffer.from(zipSync(Object.fromEntries(Object.entries(content).sort(([a], [b]) => a.localeCompare(b))), { mtime: new Date(2020,0,1), level: 9 }));
const source = await createSourceManifest(Object.fromEntries(Object.entries(content).filter(([name]) => name.startsWith('src/') || name.startsWith('public/')).map(([name, data]) => [name, data.toString('base64')])));
await writeFile(path.join(root,`fixtures/${sampleId}.zip`),bytes);
return {
  sampleId, implementationFamilyId:'vue-board-options-reducer-family-002',
  purpose:'development', source:'constructed_execution', frozenEvaluationEligible:false,
  authorization:'team-constructed-development-sample', containsStudentSubmission:false,
  implementation:description,
  originalZipSha256:await sha256(bytes), sourceManifestSha256:source.sourceManifestSha256,
  expectedCases:CORE_CASE_IDS.map(caseId=>({caseId,verdict:failures.includes(caseId)?'failed':'passed',basis:'Derived from the explicit implementation mutation before execution; not a measured result.'})),
};
}
const correct = await archive('correct-independent', files, [], 'Vue Options API parent, child row events, immutable reducer, explicit persistence per dispatch; no deep watch or shared template add/filter implementation.');
await writeFile(path.join(root,'fixtures/independent-manifest.json'),JSON.stringify(correct,null,2));
const app = files['src/App.vue'].toString('utf8'), domain = files['src/domain.ts'].toString('utf8');
function replace(source: string, before: string, after: string) {
  if (source.split(before).length !== 2) throw new Error('INDEPENDENT_FIXTURE_ANCHOR_CHANGED');
  return source.replace(before,after);
}
const defects = [];
for (const [sampleId, guard, predicate, failed] of [
  ['validation-empty-defect', "this.title !== '' && !this.title.trim()", "action.title === '' || action.title.trim()", 'VALID-01'],
  ['validation-space-defect', '!this.title.length', 'action.title.length', 'VALID-02'],
] as const) {
  defects.push(await archive(sampleId, { ...files,
    'src/App.vue':Buffer.from(replace(app,'!this.title.trim()',guard)),
    'src/domain.ts':Buffer.from(replace(domain,"return action.title.trim()",`return ${predicate}`)),
  },[failed],`Allows only the named invalid input; all other behavior preserves the independent implementation. ${failed}`));
}
defects.push(await archive('state-reverse-defect', { ...files,
  'src/domain.ts':Buffer.from(replace(domain,'done: !task.done','done: true')),
  'src/TaskRow.vue':Buffer.from(replace(files['src/TaskRow.vue'].toString('utf8'), '@change="$emit(\'toggle\', task.id)"', '@change="($event.target as HTMLInputElement).checked = true; $emit(\'toggle\', task.id)"')),
}, ['STATE-01'], 'Marking done works; reverse changes are visibly forced back to checked and the reducer keeps done=true. Both UI and stored state express the intended defect.'));
await writeFile(path.join(root,'fixtures/independent-defects-manifest.json'),JSON.stringify({samples:defects},null,2));
console.log('Independent sample generated; expected behavior remains separate from execution results.');
