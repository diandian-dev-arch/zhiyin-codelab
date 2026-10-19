<script setup lang="ts">
import StudioSelect from './StudioSelect.vue';
import { accountDisplayName } from '../lib/account-display';
import { computed, ref, watch, nextTick, onUnmounted } from "vue";
import {
  X,
  KeyRound,
  ExternalLink,
  Check,
  LoaderCircle,
} from "lucide-vue-next";
import { apiV2, useSession } from "../api";
import {
  modelVendors,
  type ModelVendor,
  type PersonalModelState,
} from "@codelab/contracts/model-settings";
const emit = defineEmits<{ changed: [] }>();
const session = useSession();
const dialog = ref<HTMLDialogElement>();
const state = ref<PersonalModelState>();
const vendor = ref<ModelVendor>("deepseek"),
  model = ref("deepseek-flash"),
  apiKey = ref("");
const context = ref<number | "">(""),
  output = ref(12000);
const contextPresets = [
  { value: 32768, label: "32K · 32,768 tokens" },
  { value: 65536, label: "64K · 65,536 tokens" },
  { value: 131072, label: "128K · 131,072 tokens" },
  { value: 262144, label: "256K · 262,144 tokens" },
  { value: 524288, label: "512K · 524,288 tokens" },
  { value: 1000000, label: "1M · 1,000,000 tokens" },
];
const contextChoice = ref("auto");
watch(contextChoice, (choice) => {
  if (choice === "auto") context.value = "";
  else if (choice !== "custom") context.value = Number(choice);
}, { flush: "sync" });
const busy = ref(""),
  error = ref(""),
  notice = ref(""),
  testResult = ref(""),
  confirmRemove = ref(false);
const currentVendor = computed(() => modelVendors[vendor.value]);
const canKeep = computed(
  () =>
    state.value?.configured && state.value.settings?.vendor === vendor.value,
);
const ready = computed(() => state.value?.enabled && !busy.value);
let requestController: AbortController | undefined;
onUnmounted(() => requestController?.abort());
async function request<T = any>(url: string, options: RequestInit = {}, testing = false): Promise<T> {
  const controller = new AbortController();
  requestController = controller;
  const timeout = window.setTimeout(() => controller.abort(), testing ? 40000 : 15000);
  try {
    const result = await apiV2<T>(url, {...options, signal: controller.signal});
    controller.signal.throwIfAborted();
    return result;
  } catch (failure) {
    if (controller.signal.aborted) throw new Error(testing
      ? '连接测试等待超过40秒，尚未收到结果。服务商可能已处理并计费；没有自动重试，请先核对服务商记录。'
      : options.method
        ? '配置请求等待超过15秒，结果尚未确认。请关闭并重新打开设置核对当前配置，避免重复操作。'
        : '读取配置超过15秒，请重新读取或稍后再试。');
    throw failure;
  } finally {
    window.clearTimeout(timeout);
    if (requestController === controller) requestController = undefined;
  }
}
watch([vendor, model, apiKey, context, output], () => {
  testResult.value = "";
  notice.value = "";
  confirmRemove.value = false;
});
function fill() {
  const s = state.value?.settings;
  vendor.value = s?.vendor ?? "deepseek";
  model.value = s?.model ?? "deepseek-flash";
  context.value = s?.contextWindowTokens ?? "";
  contextChoice.value = context.value === "" ? "auto"
    : contextPresets.some(item => item.value === context.value) ? String(context.value) : "custom";
  output.value = s?.maxOutputTokens ?? 12000;
  apiKey.value = "";
  confirmRemove.value = false;
}
async function open() {
  if (busy.value) return;
  error.value = "";
  notice.value = "";
  testResult.value = "";
  state.value = undefined;
  fill();
  dialog.value?.showModal();
  busy.value = "load";
  try {
    state.value = await request<PersonalModelState>("/model-settings");
    fill();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = "";
    await nextTick();
    dialog.value?.querySelector<HTMLButtonElement>('.model-close')?.focus();
  }
}
function trapFocus(event: KeyboardEvent) {
  if (event.key !== 'Tab') return;
  const items = Array.from(dialog.value?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], summary') ?? []).filter(el => el.getClientRects().length && !el.matches(':disabled'));
  const first = items[0], last = items.at(-1);
  if (!first || !last) { event.preventDefault(); return; }
  if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.value)) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}
