import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export const PROBE_SCREENSHOT_MAX_BYTES = 1024 * 1024;

/** Read-only capture. A collection failure is not a functional verdict.
 * The caller owns persistence; timed-out work can never publish a late file.
 */
export async function captureProbeStep(driver, { pathId, stepId, remainingMs }) {
  if (!['A', 'B'].includes(pathId) || typeof stepId !== 'string' ||
      !/^(setup|action|assert):[a-z][a-z0-9-]{0,79}$/.test(stepId) ||
      !Number.isSafeInteger(remainingMs) || remainingMs < 0)
    throw new Error('PROBE_CAPTURE_INPUT_INVALID');
  const deadline = performance.now() + remainingMs;
  async function read(action) {
    const timeout = Math.floor(deadline - performance.now());
    if (timeout <= 0) throw new Error('PROBE_CAPTURE_TIMEOUT');
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(() => action(timeout)),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('PROBE_CAPTURE_TIMEOUT')), timeout); }),
      ]);
    } finally { clearTimeout(timer); }
  }
  const record = { pathId, stepId, capturedAt: new Date().toISOString(),
    state: { status: 'unavailable', reason: 'STATE_UNAVAILABLE' },
    screenshot: { status: 'unavailable', reason: 'SCREENSHOT_UNAVAILABLE' } };
  try {
    const visible = await read(ms => driver.snapshotStates(ms));
    const controlValue = await read(ms => driver.filterValue(ms));
    if (!['all', 'active', 'done'].includes(controlValue) || !Array.isArray(visible) || visible.length > 100 ||
        visible.some(row => !row || typeof row.title !== 'string' || row.title.length > 200 || typeof row.done !== 'boolean'))
      throw new Error('PROBE_CAPTURE_STATE_INVALID');
    const state = { status: 'captured', controlValue, visible: visible.map(({title, done}) => ({title, done})) };
    if (Buffer.byteLength(JSON.stringify(state)) > 2000) throw new Error('PROBE_CAPTURE_STATE_INVALID');
    record.state = state;
  } catch (error) {
    record.state.reason = error?.message === 'PROBE_CAPTURE_TIMEOUT' ? 'TIME_BUDGET' : 'STATE_UNAVAILABLE';
  }
  let png;
  try {
    const bytes = await read(ms => driver.screenshot(ms));
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < PNG_SIGNATURE.length ||
        bytes.byteLength > PROBE_SCREENSHOT_MAX_BYTES || !Buffer.from(bytes.subarray(0, 8)).equals(PNG_SIGNATURE))
      throw new Error('PROBE_CAPTURE_SCREENSHOT_INVALID');
    png = Buffer.from(bytes);
    record.screenshot = { status: 'captured', byteSize: png.length,
      sha256: createHash('sha256').update(png).digest('hex') };
  } catch (error) {
    record.screenshot.reason = error?.message === 'PROBE_CAPTURE_TIMEOUT' ? 'TIME_BUDGET' : 'SCREENSHOT_UNAVAILABLE';
  }
  return { record, png, completeness: record.state.status === 'captured' && record.screenshot.status === 'captured' ? 'complete' : 'partial' };
}
