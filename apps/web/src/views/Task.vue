<script setup lang="ts">
import StudioSelect from '../components/StudioSelect.vue';
import { ref, onMounted, onUnmounted } from "vue";
import { useRoute } from "vue-router";
import { api, useSession } from "../api";
import {
  statusLabels,
  defaultCriteria,
  type Criterion,
} from "@codelab/contracts";
import { Download, Upload, ArrowUpRight, RefreshCw } from "lucide-vue-next";
const id = String(useRoute().params.id),
  s = useSession(),
  task = ref<any>(null),
  items = ref<any[]>([]),
  error = ref(""),
  message = ref(""),
  busy = ref(false),
  showRules = ref(false),
  criteria = ref<Criterion[]>([]),
  summary = ref<any>(null),
  file = ref<File | null>(null);
let timer: ReturnType<typeof setInterval>;
async function load() {
  try {
    const [t, list] = await Promise.all([
      api("/tasks/" + id),
      api(`/tasks/${id}/submissions`),
    ]);
    task.value = t;
    items.value = list.items;
    if (!showRules.value)
      criteria.value = structuredClone(t.rules[0]?.criteria ?? []);
    if (s.user?.role === "teacher")
      summary.value = await api(`/tasks/${id}/summary`);
  } catch (e) {
    error.value = (e as Error).message;
  }
}
onMounted(() => {
  load();
  timer = setInterval(() => {
    if (
      items.value.some((i) =>
        ["queued", "building", "analyzing"].includes(i.status),
      )
    )
      load();
  }, 4000);
});
onUnmounted(() => clearInterval(timer));
async function run(submissionId: string) {
  try {
    await api(`/submissions/${submissionId}/runs`, {
      method: "POST",
      headers: { "Idempotency-Key": crypto.randomUUID() },
    });
    message.value = "已进入检查队列。";
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  }
}
async function upload() {
  if (!file.value) return;
  busy.value = true;
  error.value = "";
  message.value = "";
  try {
    const form = new FormData();
    form.append("file", file.value);
    const r = await api(`/tasks/${id}/submissions`, {
      method: "POST",
      body: form,
      headers: { "Idempotency-Key": crypto.randomUUID() },
    });
    message.value = "提交已保存：" + r.id;
    await run(r.id);
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
async function publishRule() {
  try {
    await api(`/tasks/${id}/rules`, {
      method: "POST",
      body: JSON.stringify({ criteria: criteria.value }),
    });
    showRules.value = false;
    message.value = "新规则已发布，历史报告继续引用原版本。";
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  }
}
async function cancel(runId: string) {
  try {
    await api(`/runs/${runId}/cancel`, { method: "POST" });
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  }
}
const date = (value: string) =>
  new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
</script>
<template>
  <RouterLink to="/" class="back">← 实训任务</RouterLink>
  <p v-if="error" class="error" role="alert">{{ error }}</p>
  <p v-if="message" class="notice" role="status">{{ message }}</p>
  <p v-if="s.businessVersion === 2" class="notice">
    以下为旧版历史记录，仅供读取。<RouterLink :to="'/tasks/' + id"
      >返回当前任务</RouterLink
    >
  </p>
  <template v-if="task"
    ><div class="page-heading">
      <div>
        <p class="eyebrow">VUE PROJECT LAB</p>
        <h1>{{ task.title }}</h1>
        <p class="muted">
          模板 {{ task.rules[0]?.template_version ?? "暂无旧版规则" }} ·
          当前规则 v{{ task.rules[0]?.version ?? "—" }}
        </p>
      </div>
      <a class="button" :href="`/api/v1/tasks/${id}/template`"
        ><Download aria-hidden="true" :size="16" />下载项目模板</a
      >
    </div>
    <p class="task-intro">{{ task.description }}</p>
    <div class="task-columns">
      <section class="panel requirements">
        <div class="section-heading">
          <h2>验收要求</h2>
          <button
            v-if="s.user?.role === 'teacher' && s.businessVersion === 1"
            class="text-button"
            @click="showRules = !showRules"
          >
            {{ showRules ? "收起" : "调整规则" }}
          </button>
        </div>
        <template v-if="!showRules"
          ><div
            v-for="(c, i) in task.rules[0]?.criteria ?? []"
            class="criterion"
          >
            <span class="criterion-number">{{
              String(i + 1).padStart(2, "0")
            }}</span>
            <div>
              <strong>{{ c.title }}</strong
              ><small
                >{{ c.mode === "auto" ? "自动行为检查" : "教师人工判断"
                }}{{ c.note ? " · " + c.note : "" }}</small
              >
            </div>
          </div></template
        >
        <form v-else @submit.prevent="publishRule">
          <div v-for="c in criteria" class="rule-editor">
            <label
              >稳定编号<input
                v-model="c.id"
                required
                pattern="[a-z][a-z0-9_-]*" /></label
            ><label>要求<input v-model="c.title" required /></label
            ><label
              >检查方式<StudioSelect v-model="c.mode">
                <option value="auto">自动检查</option>
                <option value="manual">人工判断</option>
              </StudioSelect></label
            ><label v-if="c.mode === 'auto'"
              >检查定义<StudioSelect v-model="c.check">
                <option v-for="d in defaultCriteria" :value="d.check">
                  {{ d.title }}
                </option>
              </StudioSelect></label
            ><label
              >补充说明<textarea v-model="c.note" rows="2"></textarea></label
            ><button
              type="button"
              @click="criteria = criteria.filter((x) => x !== c)"
            >
              移除此项
            </button>
          </div>
          <button
            type="button"
            @click="
              criteria.push({
                id: 'manual_' + criteria.length,
                title: '人工验收项',
                mode: 'manual',
                note: '',
              })
            "
          >
            添加人工条目
          </button>
          <p class="hint">
            发布后不可改写；学生后续提交使用新规则。不同规则不直接比较。
          </p>
          <button class="primary">发布新规则版本</button>
        </form>
      </section>
      <div class="submissions-area">
        <section
          v-if="s.user?.role === 'student' && s.businessVersion === 1"
          class="panel upload-panel"
        >
          <div>
            <Upload aria-hidden="true" :size="24" />
            <h2>提交项目</h2>
            <p class="muted">
              ZIP ≤ 10 MB，只修改 src/ 与允许的 public/ 资源。
            </p>
          </div>
          <form @submit.prevent="upload">
            <label
              >项目 ZIP<input
                type="file"
                accept=".zip,application/zip"
                required
                @change="
                  file = ($event.target as HTMLInputElement).files?.[0] ?? null
                " /></label
            ><button class="primary" :disabled="busy">
              {{ busy ? "正在保存…" : "上传并发起检查" }}
            </button>
          </form>
        </section>
        <section v-if="summary" class="summary-strip">
          <div>
            <strong>{{ summary.statuses.review ?? 0 }}</strong
            ><span>待复核运行</span>
          </div>
          <div>
            <strong>{{ summary.buildErrors }}</strong
            ><span>项目构建错误</span>
          </div>
          <div>
            <strong>{{ summary.infraErrors }}</strong
            ><span>执行环境故障</span>
          </div>
          <a :href="`/api/v1/tasks/${id}/export`">导出 CSV</a>
        </section>
        <section class="panel submissions-panel">
          <div class="section-heading">
            <h2>{{ s.user?.role === "teacher" ? "学生提交" : "提交历史" }}</h2>
            <button class="text-button" @click="load">
              <RefreshCw aria-hidden="true" :size="15" />刷新
            </button>
          </div>
          <div v-if="!items.length" class="empty compact">
            <h3>等待第一份提交</h3>
            <p>上传后会保留独立版本，历史报告不会被覆盖。</p>
          </div>
          <div v-else class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>提交</th>
                  <th>状态</th>
                  <th>时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="item in items" :key="item.id">
                  <td>
                    <strong>{{ item.name }}</strong
                    ><small
                      >{{ item.sha256.slice(0, 8) }} · 规则 v{{
                        item.rule_version
                      }}</small
                    >
                  </td>
                  <td>
                    <span :class="['status', item.status]">{{
                      statusLabels[item.status] ?? "已保存"
                    }}</span
                    ><small v-if="item.outcome === 'build_error'"
                      >项目构建错误</small
                    ><small v-if="item.model_status === 'unconfigured'"
                      >基础检查报告</small
                    >
                  </td>
                  <td class="mono small">{{ date(item.created_at) }}</td>
                  <td>
                    <RouterLink
                      v-if="item.run_id"
                      :to="
                        (s.businessVersion === 2 ? '/legacy/runs/' : '/runs/') +
                        item.run_id
                      "
                      class="table-link"
                      >{{
                        item.status === "review" && s.user?.role === "teacher"
                          ? "复核报告"
                          : "查看"
                      }}<ArrowUpRight aria-hidden="true" :size="15" /></RouterLink
                    ><button
                      v-if="
                        s.businessVersion === 1 &&
                        (!item.status ||
                          [
                            'infra_error',
                            'cancelled',
                            'published',
                            'review',
                          ].includes(item.status))
                      "
                      class="text-button"
                      @click="run(item.id)"
                    >
                      {{ item.run_id ? "重新检查" : "发起检查" }}</button
                    ><button
                      v-if="item.status === 'queued' && s.businessVersion === 1"
                      class="text-button"
                      @click="cancel(item.run_id)"
                    >
                      取消排队
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
        <details
          v-if="summary && Object.keys(summary.failures).length"
          class="panel"
        >
          <summary>高频未满足项 · 所有运行，含重跑</summary>
          <p v-for="(n, k) in summary.failures">
            {{
              task.rules[0].criteria.find((c: any) => c.id === k)?.title ?? k
            }}：{{ n }} 次
          </p>
        </details>
      </div>
    </div></template
  >
  <div v-else class="loading">正在读取任务…</div>
</template>
