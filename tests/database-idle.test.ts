import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { postgres } from '../apps/api/src/db.js';

describe.skipIf(!process.env.CODELAB_TEST_POSTGRES_URL)('real PostgreSQL idle connection loss', () => {
  it('keeps the process alive and reconnects after an idle backend is terminated', async () => {
    const admin = postgres(process.env.CODELAB_TEST_POSTGRES_URL);
    const child = fork(fileURLToPath(new URL('./helpers/database-idle-child.ts', import.meta.url)), [], {
      execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
    });
    let stderr = '';
    child.stderr!.on('data', (chunk) => { stderr += chunk.toString(); });
    const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
    const receive = () => new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('Child response timeout')), 10000);
      const onExit = () => finish(new Error('Database child exited before response'));
      const onMessage = (value: unknown) => finish(undefined, value);
      const finish = (error?: Error, value?: unknown) => {
        clearTimeout(timer); child.off('exit', onExit); child.off('message', onMessage);
        if (error) reject(error); else resolve(value);
      };
      child.once('exit', onExit); child.once('message', onMessage);
    });
    try {
      const ready = await receive();
      expect(ready.type).toBe('ready');
      await admin.query('SELECT pg_terminate_backend($1)', [ready.pid]);
      // Wait for the asynchronous server error to reach the idle pool before querying.
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(child.exitCode, 'idle disconnect must not crash the process').toBeNull();
      const response = receive(); child.send('query');
      expect(await response).toEqual({ type: 'query', value: 1 });
      expect(stderr).toContain('DATABASE_IDLE_CONNECTION_LOST');
      expect(stderr).not.toContain(process.env.CODELAB_TEST_POSTGRES_URL!);
      await expect(admin.query('SELECT 1 / 0')).rejects.toMatchObject({ code: '22012' });
      await expect(admin.transaction(async (tx) => {
        await tx.query('SELECT 1 / 0');
      })).rejects.toMatchObject({ code: '22012' });
      expect((await admin.query('SELECT 1 AS value')).rows[0].value).toBe(1);
      child.send('close');
      expect(await exited).toBe(0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited; await admin.close();
    }
  });
});
