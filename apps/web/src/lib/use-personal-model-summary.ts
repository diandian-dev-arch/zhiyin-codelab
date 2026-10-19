import { onScopeDispose, ref } from 'vue';
import { apiV2 } from '../api';
import type { PersonalModelState } from '@codelab/contracts/model-settings';

export function usePersonalModelSummary() {
  const state = ref<PersonalModelState>();
  const loading = ref(false);
  const error = ref('');
  let controller: AbortController | undefined;
  let revision = 0;

  async function refresh() {
    const currentRevision = ++revision;
    controller?.abort();
    const current = new AbortController();
    controller = current;
    loading.value = true;
    error.value = '';
    state.value = undefined;
    const timeout = setTimeout(() => current.abort(), 15000);
    try {
      const result = await apiV2<PersonalModelState>('/model-settings', { signal: current.signal });
      if (currentRevision === revision && !current.signal.aborted) state.value = result;
    } catch {
      if (currentRevision === revision) error.value = '暂时无法读取模型配置，请重试。';
    } finally {
      clearTimeout(timeout);
      if (currentRevision === revision) loading.value = false;
    }
  }

  onScopeDispose(() => { revision++; controller?.abort(); });
  void refresh();
  return { state, loading, error, refresh };
}
