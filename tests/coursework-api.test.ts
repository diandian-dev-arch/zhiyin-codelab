import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { courseworkWrite, createCourseworkApi } from '../apps/web/src/lib/coursework-api';

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function hangingFetch(stage: 'headers' | 'body') {
  const fetch = vi.fn(async (_url: string, options: RequestInit) => {
    const waiting = new Promise((_, reject) => options.signal!.addEventListener('abort', () => reject(options.signal!.reason)));
    return stage === 'headers' ? waiting : { ok: true, json: () => waiting };
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

describe('coursework scoped write boundaries', () => {
  it.each([null, false, 'unconfirmed', []])('does not accept a non-object successful write receipt: %j', async value => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => value })));
    const page = createCourseworkApi('teacher/invalid-receipt');
    await expect(page.request('/assignments', { method: 'POST' })).rejects.toMatchObject({ code: 'COURSEWORK_WRITE_UNKNOWN' });
    expect(page.uncertain.value).toBe(true);
  });
  it.each(['headers', 'body'] as const)('bounds stalled %s to 15 seconds and never retries the write', async stage => {
    vi.useFakeTimers();
    const fetch = hangingFetch(stage);
    const result = expect(courseworkWrite('/assignments', { method: 'POST', body: '{}' })).rejects.toMatchObject({ code: 'COURSEWORK_WRITE_UNKNOWN' });
    await vi.advanceTimersByTimeAsync(15001);
    await result;
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][1].signal!.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('composes an external cancellation with its own deadline and does not dispatch a pre-aborted request', async () => {
    vi.useFakeTimers();
    const fetch = hangingFetch('headers');
    const caller = new AbortController();
    const result = expect(courseworkWrite('/imports', { method: 'POST', signal: caller.signal })).rejects.toMatchObject({ code: 'COURSEWORK_WRITE_UNKNOWN' });
    caller.abort();
    await result;
    expect(fetch.mock.calls[0][1].signal).not.toBe(caller.signal);
    expect(fetch.mock.calls[0][1].signal!.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await expect(courseworkWrite('/imports', { method: 'POST', signal: caller.signal })).rejects.toBe(caller.signal.reason);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('locks unknown creates until a successful read and explicit recovery; reopening the page does not bypass it', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError('offline')).mockResolvedValue({ ok: true, json: async () => ({ items: [] }) });
    vi.stubGlobal('fetch', fetch);
    const page = createCourseworkApi('teacher/assignments');
    await expect(page.request('/assignments', { method: 'POST', body: '{}' })).rejects.toMatchObject({ code: 'COURSEWORK_WRITE_UNKNOWN' });
    expect(page.uncertain.value).toBe(true);
    await expect(page.request('/assignments', { method: 'POST' })).rejects.toThrow('请先核对');
    const reopened = createCourseworkApi('teacher/assignments');
    expect(reopened.uncertain.value).toBe(true);
    expect(createCourseworkApi('other-account/assignments').uncertain.value).toBe(false);
    reopened.resume();
    expect(reopened.uncertain.value).toBe(true);
    await expect(reopened.reconcile(async () => false)).rejects.toThrow('尚未读取成功');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('requires a successful readonly reconciliation, does not replay from resume, and preserves GET API semantics', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError('offline')).mockResolvedValue({ ok: true, json: async () => ({ items: [] }) });
    vi.stubGlobal('fetch', fetch);
    const page = createCourseworkApi('teacher/submission');
    await expect(page.request('/course-evaluations/e/publish', { method: 'POST' })).rejects.toThrow();
    await expect(page.reconcile(async () => false)).rejects.toThrow('尚未读取成功');
    page.resume();
    expect(page.uncertain.value).toBe(true);
    await page.reconcile(() => page.request('/course-submissions/s'));
    expect(page.checked.value).toBe(true);
    expect(page.uncertain.value).toBe(true);
    const calls = fetch.mock.calls.length;
    page.resume();
    expect(fetch).toHaveBeenCalledTimes(calls);
    expect(page.uncertain.value).toBe(false);
    expect(createCourseworkApi('teacher/submission').uncertain.value).toBe(false);
  });

  it('keeps the original idempotency key and body unchanged for an explicitly confirmed same-request retry', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError('offline')).mockResolvedValue({ ok: true, json: async () => ({ submission: { id: 'same-receipt' } }) });
    vi.stubGlobal('fetch', fetch);
    const page = createCourseworkApi('student/task');
    const options = { method: 'POST', headers: { 'idempotency-key': 'stable-key' }, body: '{"snapshotId":"fixed"}' };
    await expect(page.request('/course-tasks/t/submissions', options)).rejects.toThrow();
    await page.reconcile(async () => true);
    page.resume();
    await expect(page.request('/course-tasks/t/submissions', options)).resolves.toEqual({ submission: { id: 'same-receipt' } });
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [, sent] of fetch.mock.calls) {
      expect((sent.headers as Headers).get('idempotency-key')).toBe('stable-key');
      expect(sent.body).toBe(options.body);
    }
  });

  it('cancels a mounted write on disposal and retains the unknown lock for a later mount', async () => {
    const fetch = hangingFetch('body');
    const page = createCourseworkApi('student/task');
    const result = expect(page.request('/imports', { method: 'POST' })).rejects.toMatchObject({ code: 'COURSEWORK_WRITE_UNKNOWN' });
    await Promise.resolve();
    page.dispose();
    await result;
    expect(fetch).toHaveBeenCalledOnce();
    expect(createCourseworkApi('student/task').uncertain.value).toBe(true);
  });

  it('keeps confirmed 4xx validation failures retryable, but treats 5xx and malformed successful receipts as unknown', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: { message: '请填写任务名称' } }) })));
    const page = createCourseworkApi('teacher/task');
    await expect(page.request('/assignments', { method: 'POST' })).rejects.toThrow('请填写任务名称');
    expect(page.uncertain.value).toBe(false);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: 'server' }) })));
    await expect(page.request('/assignments', { method: 'POST' })).rejects.toMatchObject({ code: 'COURSEWORK_WRITE_UNKNOWN' });
    expect(page.uncertain.value).toBe(true);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => { throw new Error('invalid json'); } })));
    await expect(courseworkWrite('/assignments', { method: 'POST' })).rejects.toMatchObject({ code: 'COURSEWORK_WRITE_UNKNOWN' });
  });
});
