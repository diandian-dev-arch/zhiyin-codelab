/** Prepares only the isolated course UI server on 3316/5326. Never loads .env. */
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';

const origin = 'http://localhost:5326';
const apiOrigin = 'http://127.0.0.1:3316';
const password = 'Browser-test-only-2904!';
const login = await fetch(`${apiOrigin}/api/v1/session/login`, {
  method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'teacher@codelab.local', password }),
});
if (!login.ok) throw new Error(`Isolated fixture login failed: ${login.status}`);
const session = await login.json() as { csrf: string };
const cookie = login.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ');
const headers = { Cookie: cookie, Origin: origin, 'X-CSRF-Token': session.csrf, 'Content-Type': 'application/json' };
const classes = await (await fetch(`${apiOrigin}/api/v1/classes`, { headers })).json() as { items: Array<{id:string}> };
const classId = classes.items[0]?.id;
if (!classId) throw new Error('Isolated fixture class was not seeded');
const peerEmail = 'ui-peer-course@codelab.local';
const members = await (await fetch(`${apiOrigin}/api/v1/classes/${classId}/students?email=${encodeURIComponent(peerEmail)}`, { headers })).json() as { items: Array<{id:string}> };
if (!members.items.length) {
  const created = await fetch(`${apiOrigin}/api/v1/classes/${classId}/students`, {
    method: 'POST', headers, body: JSON.stringify({email: peerEmail, name: '互评同学', password}),
  });
  if (!created.ok) throw new Error(`Isolated peer creation failed: ${created.status}`);
}
const directory = await mkdtemp(path.join(os.tmpdir(), 'codelab-project-course-qa-'));
const zipPath = path.join(directory, 'hello-project.zip');
await writeFile(zipPath, zipSync({
  'hello/app.py': strToU8('def greet(name):\n    return f"Hello, {name}"\n\nprint(greet("class"))\n'),
  'hello/README.md': strToU8('# Course UI fixture\n\nSynthetic example for project upload and course review. No real student data.\n'),
}));
console.log(JSON.stringify({origin, teacher:'teacher@codelab.local', student:'student@codelab.local', peer:peerEmail, password, zipPath}, null, 2));
