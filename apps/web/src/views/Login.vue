<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { BookOpenCheck, Eye, EyeOff, ArrowRight } from 'lucide-vue-next';
import { useRouter } from 'vue-router';
import { useSession } from '../api';
import GlLiquid from '../components/glass/GlLiquid.vue';
import GlEvidenceCore from '../components/glass/GlEvidenceCore.vue';

const router = useRouter();
const props = defineProps<{ embedded?: boolean }>();
const session = useSession();

const showPassword = ref(false);
const email = ref('');
const password = ref('');
const error = ref('');
const loading = ref(false);
const visualRole = ref<'teacher' | 'student'>('teacher');
const accent = computed(() => visualRole.value === 'student' ? 1 : 0);
const coreEl = ref<HTMLElement | null>(null);
const quoteEl = ref<HTMLElement | null>(null);
const liquid = ref<InstanceType<typeof GlLiquid> | null>(null);
const core = ref<InstanceType<typeof GlEvidenceCore> | null>(null);
function setVisualRole(role: 'teacher' | 'student') {
  if (visualRole.value === role) return;
  visualRole.value = role;
  document.body.dataset.role = role;
  core.value?.burst();
}
onBeforeUnmount(() => { document.body.dataset.role = session.user?.role ?? 'teacher'; });

const handleLogin = async () => {
  if (loading.value) return;
  if (!email.value || !password.value) {
    error.value = '请填写邮箱和密码';
    return;
  }

  error.value = '';
  loading.value = true;

  try {
    // 真实登录接口签名：login(email: string, password: string)
    // 角色由服务器会话决定，不能由前端选择授予
    await session.login(email.value, password.value);

    // 登录成功后根据服务器返回的角色导航
    const user = session.user;
    if (!user) throw new Error('登录成功但未返回用户信息');
    if (props.embedded) return;

    // 安全恢复站内目标路径，或导航到默认入口
    const redirect = router.currentRoute.value.query.redirect as string | undefined;
    if (typeof redirect === 'string' && redirect.startsWith('/') && !redirect.startsWith('//') && !redirect.startsWith('/login')) {
      router.push(redirect);
    } else {
      // 导航到核心业务入口
      router.push('/projects');
    }
  } catch (err: any) {
    error.value = err instanceof TypeError
      ? '暂时无法连接服务，请检查网络后重新登录。'
      : (err.message || '登录失败，请检查邮箱和密码');
  } finally {
    password.value = '';
    loading.value = false;
  }
};
</script>
<template>
  <main id="main-content" class="login-page" tabindex="-1">
    <div class="login-container">
      <section class="login-intro" aria-label="知因 CodeLab">
        <GlLiquid ref="liquid" :anchor="coreEl" :accent="accent" :fade="false" />
        <GlEvidenceCore ref="core" appearance="glass" :anchor="coreEl" :avoid="quoteEl" :accent="accent" @emit="liquid?.pulse()" />
        <RouterLink to="/welcome" class="login-brand"><span class="brand-mark" aria-hidden="true"></span><span>知因 <b>CodeLab</b></span></RouterLink>
        <div ref="coreEl" class="scene-core" aria-hidden="true"></div>
        <div class="scene-orbit" aria-hidden="true">
          <span class="orbit-chip gl-glass orbit-a"><i></i>E-01 路由跳转</span>
          <span class="orbit-chip gl-glass orbit-b"><i class="warn"></i>E-04 空列表状态</span>
          <span class="orbit-chip gl-glass orbit-c"><i></i>E-06 表单校验</span>
        </div>
        <div ref="quoteEl" class="signin-story">
          <p class="gl-eyebrow">{{ visualRole === 'teacher' ? 'For teachers' : 'For students' }}</p>
          <h2 v-if="visualRole === 'teacher'" key="teacher" v-gl-split>证据先行，<br /><em>判断</em>留给你。</h2>
          <h2 v-else key="student" v-gl-split>每一次修改，<br />都<em>看得见</em>。</h2>
          <p class="gl-serif">{{ visualRole === 'teacher' ? 'Evidence first. Judgement is yours.' : 'Every revision, made visible.' }}</p>
        </div>
        <p class="intro-footer">项目实训空间 · 要求 → 证据 → 反馈</p>
      </section>
      <section class="login-card gl-glass gl-glass--strong" aria-labelledby="login-title">
        <p class="gl-eyebrow">Sign in</p>
        <h1 id="login-title">欢迎使用 CodeLab</h1>
        <p class="login-subtitle">登录，继续你的项目与实训。</p>
        <div class="gl-segmented roles" role="group" aria-label="身份外观" :style="{ '--n': 2, '--i': visualRole === 'teacher' ? 0 : 1 }">
          <span class="gl-segmented__pill" aria-hidden="true"></span>
          <button type="button" :aria-pressed="visualRole === 'teacher'" @click="setVisualRole('teacher')">教师</button>
          <button type="button" :aria-pressed="visualRole === 'student'" @click="setVisualRole('student')">学生</button>
        </div>
        <form class="login-form" :aria-busy="loading" @submit.prevent="handleLogin">
          <div class="gl-float">
          <input id="email" v-model="email" class="gl-input" type="email" autocomplete="username" placeholder=" " :disabled="loading" required />
          <label for="email">邮箱</label>
          </div>
          <div class="password-field">
            <div class="gl-float">
            <input id="password" v-model="password" class="gl-input" :type="showPassword ? 'text' : 'password'" autocomplete="current-password" placeholder=" " :disabled="loading" required />
            <label for="password">密码</label>
            </div>
            <button type="button" class="icon-button" :aria-label="showPassword ? '隐藏密码' : '显示密码'" :aria-pressed="showPassword" :disabled="loading" @click="showPassword = !showPassword">
              <EyeOff v-if="showPassword" :size="18" aria-hidden="true" /><Eye v-else :size="18" aria-hidden="true" />
            </button>
          </div>
          <div class="login-feedback"><p v-if="error" class="error-message" role="alert">{{ error }}</p></div>
          <button type="submit" class="primary btn-login" :disabled="loading">{{ loading ? '正在登录…' : '登录' }}<ArrowRight v-if="!loading" :size="17" aria-hidden="true" /></button>
          <p class="hint-text">学生账号由教师创建。登录后将按账号身份进入对应工作台。</p>
        </form>
        <div class="login-help"><strong>登录后可以做什么？</strong><p>学生提交项目、阅读反馈；教师管理任务、复核证据。也可以使用个人模型分析源码。</p></div>
        <RouterLink class="welcome-link" to="/welcome">了解 CodeLab →</RouterLink>
      </section>
    </div>
  </main>
</template>
<style scoped src="../styles/glass/login.css"></style>