function close() {
  if (!busy.value) dialog.value?.close();
}
function changeVendor(value: ModelVendor) {
  vendor.value = value;
  model.value = modelVendors[value].defaultModel;
  apiKey.value = "";
  context.value = "";
  contextChoice.value = "auto";
}
function payload() {
  return {
    vendor: vendor.value,
    model: model.value.trim(),
    apiKey: apiKey.value.trim() || undefined,
    contextWindowTokens: context.value === "" ? null : Number(context.value),
    maxOutputTokens: Number(output.value),
  };
}
async function submit(action: "save" | "test" | "remove") {
  if (!ready.value) return;
  error.value = "";
  notice.value = "";
  testResult.value = "";
  if (
    action !== "remove" &&
    (!model.value.trim() || (!apiKey.value.trim() && !canKeep.value))
  ) {
    error.value = "请填写模型名称和 API Key";
    return;
  }
  if (action !== "remove" && contextChoice.value === "custom"
    && (!Number.isInteger(Number(context.value)) || Number(context.value) < 16384 || Number(context.value) > 2000000)) {
    error.value = "请填写 16,384 到 2,000,000 之间的整数容量，或选择自动。";
    return;
  }
  busy.value = action;
  try {
    if (action === "test") {
      const result = await request("/model-settings/test", {
        method: "POST",
        body: JSON.stringify(payload()),
      }, true);
      testResult.value = `连接通过 · ${(result.elapsedMs / 1000).toFixed(1)} 秒${result.usage ? ` · 输入 ${result.usage.inputTokens} / 输出 ${result.usage.outputTokens} tokens` : " · 服务商未返回用量"}。这只验证连接与 JSON 输出，完整分析仍取决于模型能力。`;
    } else {
      state.value = await request<PersonalModelState>("/model-settings", {
        method: action === "save" ? "PUT" : "DELETE",
        ...(action === "save" ? { body: JSON.stringify(payload()) } : {}),
      });
      fill();
      emit("changed");
      // Field watchers clear stale feedback; publish the save receipt after them.
      await Promise.resolve();
      notice.value =
        action === "save"
          ? "配置已保存。之后的新分析使用此账号的模型；保存不会发起付费调用。"
          : "密钥已移除。历史报告仍可查看，新分析需重新配置。";
    }
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = "";
  }
}
defineExpose({ open });
</script>

