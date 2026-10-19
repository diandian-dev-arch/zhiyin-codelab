<script setup lang="ts">
import { computed, ref } from 'vue';
import { Settings2, RefreshCw } from 'lucide-vue-next';
import { modelVendors } from '@codelab/contracts/model-settings';
import { useSession } from '../api';
import PersonalModelDialog from '../components/PersonalModelDialog.vue';
import GlThemeSwitcher from '../components/glass/GlThemeSwitcher.vue';
import { accountDisplayName } from '../lib/account-display';
import { usePersonalModelSummary } from '../lib/use-personal-model-summary';
const session = useSession();
const modelDialog = ref<InstanceType<typeof PersonalModelDialog>>();
const { state, loading, error, refresh } = usePersonalModelSummary();
const configurationStatus = computed(() => !state.value?.enabled ? '服务未启用'
  : state.value.configured && state.value.settings ? '已配置' : '未配置');
</script>
<template>
  <div class="page-heading"><div><h1>我的设置</h1><p class="muted">管理账号信息与个人 AI 模型。</p></div></div>
  <div class="settings-layout">
    <section class="settings-section appearance-section" aria-labelledby="appearance-title">
      <h2 id="appearance-title">外观</h2>
      <GlThemeSwitcher variant="list" />
    </section>
    <section class="settings-section" aria-labelledby="account-title">
      <h2 id="account-title">账号信息</h2>
      <p class="muted">账号资料由课程负责人管理。</p>
      <dl class="account-details">
        <div><dt>姓名</dt><dd>{{ accountDisplayName(session.user?.name) }}</dd></div>
        <div><dt>邮箱</dt><dd>{{ session.user?.email }}</dd></div>
        <div><dt>身份</dt><dd><span class="tag">{{ session.user?.role === 'teacher' ? '教师' : '学生' }}</span></dd></div>
      </dl>
    </section>
    <section class="settings-section" aria-labelledby="model-title">
      <div class="model-heading">
        <h2 id="model-title">个人 AI 模型</h2>
        <button class="primary" @click="modelDialog?.open()"><Settings2 :size="16" aria-hidden="true" />模型设置</button>
      </div>
      <div class="model-summary" :aria-busy="loading" aria-live="polite">
        <p v-if="loading" role="status">正在读取模型配置…</p>
        <div v-else-if="error" class="model-load-error" role="alert">
          <p>{{ error }}</p>
          <button type="button" @click="refresh"><RefreshCw :size="16" aria-hidden="true" />重新读取</button>
        </div>
        <template v-else-if="state">
          <dl class="model-details">
            <div><dt>配置状态</dt><dd><span class="model-status" :class="{ configured: state.enabled && state.configured && state.settings }">{{ configurationStatus }}</span></dd></div>
            <div><dt>服务商</dt><dd>{{ state.settings ? modelVendors[state.settings.vendor]?.label ?? state.settings.vendor : '尚未设置' }}</dd></div>
            <div><dt>模型</dt><dd>{{ state.settings?.model || '尚未设置' }}</dd></div>
          </dl>
          <p v-if="state.active" class="model-active">有分析任务正在运行，完成后可更改配置。</p>
        </template>
      </div>
      <p>配置自己的模型和 API Key，用于项目源码与课程分析。</p>
      <p class="muted">调用费用由你的模型账户承担。密钥加密保存，保存后不会回显。</p>
    </section>
  </div>
  <PersonalModelDialog ref="modelDialog" @changed="refresh" />
</template>
<style scoped>
.settings-layout { display: grid; gap: var(--space-lg); max-width: 56rem; }
.settings-section { min-width: 0; border-top: 1px solid var(--line); padding-top: var(--space-md); }
.settings-section h2 { margin: 0; font-size: 1.125rem; font-weight: 650; }
.settings-section p { color: var(--muted); font-size: .875rem; line-height: 1.8; margin: .5rem 0 0; }
.account-details, .model-details { display: grid; grid-template-columns: minmax(0,1fr) minmax(0,2fr) minmax(0,1fr); gap: var(--space-md); margin: var(--space-sm) 0 0; }
.settings-layout dt { color: var(--muted); font-size: .875rem; margin-bottom: .4rem; }
.settings-layout dd { margin: 0; overflow-wrap: anywhere; line-height: 1.7; }
.model-heading { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: var(--space-xs); }
.model-heading button { min-height: 44px; }
.model-summary { margin-block: var(--space-sm); }
.model-details { grid-template-columns: minmax(0,.8fr) minmax(0,1fr) minmax(0,1.6fr); margin: 0; }
.model-status { color: var(--muted); }
.model-status.configured { color: var(--success); }
.model-load-error { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-xs); }
.model-load-error p { margin: 0; color: var(--danger); }
.model-load-error button { min-height: 44px; }
@media (max-width: 640px) {
  .settings-layout { gap: var(--space-md); }
  .settings-section { padding-top: var(--space-sm); }
  .account-details, .model-details { grid-template-columns: minmax(0,1fr); gap: .65rem; }
  .account-details > div, .model-details > div { display: grid; grid-template-columns: 4.5rem minmax(0,1fr); gap: .5rem; align-items: baseline; }
  .settings-layout dt { margin: 0; }
}
</style>
