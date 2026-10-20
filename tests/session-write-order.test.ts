import { createRequire } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';
import { useSession } from '../apps/web/src/api';

const { createPinia } = createRequire(new URL('../apps/web/package.json', import.meta.url))('pinia');
const account = { id: 'teacher', role: 'teacher', name: 'Teacher', email: 'teacher@example.test' };
const response = (data: unknown) => ({ ok: true, json: async () => data });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('uses only the authenticated session response for trial presentation and resets it across accounts and failures', async () => {
  const session = useSession(createPinia());
  const fetch = vi.fn(async () => response({ user: account, csrf: 'test-csrf', businessVersion: 2, workspace: 'teacher-trial' }));
  vi.stubGlobal('fetch', fetch);
  await session.load();
  expect(session.teacherTrial).toBe(true);
  fetch.mockImplementation(async () => response({ user: account, csrf: 'test-csrf', businessVersion: 2 } as any));
  await session.load();
  expect(session.teacherTrial).toBe(false);
  fetch.mockImplementation(async () => response({ user: account, csrf: 'test-csrf', businessVersion: 2, workspace: 'teacher-trial' }));
  await session.load();
  await session.logout();
  // An unconfirmed logout must not change the mounted account's presentation.
  expect(session.teacherTrial).toBe(true);
  fetch.mockImplementation(async () => response({ ok: true } as any));
  await session.logout();
  expect(session.teacherTrial).toBe(false);
  session.teacherTrial = true;
  fetch.mockImplementation(async () => { throw new TypeError('fixture offline'); });
  await session.load();
  expect(session.teacherTrial).toBe(false);
});

it('does not issue either authentication write while logout is pending', async () => {
  const session = useSession(createPinia());
  session.user = { ...account };
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fetch = vi.fn(async () => { await gate; return response({ ok: true }); });
  vi.stubGlobal('fetch', fetch);
  const pending = session.logout();
  expect(session.loggingOut).toBe(true);
  try {
    await expect(session.reauthenticate('test-only')).rejects.toThrow('账号操作尚未结束');
    await expect(session.login(account.email, 'test-only')).rejects.toThrow('账号操作尚未结束');
    await session.logout();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(session.user?.id).toBe(account.id);
  } finally { release(); await pending; }
  expect(session.user).toBeNull();
  expect(session.loggingOut).toBe(false);
});

it('does not issue logout while same-account reauthentication is pending', async () => {
  const session = useSession(createPinia());
  session.user = { ...account };
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fetch = vi.fn(async () => { await gate; return response({ user: account, csrf: 'new-fixture-csrf' }); });
  vi.stubGlobal('fetch', fetch);
  const pending = session.reauthenticate('test-only');
  expect(session.authenticating).toBe(true);
  try {
    await session.logout();
    await expect(session.login(account.email, 'test-only')).rejects.toThrow('账号操作尚未结束');
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally { release(); await pending; }
  expect(session.user?.id).toBe(account.id);
  expect(session.authenticating).toBe(false);
});

it('respects an unsaved-work logout guard without sending any request', async () => {
  const session = useSession(createPinia());
  session.user = { ...account };
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const remove = session.beforeLogout(() => false);
  await session.logout();
  expect(fetch).not.toHaveBeenCalled();
  expect(session.user?.id).toBe(account.id);
  expect(session.loggingOut).toBe(false);
  remove();
});

it('releases authentication protection after a rejected request without clearing the editor account', async () => {
  const session = useSession(createPinia());
  session.user = { ...account };
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fixture offline'); }));
  await expect(session.reauthenticate('test-only')).rejects.toThrow('fixture offline');
  expect(session.authenticating).toBe(false);
  expect(session.user?.id).toBe(account.id);
});
