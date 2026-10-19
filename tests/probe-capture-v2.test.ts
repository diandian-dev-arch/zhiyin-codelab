import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
const modulePath = '../deploy/executor/v2-probe-capture.mjs';
const { captureProbeStep, PROBE_SCREENSHOT_MAX_BYTES } = await import(modulePath);
// Actual 1x1 PNG, not a fabricated page screenshot.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE1sAAAAASUVORK5CYII=', 'base64');
const input = { pathId: 'A', stepId: 'action:select-done', remainingMs: 1000 };
function driver() { return {
  snapshotStates: vi.fn(async () => [{ title: 'owned-task', done: true }]),
  filterValue: vi.fn(async () => 'done'),
  screenshot: vi.fn(async () => png),
}; }
describe('probe step capture boundary', () => {
  it('binds actual captured state and image bytes without producing a verdict', async () => {
    const result = await captureProbeStep(driver(), input);
    expect(result.completeness).toBe('complete');
    expect(result.record).toMatchObject({pathId:'A',stepId:input.stepId,state:{status:'captured',controlValue:'done',visible:[{title:'owned-task',done:true}]},
      screenshot:{status:'captured',byteSize:png.length,sha256:createHash('sha256').update(png).digest('hex')}});
    expect(result.png).toEqual(png);
    expect(result.record).not.toHaveProperty('verdict');
  });
  it('keeps state when screenshot fails and never leaks arbitrary driver error text', async () => {
    const d = driver(); d.screenshot.mockRejectedValue(new Error('private internal path or page text'));
    const result = await captureProbeStep(d, input);
    expect(result.completeness).toBe('partial');
    expect(result.record.state.status).toBe('captured');
    expect(result.record.screenshot).toEqual({status:'unavailable',reason:'SCREENSHOT_UNAVAILABLE'});
    expect(result.png).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('private internal');
  });
  it('does not invent state when controls are ambiguous but retains the screenshot', async () => {
    const d = driver(); d.filterValue.mockResolvedValue('ambiguous');
    const result = await captureProbeStep(d, input);
    expect(result.completeness).toBe('partial');
    expect(result.record.state.status).toBe('unavailable');
    expect(result.png).toEqual(png);
  });
  it('rejects empty, non-PNG and oversized screenshot output', async () => {
    for (const bytes of [Buffer.alloc(0), Buffer.from('not png'), Buffer.alloc(PROBE_SCREENSHOT_MAX_BYTES + 1)]) {
      const d = driver(); d.screenshot.mockResolvedValue(bytes);
      expect((await captureProbeStep(d,input)).record.screenshot.status).toBe('unavailable');
    }
  });
  it('uses one deadline and cannot append late screenshot bytes to returned evidence', async () => {
    const d = driver(); let resolve!: (value: typeof png) => void;
    d.screenshot.mockImplementation(() => new Promise(r => { resolve = r; }));
    const result = await captureProbeStep(d,{...input,remainingMs:30});
    expect(result.record.screenshot).toEqual({status:'unavailable',reason:'TIME_BUDGET'});
    const before = JSON.stringify(result);
    resolve(png); await Promise.resolve(); await Promise.resolve();
    expect(JSON.stringify(result)).toBe(before);
    expect(result.png).toBeUndefined();
  });
  it('does no reads after exhausted budget and rejects untrusted identity before reads', async () => {
    const d = driver();
    expect((await captureProbeStep(d,{...input,remainingMs:0})).completeness).toBe('partial');
    for (const changed of [{pathId:'C'},{stepId:'../../secret'},{remainingMs:-1}])
      await expect(captureProbeStep(d,{...input,...changed})).rejects.toThrow('PROBE_CAPTURE_INPUT_INVALID');
    expect(d.snapshotStates).not.toHaveBeenCalled();
    expect(d.screenshot).not.toHaveBeenCalled();
  });
});
