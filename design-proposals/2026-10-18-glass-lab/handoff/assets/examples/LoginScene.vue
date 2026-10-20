<!--
  参考实现 · 登录页分屏场景
  -------------------------------------------------------------
  左：液体水波 + 检查核心 + 公转证据标签 + 身份标语；右：玻璃登录卡。
  ⚠ 与测试耦合的约定（来自 tests/e2e-login、tests/e2e-design，必须保留）：
    · 根容器类名 .login-container；表单 form.login-form
    · 输入框可访问名称正好是「邮箱」「密码」（getByLabel(..., {exact:true})）
    · 提交按钮名称正好是「登录」；密码可见切换按钮名「显示密码」/「隐藏密码」
    · 密码框聚焦时 outline 不能为 none（组件层 .gl-input:focus 已满足）
    · 错误信息使用 role="alert"
  ⚠ 身份切换只改变视觉与示意文案，不改变登录请求：账号身份由后端会话决定，
    不要给登录接口增加 role 字段。登录成功后真实身份到来时，再同步 body[data-role]。
  真实业务逻辑（请求、错误、重试）沿用现有 apps/web/src/views/Login.vue，这里用 emit 代替。
-->
<script setup lang="ts">
import { computed, ref } from "vue";
import GlLiquid from "../src/components/glass/GlLiquid.vue";
import GlEvidenceCore from "../src/components/glass/GlEvidenceCore.vue";

const emit = defineEmits<{ submit: [email: string, password: string] }>();
defineProps<{ busy?: boolean; error?: string }>();

const ROLE_COPY = {
  teacher: { kicker: "For teachers", quote: ["证据先行，", "", "判断", "留给你。"], en: "Evidence first. Judgement is yours." },
  student: { kicker: "For students", quote: ["每一次修改，", "都", "看得见", "。"], en: "Every revision, made visible." },
} as const;
type Role = keyof typeof ROLE_COPY;

const role = ref<Role>("teacher");
const copy = computed(() => ROLE_COPY[role.value]);
const accent = computed(() => (role.value === "student" ? 1 : 0));
const email = ref("");
const password = ref("");
const showPwd = ref(false);

const coreEl = ref<HTMLElement | null>(null);
const quoteEl = ref<HTMLElement | null>(null);
const liquid = ref<InstanceType<typeof GlLiquid> | null>(null);
const core = ref<InstanceType<typeof GlEvidenceCore> | null>(null);

function setRole(r: Role) {
  if (r === role.value) return;
  role.value = r;
  document.body.dataset.role = r; // 仅视觉；登录后以会话中的真实身份为准
  core.value?.burst();
}
function onSubmit() {
  core.value?.boost(0.6);
  emit("submit", email.value, password.value);
}
</script>

<template>
  <main class="login-container" :data-role="role">
    <section class="scene" aria-hidden="true">
      <GlLiquid ref="liquid" :anchor="coreEl" :accent="accent" :fade="false" />
      <GlEvidenceCore ref="core" :anchor="coreEl" :avoid="quoteEl" :accent="accent" :precharge="0.6" @emit="liquid?.pulse()" />
      <div ref="coreEl" class="scene-core" />
      <div class="orbit">
        <span class="o-chip gl-glass" style="--a: 0deg"><i class="ok" />E-01 路由跳转</span>
        <span class="o-chip gl-glass" style="--a: 120deg"><i class="warn" />E-04 空列表状态</span>
        <span class="o-chip gl-glass" style="--a: 240deg"><i class="ok" />E-06 表单校验</span>
      </div>
      <div ref="quoteEl" class="quote">
        <p class="gl-eyebrow">{{ copy.kicker }}</p>
        <h2 :key="role" v-gl-split>{{ copy.quote[0] }}<br />{{ copy.quote[1] }}<em>{{ copy.quote[2] }}</em>{{ copy.quote[3] }}</h2>
        <p class="gl-serif">{{ copy.en }}</p>
      </div>
    </section>

    <section class="panel">
      <form class="login-form gl-glass gl-glass--strong" novalidate @submit.prevent="onSubmit">
        <p class="gl-eyebrow">Sign in</p>
        <h1 class="gl-h1">欢迎使用 CodeLab</h1>

        <div class="gl-segmented" :style="{ '--n': 2, '--i': role === 'teacher' ? 0 : 1 }" role="group" aria-label="身份外观">
          <span class="gl-segmented__pill" />
          <button type="button" :aria-pressed="role === 'teacher'" @click="setRole('teacher')">教师</button>
          <button type="button" :aria-pressed="role === 'student'" @click="setRole('student')">学生</button>
        </div>

        <label class="gl-float">
          <input v-model="email" class="gl-input" type="email" autocomplete="username" placeholder=" " aria-label="邮箱" />
          <span aria-hidden="true">邮箱</span>
        </label>
        <div class="pwd">
          <label class="gl-float">
            <input
              v-model="password"
              class="gl-input"
              :type="showPwd ? 'text' : 'password'"
              autocomplete="current-password"
              placeholder=" "
              aria-label="密码"
            />
            <span aria-hidden="true">密码</span>
          </label>
          <button type="button" class="gl-btn gl-btn--subtle gl-btn--icon peek" :aria-label="showPwd ? '隐藏密码' : '显示密码'" @click="showPwd = !showPwd">
            {{ showPwd ? "◡" : "◉" }}
          </button>
        </div>

        <p v-if="error" class="gl-error" role="alert">{{ error }}</p>

        <button class="gl-btn gl-btn--primary gl-btn--lg gl-btn--block" :class="{ 'is-loading': busy }" type="submit" :disabled="busy">
          <span>登录</span><span v-if="busy" class="gl-spinner" />
        </button>
      </form>
    </section>
  </main>
