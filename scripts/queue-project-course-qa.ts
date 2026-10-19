/** Enqueues only a synthetic course analysis on the isolated 3316 UI fixture. */
import { setTimeout as delay } from 'node:timers/promises';

const apiOrigin = 'http://127.0.0.1:3316';
const origin = 'http://localhost:5326';
const taskId = process.argv[2];
if (!taskId || !/^[0-9a-f-]{36}$/i.test(taskId)) throw new Error('Pass the isolated fixture task UUID');
const login = await fetch(`${apiOrigin}/api/v1/session/login`, {
  method:'POST', headers:{Origin:origin,'Content-Type':'application/json'},
  body:JSON.stringify({email:'teacher@codelab.local',password:'Browser-test-only-2904!'}),
});
if (!login.ok) throw new Error(`Fixture login failed: ${login.status}`);
const session = await login.json() as {csrf:string};
const cookie = login.headers.getSetCookie().map(value => value.split(';',1)[0]).join('; ');
const headers = {Cookie:cookie,Origin:origin,'X-CSRF-Token':session.csrf,'Content-Type':'application/json'};
const model = await (await fetch(`${apiOrigin}/api/v2/model-settings`,{headers})).json() as {enabled:boolean;configured:boolean};
const taskResponse = await fetch(`${apiOrigin}/api/v2/project-tasks/${taskId}`,{headers});
if (!taskResponse.ok) throw new Error(`Fixture task read failed: ${taskResponse.status}`);
const task = await taskResponse.json() as {submissions:Array<{id:string;projectName:string}>};
const submission = task.submissions[0];
if (!submission) throw new Error('The fixture task has no student submission');
const started = await fetch(`${apiOrigin}/api/v2/project-submissions/${submission.id}/analyze`,{
  method:'POST',headers,body:JSON.stringify({consent:true,options:{mode:'quick'}}),
});
const receipt = await started.json();
if (!started.ok) throw new Error(`Synthetic analysis request failed: ${started.status} ${JSON.stringify(receipt)}`);
let detail: {pendingAnalysis?:{id:string;status:string;code?:string;report?:{overview?:string}}} = {};
for (let attempt=0;attempt<50;attempt++) {
  const response = await fetch(`${apiOrigin}/api/v2/project-submissions/${submission.id}`,{headers});
  if (!response.ok) throw new Error(`Fixture detail read failed: ${response.status}`);
  detail = await response.json();
  if (detail.pendingAnalysis && !['queued','running'].includes(detail.pendingAnalysis.status)) break;
  await delay(500);
}
console.log(JSON.stringify({taskId,submissionId:submission.id,projectName:submission.projectName,modelSettings:model,receipt,
  pending:detail.pendingAnalysis ? {id:detail.pendingAnalysis.id,status:detail.pendingAnalysis.status,code:detail.pendingAnalysis.code,overview:detail.pendingAnalysis.report?.overview}:null},null,2));