<template>
  <dialog
    ref="dialog"
    class="personal-model"
    aria-labelledby="personal-model-title"
    aria-describedby="personal-model-billing"
    @keydown="trapFocus"
    @cancel.prevent="close"
    @close="
      apiKey = '';
      testResult = '';
      confirmRemove = false;
    "
  >
    <header class="model-head">
      <div>
        <p class="model-eyebrow">知因 / 我的分析模型</p>
        <h2 id="personal-model-title">个人模型设置</h2>
      </div>
      <button
        class="model-close"
        type="button"
        aria-label="关闭模型设置"
        :disabled="!!busy"
        @click="close"
      >
        <X aria-hidden="true" :size="20" />
      </button>
    </header>
    <div class="model-identity">
      <span
        >{{ accountDisplayName(session.user?.name) }} ·
        {{ session.user?.role === "teacher" ? "教师" : "学生" }}</span
      ><span>{{ session.user?.email }}</span
      ><b>{{
        busy === "load"
          ? "读取配置中"
          : state?.configured
            ? "已保存密钥"
            : "尚未配置"
      }}</b>
    </div>
    <form class="model-form" @submit.prevent="submit('save')">
      <div class="model-columns">
        <div class="model-fields">
          <fieldset :disabled="!ready || state?.active">
            <legend>模型服务商</legend>
            <div class="vendor-options">
              <label
                v-for="(item, value) in modelVendors"
                :key="value"
                :class="{ chosen: vendor === value }"
                ><input
                  type="radio"
                  name="personal-model-vendor"
                  :value="value"
                  :checked="vendor === value"
                  @change="changeVendor(value)" /><span>{{ item.label }}</span
                ><Check aria-hidden="true" v-if="vendor === value" :size="14"
              /></label>
            </div>
            <label class="model-field"
              >模型名称<input
                v-model="model"
                aria-label="模型名称"
                required
                maxlength="100"
                autocomplete="off"
                spellcheck="false"
              /><small
                >输入模型 ID，或从下方选择常用模型。</small
              ></label
            >
            <div class="model-presets" role="group" aria-label="常用模型">
              <button v-for="name in currentVendor.models" :key="name" type="button" :aria-pressed="model === name" @click="model = name">
                <Check aria-hidden="true" v-if="model === name" :size="13" />{{ name }}
              </button>
            </div>
            <label class="model-field"
              >API Key<input
                v-model="apiKey"
                aria-label="API Key"
                type="password"
                :placeholder="
                  canKeep
                    ? '密钥已安全保存；留空保留，填写即可替换'
                    : '粘贴你自己的 API Key'
                "
                :required="!canKeep"
                maxlength="1024"
                autocomplete="off"
                spellcheck="false"
              /><small
                >加密保存，仅用于你的分析。保存后无法查看原文。</small
              ></label
            >
            <details class="model-advanced">
              <summary>高级设置 <span>通常无需修改</span></summary>
              <label class="model-field"
                >上下文窗口<StudioSelect v-model="contextChoice" aria-label="上下文窗口">
                  <option value="auto">自动（推荐）· 使用保守预算</option>
                  <option v-for="preset in contextPresets" :key="preset.value" :value="String(preset.value)">{{ preset.label }}</option>
                  <option value="custom">自定义容量</option>
                </StudioSelect><small>
                  按服务商公布的容量选择，不能超过当前模型的上限；不确定时选自动。
                </small></label>
              <label v-if="contextChoice === 'custom'" class="model-field"
                >自定义上下文（tokens）<input
                  v-model="context"
                  aria-label="自定义上下文（tokens）"
                  type="number"
                  min="16384"
                  max="2000000"
                  step="1"
                  required
                  placeholder="填写模型支持的容量"
                /><small
                  >仅填写服务商公布的实际容量，不会改变模型本身的上限。</small
                ></label
              ><label class="model-field"
                >单次最大输出（tokens）<input
                  v-model="output"
                  type="number"
                  min="1024"
                  max="32768"
                  step="1"
                  required
                /><small
                  >输出预算过低可能截断报告；不是整个任务的总费用上限。</small
                ></label
              >
            </details>
          </fieldset>
        </div>
        <aside class="model-billing" id="personal-model-billing">
          <KeyRound aria-hidden="true" :size="22" />
          <p class="billing-label">调用费用归属</p>
          <h3>你的密钥，<br />你的服务商账户。</h3>
          <p>
            测试连接和项目分析的费用，由模型服务商向此 API Key
            所属账户收取。知因不会替未配置的账号垫付调用。
          </p>
          <div class="billing-rule">
            <strong>发送哪些内容？</strong>
            <p>
              项目分析发送筛选后的源码片段；课程分析还会发送检查结果和证据文字。测试连接仅发送一条短提示，不包含项目源码。
            </p>
          </div>
          <a
            :href="currentVendor.portal"
            target="_blank"
            rel="noopener noreferrer"
            >前往{{ currentVendor.label }}获取密钥 <ExternalLink aria-hidden="true" :size="13"
          /></a>
          <code>{{ currentVendor.baseUrl }}</code>
        </aside>
      </div>
      <div class="model-feedback" aria-live="polite">
        <p v-if="state && !state.enabled" class="model-warning">
          个人模型安全存储尚未就绪，请联系管理员；现有报告仍可查看。
        </p>
        <p v-if="state?.active" class="model-warning">
          当前账号有正在排队或执行的分析。请等待完成或先停止，再修改密钥和模型。关闭并重新打开此窗口可刷新状态。
        </p>
        <p v-if="error" class="model-error" role="alert">{{ error }}</p>
        <button v-if="error && !state && !busy" type="button" @click="open">重新读取配置</button>
        <p v-if="notice" class="model-success">{{ notice }}</p>
        <p v-if="testResult" class="model-success">{{ testResult }}</p>
        <p v-if="busy === 'test'" class="model-pending">
          <LoaderCircle aria-hidden="true" :size="16" /> 正在向服务商验证连接，含网络等待最多 40 秒…
        </p>
        <div v-if="confirmRemove" class="model-remove-confirm">
          <p>移除后将停止提供新的项目分析，历史报告会保留。</p>
          <button type="button" :disabled="!!busy" @click="submit('remove')">
            确认移除密钥</button
          ><button
            type="button"
            :disabled="!!busy"
            @click="confirmRemove = false"
          >
            保留配置
          </button>
        </div>
      </div>
      <footer class="model-footer">
        <button
          v-if="state?.configured"
          class="model-remove"
          type="button"
          :disabled="!ready || state.active"
          @click="confirmRemove = true"
        >
          移除密钥
        </button>
        <div class="model-actions">
          <small>测试会产生少量费用；保存配置不调用模型。</small>
          <div>
            <button
              class="model-test"
              type="button"
              :disabled="!ready"
              @click="submit('test')"
            >
              {{ busy === "test" ? "测试中…" : "测试连接" }}</button
            ><button
              class="model-save"
              type="submit"
              :disabled="!ready || state?.active"
            >
              {{ busy === "save" ? "保存中…" : "保存配置" }}
            </button>
          </div>
        </div>
      </footer>
    </form>
  </dialog>
