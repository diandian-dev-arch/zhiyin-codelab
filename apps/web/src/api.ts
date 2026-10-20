import { defineStore } from "pinia";
import { ref } from "vue";
let csrf = "";
export async function api<T = any>(
  url: string,
  options: RequestInit = {},
  version: 1 | 2 = 1,
): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData))
    headers.set("Content-Type", "application/json");
  if (options.method && options.method !== "GET")
    headers.set("X-CSRF-Token", csrf);
  // Callers with their own signal own the deadline (uploads/model tests differ).
  // Default reads must also bound response-body delivery, without retrying writes.
  const controller = !options.signal && (options.method ?? 'GET').toUpperCase() === 'GET'
    ? new AbortController() : undefined;
  const timeout = controller ? setTimeout(() => controller.abort(), 15000) : undefined;
  const signal = options.signal ?? controller?.signal;
  try {
  const r = await fetch(`/api/v${version}` + url, {
    ...options,
    signal,
    headers,
    credentials: "same-origin",
  });
  const data = await r.json().catch(() => ({ error: "服务器未返回有效响应" }));
  signal?.throwIfAborted();
  if (!r.ok)
    throw Object.assign(
      new Error(
        typeof data.error === "object"
          ? data.error.message
          : (data.error ?? `请求失败 ${r.status}`),
      ),
      { code: data.error?.code, status: r.status },
    );
  return data;
  } catch (error) {
    if (controller?.signal.aborted) throw Object.assign(
      new Error('读取等待超过15秒，请检查连接后重试。已有内容不会因此删除。'),
      {code: 'READ_TIMEOUT'},
    );
    throw error;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
export const apiV2 = <T = any>(url: string, options: RequestInit = {}) =>
  api<T>(url, options, 2);

// Bound the whole response, including reading its body. Never retry login
// automatically: the server may already have created a session.
async function sessionRequest(url: string, options: RequestInit = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const result = await api(url, {...options, signal: controller.signal});
    controller.signal.throwIfAborted();
    return result;
  } catch (error) {
    if (controller.signal.aborted)
      throw new Error('连接等待超过15秒，请检查网络后重试。');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
export const useSession = defineStore("session", () => {
  const logoutGuards = new Set<() => boolean>();
  function beforeLogout(guard: () => boolean) {
    logoutGuards.add(guard);
    return () => { logoutGuards.delete(guard); };
  }
  const user = ref<{
      id: string;
      name: string;
      role: string;
      email: string;
    } | null>(null),
    ready = ref(false),
    loading = ref(false),
    loadError = ref(""),
    loggingOut = ref(false),
    logoutError = ref(""),
    authenticating = ref(false),
    executionApproved = ref(false),
    teacherTrial = ref(false),
    businessVersion = ref<1 | 2>(1);
  async function load(requireSession = false) {
    if (loading.value) return;
    loading.value = true;
    try {
      const d = await sessionRequest("/session");
      if (!d || !(d.user === null || (typeof d.user?.id === 'string' &&
        typeof d.user.name === 'string' && typeof d.user.email === 'string' &&
        ['teacher', 'student'].includes(d.user.role)))) throw new Error('INVALID_SESSION_RESPONSE');
      if (requireSession && !d.user) throw new Error('SESSION_NOT_AVAILABLE');
      user.value = d.user;
      csrf = d.csrf;
      executionApproved.value = d.executionApproved;
      teacherTrial.value = d.workspace === 'teacher-trial';
      businessVersion.value = d.businessVersion === 2 ? 2 : 1;
      loadError.value = "";
    } catch (e) {
      user.value = null;
      csrf = "";
      executionApproved.value = false;
      teacherTrial.value = false;
      businessVersion.value = 1;
      if (!requireSession) loadError.value = (e as {status?: number})?.status === 401
        ? ''
        : '暂时无法连接工作台，尚未确认你的登录状态。请检查网络或稍后重试。';
      if (requireSession) throw new Error('暂时无法读取登录状态，请检查网络后重新登录。');
    } finally {
      ready.value = true;
      loading.value = false;
    }
  }
  async function login(email: string, password: string) {
    if (loggingOut.value || authenticating.value)
      throw new Error('账号操作尚未结束，请确认结果后再登录。');
    authenticating.value = true;
    try {
      const d = await sessionRequest("/session/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      csrf = d.csrf;
      // Mount the authenticated workspace only after its API version is known.
      await load(true);
      logoutError.value = "";
    } finally {
      authenticating.value = false;
    }
  }
  async function logout() {
    if (loggingOut.value || authenticating.value) return;
    for (const guard of logoutGuards) if (!guard()) return;
    const account = user.value;
    loggingOut.value = true;
    logoutError.value = "";
    try {
      const response = await sessionRequest("/session/logout", { method: "POST" });
      if (response?.ok !== true) throw new Error('LOGOUT_RESPONSE_UNCONFIRMED');
      if (user.value !== account) return;
      user.value = null;
      csrf = "";
      teacherTrial.value = false;
    } catch (error) {
      if (user.value === account) {
        if ((error as { status?: number })?.status === 401) {
          user.value = null;
          csrf = "";
          teacherTrial.value = false;
        } else {
          logoutError.value = "退出登录未确认，请检查连接后重试。当前页面和未保存内容仍保留。";
        }
      }
    } finally {
      loggingOut.value = false;
    }
  }
  async function reauthenticate(password: string) {
    if (loggingOut.value || authenticating.value)
      throw new Error('账号操作尚未结束，请确认结果后再重新登录。');
    const account = user.value;
    if (!account) throw new Error("请先登录账号");
    authenticating.value = true;
    try {
      const d = await sessionRequest('/session/login', {
        method: 'POST', body: JSON.stringify({email: account.email, password}),
      });
      if (d.user.id !== account.id || d.user.role !== account.role)
        throw new Error('账号身份已变化，请先下载草稿，再重新打开工作台');
      csrf = d.csrf;
      // Keep the mounted editor and its unsaved revision; never reload it here.
    } finally {
      authenticating.value = false;
    }
  }
  return {
    user,
    ready,
    loading,
    loadError,
    loggingOut,
    logoutError,
    authenticating,
    executionApproved,
    teacherTrial,
    businessVersion,
    load,
    login,
    logout,
    beforeLogout,
    reauthenticate,
  };
});