</template>

<style scoped>
.login-container {
  display: grid;
  grid-template-columns: 1.25fr 1fr;
  min-height: 100vh;
}
.scene {
  position: relative;
  overflow: hidden;
  -webkit-mask-image: linear-gradient(90deg, #000 78%, transparent);
  mask-image: linear-gradient(90deg, #000 78%, transparent);
}
.scene::after {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: linear-gradient(0deg, color-mix(in srgb, var(--gl-bg) 80%, transparent), transparent 45%);
}
.scene-core {
  position: absolute;
  left: 50%;
  top: 44%;
  width: clamp(130px, 13vw, 190px);
  aspect-ratio: 1;
  translate: -50% -50%;
}
@property --spin {
  syntax: "<angle>";
  inherits: true;
  initial-value: 0deg;
}
.orbit {
  --R: clamp(170px, 17vw, 250px);
  position: absolute;
  z-index: 2;
  left: 50%;
  top: 44%;
  animation: orbit 80s linear infinite;
}
@keyframes orbit {
  to {
    --spin: 360deg;
  }
}
.o-chip {
  position: absolute;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border-radius: 999px;
  font-size: 12.5px;
  white-space: nowrap;
  translate: -50% -50%;
  transform: rotate(calc(var(--a) + var(--spin))) translateX(var(--R)) rotate(calc(-1 * (var(--a) + var(--spin))));
}
.o-chip i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--gl-c2);
}
.o-chip i.warn {
  background: var(--gl-c4);
}
.quote {
  position: absolute;
  z-index: 2;
  left: 44px;
  bottom: 48px;
  width: min(560px, calc(100% - 88px));
}
.quote h2 {
  margin: 14px 0 6px;
  font-size: clamp(30px, 3.4vw, 50px);
  line-height: 1.15;
  font-weight: 900;
  letter-spacing: -0.03em;
}
.quote em {
  font-style: normal;
  color: rgb(var(--gl-role-rgb));
}
.quote .gl-serif {
  margin: 0;
  font-size: 19px;
  color: var(--gl-muted);
}
.panel {
  display: grid;
  place-items: center;
  padding: 32px;
}
.login-form {
  display: grid;
  gap: 14px;
  width: min(440px, 100%);
  padding: 40px 38px 32px;
  border-radius: 32px;
  animation: gl-scale-in 1.2s var(--gl-ease-out) both 0.35s;
}
.login-form .gl-h1 {
  margin-bottom: 12px;
}
.pwd {
  position: relative;
}
.pwd .peek {
  position: absolute;
  right: 6px;
  top: 7px;
}
@media (max-width: 900px) {
  .login-container {
    grid-template-columns: 1fr;
    grid-template-rows: 40vh auto;
  }
  .quote {
    display: none;
  }
  .panel {
    padding: 0 18px 40px;
    margin-top: -40px;
  }
}
</style>