</template>

<style scoped>
.personal-model { width: min(58rem, calc(100vw - 2rem)); max-height: 90dvh; padding: 0; overflow-y: auto; scroll-padding-block: 7rem 1rem; }
.model-head { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; justify-content: space-between; gap: var(--space-sm); padding: var(--space-md); border-bottom: 1px solid var(--line); background: var(--paper); }
.model-head h2 { margin: 0; font-size: 1.5rem; }
.model-eyebrow { color: var(--muted); font-size: var(--text-xs); margin: 0 0 var(--space-3xs); }
.model-close { min-width: 44px; flex-shrink: 0; padding: var(--space-2xs); }
.model-identity { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-xs); padding: var(--space-sm) var(--space-md); background: var(--surface); color: var(--muted); font-size: var(--text-xs); overflow-wrap: anywhere; }
.model-identity b { color: var(--ink); margin-left: auto; font-weight: 500; }
.model-columns { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr); gap: var(--space-lg); padding: var(--space-md); }
.model-fields { min-width: 0; }
.model-fields fieldset { border: 0; padding: 0; margin: 0; }
.model-fields legend { font-size: var(--text-sm); font-weight: 600; margin-bottom: var(--space-xs); padding: 0; }
.vendor-options { display: flex; gap: var(--space-2xs); flex-wrap: wrap; }
.vendor-options label { display: flex; flex-direction: row; align-items: center; gap: var(--space-2xs); margin: 0; min-height: 44px; padding: var(--space-2xs) var(--space-xs); border: 1px solid var(--line); border-radius: var(--radius-input); cursor: pointer; font-size: var(--text-xs); }
.vendor-options label.chosen { background: var(--accent-soft); border-color: var(--accent); color: var(--accent-ink); }
.vendor-options input { margin: 0; }
.model-field { margin: var(--space-md) 0; }
.model-field small { font-weight: 400; }
.model-presets { display: flex; flex-wrap: wrap; gap: .4rem; margin-top: -.6rem; }
.model-presets button { min-height: 44px; padding: .35rem .65rem; font-size: .75rem; font-weight: 500; background: var(--surface); }
.model-presets button[aria-pressed="true"] { color: var(--accent-ink); background: var(--accent-soft); border-color: color-mix(in srgb, var(--accent) 35%, var(--line)); }
.model-advanced { border-top: 1px solid var(--line); margin-top: var(--space-md); }
.model-advanced summary { font-size: var(--text-sm); }
.model-advanced summary span { font-size: var(--text-xs); color: var(--muted); font-weight: 400; }
.model-billing { padding-left: var(--space-md); border-left: 1px solid var(--line); min-width: 0; }
.model-billing > svg { color: var(--accent); margin-bottom: var(--space-sm); }
.billing-label { color: var(--muted); font-size: var(--text-xs); margin-bottom: var(--space-2xs); }
.model-billing h3 { font-size: var(--text-lg); line-height: 1.5; margin-bottom: var(--space-sm); }
.model-billing p:not(.billing-label) { font-size: var(--text-xs); color: var(--muted); line-height: 1.85; }
.billing-rule { border-top: 1px solid var(--line); padding-top: var(--space-sm); margin-top: var(--space-md); }
.billing-rule strong { font-size: var(--text-xs); }
.model-billing a { display: inline-flex; align-items: center; min-height: 44px; gap: var(--space-2xs); font-size: var(--text-xs); }
.model-billing code { display: block; font-size: var(--text-xs); color: var(--muted); overflow-wrap: anywhere; }
.model-feedback { padding: 0 var(--space-md); }
.model-feedback p { margin: 0 0 var(--space-sm); padding: var(--space-xs); border-radius: var(--radius-input); font-size: var(--text-sm); }
.model-warning { background: var(--warning-soft); color: var(--warning); }
.model-error { background: var(--danger-soft); color: var(--danger); }
.model-success { background: var(--success-soft); color: var(--success); }
.model-pending { display: flex; align-items: center; gap: var(--space-2xs); background: var(--surface); }
.model-remove-confirm { border: 1px solid var(--line); border-radius: var(--radius-input); padding: var(--space-sm); margin-bottom: var(--space-sm); }
.model-remove-confirm p { padding: 0; }
.model-remove-confirm button { margin-right: var(--space-2xs); }
.model-footer { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: var(--space-sm); padding: var(--space-sm) var(--space-md); border-top: 1px solid var(--line); background: var(--paper); }
.model-remove { color: var(--danger); }
.model-actions { margin-left: auto; display: grid; gap: var(--space-2xs); justify-items: end; }
.model-actions > div { display: flex; align-items: center; gap: var(--space-2xs); }
.model-actions small { margin: 0; }
.model-save { background: var(--accent); color: var(--gl-on-c1); border-color: var(--accent); }
.model-save:hover:not(:disabled) { background: var(--accent-hover); border-color: var(--accent-hover); }
@media (max-width: 700px) {
  .personal-model { width: calc(100vw - 1rem); max-height: 94dvh; }
  .model-columns { grid-template-columns: minmax(0,1fr); gap: var(--space-md); padding: var(--space-sm); }
  .model-head, .model-identity, .model-footer { padding: var(--space-sm); }
  .model-billing { border-left: 0; border-top: 1px solid var(--line); padding: var(--space-sm) 0 0; }
  .model-billing h3 br { display: none; }
  .model-identity b { margin-left: 0; }
  .model-feedback { padding-inline: var(--space-sm); }
  .model-actions { justify-items: start; width: 100%; }
  .model-actions > div { width: 100%; }
  .model-actions button { flex: 1; }
}
</style>
