import { postgres } from '../../apps/api/src/db.js';

const db = postgres(process.env.CODELAB_TEST_POSTGRES_URL);
process.on('message', async (message) => {
  if (message === 'query') {
    try {
      const result = await db.query('SELECT 1 AS value');
      process.send?.({ type: 'query', value: result.rows[0].value });
    } catch { process.send?.({ type: 'query_failed' }); }
  }
  if (message === 'close') {
    await db.close();
    process.disconnect();
  }
});
const result = await db.query('SELECT pg_backend_pid() AS pid');
process.send?.({ type: 'ready', pid: result.rows[0].pid });
