import { ref } from 'vue';
import { apiV2 } from '../api';

const unknownMessage = '保存回执尚未确认，服务器可能已经处理。输入已保留，没有自动重发；停止等待不代表服务端已取消，也不代表没有模型费用。请先读取最新记录核对。';

export async function courseworkWrite<T = any>(url: string, options: RequestInit = {}): Promise<T> {
  options.signal?.throwIfAborted();
  const controller = new AbortController();
  const cancel = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const result = await apiV2<T>(url, { ...options, signal: controller.signal });
    controller.signal.throwIfAborted();
    if (!result || typeof result !== 'object' || Array.isArray(result) || 'error' in result)
      throw new Error('UNCONFIRMED_RESPONSE');
    return result;
  } catch (failure) {
    const status = (failure as { status?: number })?.status;
    if (controller.signal.aborted || !status || status >= 500)
      throw Object.assign(new Error(unknownMessage), { code: 'COURSEWORK_WRITE_UNKNOWN' });
    throw failure;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', cancel);
  }
}

export function createCourseworkApi(scope: string) {
  const storageKey = `codelab.coursework-unknown:${scope}`;
  const uncertain = ref(false), checking = ref(false), checked = ref(false);
  const controllers = new Set<AbortController>();
  let disposed = false;
  try { uncertain.value = sessionStorage.getItem(storageKey) === '1'; } catch { /* Storage can be unavailable in private contexts. */ }
  function markUnknown() {
    uncertain.value = true;
    checked.value = false;
    try { sessionStorage.setItem(storageKey, '1'); } catch { /* The mounted page still keeps its write lock. */ }
  }
  async function request<T = any>(url: string, options: RequestInit = {}): Promise<T> {
    if ((options.method ?? 'GET').toUpperCase() === 'GET') return apiV2<T>(url, options);
    if (disposed || uncertain.value) throw new Error('请先核对最新记录，再明确确认恢复写入。没有重新发送操作。');
    const controller = new AbortController();
    const cancel = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) options.signal.throwIfAborted();
    options.signal?.addEventListener('abort', cancel, { once: true });
    controllers.add(controller);
    try {
      return await courseworkWrite<T>(url, { ...options, signal: controller.signal });
    } catch (failure) {
      if ((failure as { code?: string })?.code === 'COURSEWORK_WRITE_UNKNOWN') markUnknown();
      throw failure;
    } finally {
      controllers.delete(controller);
      options.signal?.removeEventListener('abort', cancel);
    }
  }
  async function reconcile(read: () => Promise<unknown>) {
    if (disposed || checking.value) return;
    checking.value = true;
    checked.value = false;
    try {
      if (await read() === false) throw new Error('最新记录尚未读取成功，请检查连接后再核对。');
      if (!disposed) checked.value = true;
    } finally { if (!disposed) checking.value = false; }
  }
  function resume() {
    if (!checked.value || checking.value || disposed) return;
    uncertain.value = false;
    checked.value = false;
    try { sessionStorage.removeItem(storageKey); } catch { /* A conservative lock on a future mount is safe. */ }
  }
  function dispose() {
    disposed = true;
    if (controllers.size) markUnknown();
    for (const controller of controllers) controller.abort();
    controllers.clear();
  }
  return { request, uncertain, checking, checked, reconcile, resume, dispose };
}
