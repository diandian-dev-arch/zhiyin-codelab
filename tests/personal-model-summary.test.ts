import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { usePersonalModelSummary } from '../apps/web/src/lib/use-personal-model-summary';
import { apiV2 } from '../apps/web/src/api';
import type { PersonalModelState } from '../packages/contracts/src/model-settings';

vi.mock('../apps/web/src/api', () => ({ apiV2: vi.fn() }));
const api = vi.mocked(apiV2);
const { effectScope } = createRequire(new URL('../apps/web/package.json', import.meta.url))('vue');
const scopes: Array<{ stop(): void }> = [];
const configured: PersonalModelState = {
  enabled: true, configured: true, settings: {
    vendor: 'deepseek', model: 'deepseek-flash', contextWindowTokens: null, maxOutputTokens: 12000,
  }, revision: 'fixture', updatedAt: null, active: false,
};
function start() {
  const scope = effectScope();
  scopes.push(scope);
  return { scope, summary: scope.run(usePersonalModelSummary)! };
}
async function settled() { await Promise.resolve(); await Promise.resolve(); }
afterEach(() => {
  scopes.splice(0).forEach(scope => scope.stop());
  vi.resetAllMocks();
  vi.useRealTimers();
});

describe('settings model summary', () => {
  it('starts loading and displays only the returned real configuration', async () => {
    api.mockResolvedValueOnce(configured);
    const { summary } = start();
    expect(summary.loading.value).toBe(true);
    expect(summary.state.value).toBeUndefined();
    await settled();
    expect(summary.state.value).toEqual(configured);
    expect(summary.loading.value).toBe(false);
    expect(api).toHaveBeenCalledWith('/model-settings', { signal: expect.any(AbortSignal) });
    expect(api).toHaveBeenCalledTimes(1);
  });

  it('keeps read failure distinct from unconfigured and allows explicit retry', async () => {
    api.mockRejectedValueOnce(new Error('offline'));
    const { summary } = start();
    await settled();
    expect(summary.error.value).not.toBe('');
    expect(summary.state.value).toBeUndefined();
    const empty = { ...configured, configured: false, settings: null };
    api.mockResolvedValueOnce(empty);
    await summary.refresh();
    expect(summary.error.value).toBe('');
    expect(summary.state.value).toEqual(empty);
    expect(api).toHaveBeenCalledTimes(2);
  });

  it('refreshes after a configuration change without accepting an older response', async () => {
    let finishOld!: (value: PersonalModelState) => void;
    api.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
    const { summary } = start();
    const oldSignal = api.mock.calls[0][1]!.signal!;
    const updated = { ...configured, settings: { ...configured.settings!, model: 'deepseek-v4-pro' } };
    api.mockResolvedValueOnce(updated);
    await summary.refresh();
    expect(oldSignal.aborted).toBe(true);
    finishOld(configured);
    await settled();
    expect(summary.state.value).toEqual(updated);
    expect(summary.loading.value).toBe(false);
  });

  it('aborts on leaving the page and ignores late responses', async () => {
    let finish!: (value: PersonalModelState) => void;
    api.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const { scope, summary } = start();
    const signal = api.mock.calls[0][1]!.signal!;
    scope.stop();
    expect(signal.aborted).toBe(true);
    finish(configured);
    await settled();
    expect(summary.state.value).toBeUndefined();
  });

  it('times out one stalled read without retrying or claiming unconfigured', async () => {
    vi.useFakeTimers();
    api.mockImplementationOnce((_url, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const { summary } = start();
    await vi.advanceTimersByTimeAsync(15001);
    expect(summary.loading.value).toBe(false);
    expect(summary.error.value).not.toBe('');
    expect(summary.state.value).toBeUndefined();
    expect(api).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
