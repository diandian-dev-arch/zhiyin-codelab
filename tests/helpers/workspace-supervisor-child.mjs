import { createServer } from 'node:http';
const mode = process.argv[2];
if (mode === 'startup-fail') process.exit(9);
const server = createServer((_req, res) => res.end('ready'));
server.listen(0, '127.0.0.1', () => {
  if (mode !== 'no-ready') process.send({ type: 'codelab-workspace-ready', port: server.address().port });
  if (mode === 'crash') setTimeout(() => process.exit(7), 30);
  if (mode === 'clean') server.close(() => process.exit(0));
});
process.on('message', message => {
  if (mode !== 'ignore-stop' && message?.type === 'codelab-workspace-stop') server.close(() => process.exit(0));
});
