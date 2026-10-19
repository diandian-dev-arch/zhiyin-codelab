<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { useSession } from "./api";
import Login from './views/Login.vue';
import GlAmbient from './components/glass/GlAmbient.vue';
import { accountDisplayName } from './lib/account-display';
import {
  BookOpenCheck,
  LogOut,
  Files,
  ShieldCheck,
  Settings2,
} from "lucide-vue-next";
const s = useSession();
const route = useRoute();
watch(() => s.user?.role, role => { document.body.dataset.role = role ?? 'teacher'; }, { immediate: true });
const displayName = computed(() => accountDisplayName(s.user?.name));
const inTasks = computed(() => route.path === '/' || /^\/(tasks|runs|publications|legacy)(\/|$)/.test(route.path));
const locationLabel = computed(() =>
  /^\/(assignments|course-tasks|course-submissions)(\/|$)/.test(route.path) ? '课程作业与版本' : route.path.startsWith('/projects') ? 'AI 项目解读' : route.path === "/" || route.path === '/tasks'
    ? "实训任务"
    : route.path.includes("/tasks/")
      ? "任务与提交"
      : route.path === '/settings' ? '账号与模型' : inTasks.value ? "验收报告" : '页面不可用',
);
onMounted(() => s.load());
// Topbar gains a translucent, elevated surface once content scrolls underneath it.
const scrolled = ref(false);
const syncScrolled = () => { scrolled.value = window.scrollY > 8; };
onMounted(() => { syncScrolled(); window.addEventListener('scroll', syncScrolled, { passive: true }); });
onBeforeUnmount(() => window.removeEventListener('scroll', syncScrolled));
</script>
<template>
  <a href="#main-content" class="skip-link">跳转到主要内容</a>
  <GlAmbient :calm="!!s.user && !route.meta.public" />
  <RouterView v-if="route.meta.public" />
  <div v-else-if="!s.ready" class="loading" role="status">正在加载工作台…</div>
  <main v-else-if="s.loadError" id="main-content" class="loading" tabindex="-1">
    <section class="login-card" aria-labelledby="connection-title" :aria-busy="s.loading">
      <h1 id="connection-title">工作台暂时无法连接</h1>
      <p role="alert">{{ s.loadError }}</p>
      <p class="muted">恢复连接后会重新读取当前账号，无需重新上传项目。</p>
      <button class="primary" :disabled="s.loading" @click="s.load()">
        {{ s.loading ? '正在重试…' : '重试连接' }}
      </button>
    </section>
  </main>
  <Login v-else-if="!s.user" embedded />
  <div v-else class="workspace">
    <aside class="sidebar">
      <RouterLink to="/" class="brand"
        ><span class="brand-mark" aria-hidden="true"></span><span
          >知因 <b>CodeLab</b></span
        ></RouterLink
      >
      <div class="workspace-label">
        <span>项目实训空间</span
        ><strong>{{
          s.user.role === "teacher"
            ? "以证据，连接教与学。"
            : "让每次修改都有方向。"
        }}</strong>
      </div>
      <nav aria-label="工作台主导航">
      <p class="nav-caption">
        {{ s.user.role === "teacher" ? "教师工作台" : "我的实训" }}
      </p>
      <RouterLink
        to="/"
        class="nav-item"
        :aria-current="inTasks ? 'page' : undefined"
        ><Files aria-hidden="true" :size="18" />实训任务</RouterLink
      >
      <RouterLink
        to="/projects"
        class="nav-item"
        :aria-current="route.path.startsWith('/projects') ? 'page' : undefined"
        ><BookOpenCheck aria-hidden="true" :size="18" />AI 项目解读</RouterLink>
      <RouterLink v-if="s.businessVersion===2" to="/assignments" class="nav-item" :aria-current="/^\/(assignments|course-tasks|course-submissions)(\/|$)/.test(route.path) ? 'page' : undefined"><Files aria-hidden="true" :size="18" />课程作业</RouterLink>
      <RouterLink to="/settings" class="nav-item" :aria-current="route.path === '/settings' ? 'page' : undefined"><Settings2 aria-hidden="true" :size="18" />账号与模型</RouterLink>
      </nav>
      <div class="sidebar-note">
        <ShieldCheck aria-hidden="true" :size="20" />
        <p>先看证据，再作判断</p>
        <span>{{route.path.startsWith('/projects') ? '源码分析提供线索，具体问题仍需验证。' : '每份报告由教师复核后发布。'}}</span>
      </div>
      <div class="account">
        <div class="avatar">{{ displayName.slice(0, 1) }}</div>
        <div>
          <strong>{{ displayName }}</strong
          ><small>{{ s.user.role === "teacher" ? "教师" : "学生" }}</small>
        </div>
        <button class="icon-button" aria-label="退出登录" :disabled="s.loggingOut || s.authenticating" :aria-busy="s.loggingOut" @click="s.logout">
          <LogOut aria-hidden="true" :size="17" />
        </button>
      </div>
    </aside>
    <div class="workspace-main">
      <header class="topbar" :class="{ 'is-scrolled': scrolled }">
        <div class="topbar-path">
          <RouterLink to="/">知因 CodeLab</RouterLink
          ><span aria-hidden="true">/</span><strong>{{ locationLabel }}</strong>
        </div>
        <span class="topbar-context"
          >{{ s.user.role === "teacher" ? "教师工作台" : "学生工作台" }}
          <span class="tag">{{ displayName }}</span></span
        >
        <button
          class="mobile-logout icon-button"
          aria-label="退出登录"
          :disabled="s.loggingOut || s.authenticating"
          :aria-busy="s.loggingOut"
          @click="s.logout"
        >
          <LogOut aria-hidden="true" :size="17" />
        </button>
      </header>
      <nav class="mobile-workspace-nav" aria-label="工作台导航">
        <RouterLink to="/tasks" :aria-current="inTasks ? 'page' : undefined">实训任务</RouterLink>
        <RouterLink v-if="s.businessVersion===2" to="/assignments" :aria-current="/^\/(assignments|course-tasks|course-submissions)(\/|$)/.test(route.path) ? 'page' : undefined">课程作业</RouterLink>
        <RouterLink to="/projects" :aria-current="route.path.startsWith('/projects') ? 'page' : undefined">AI 项目解读</RouterLink>
        <RouterLink to="/settings" :aria-current="route.path === '/settings' ? 'page' : undefined">账号与模型</RouterLink>
      </nav>
      <main id="main-content" tabindex="-1" class="content">
        <div v-if="s.loggingOut" class="session-notice" role="status">正在退出登录…</div>
        <div v-else-if="s.logoutError" class="session-notice" role="alert">
          <p>{{ s.logoutError }}</p>
          <button type="button" @click="s.logout">重试退出</button>
        </div>
        <RouterView v-slot="{ Component }"><Transition name="gl-page" mode="out-in"><div class="gl-page-view" :key="$route.fullPath"><component :is="Component" /></div></Transition></RouterView>
      </main>
    </div>
  </div>
</template>
<style scoped>
.session-notice { display: flex; align-items: center; flex-wrap: wrap; gap: .75rem; padding: .75rem; margin-bottom: 1rem; border: 1px solid var(--warning); }
.session-notice p { flex: 1 1 16rem; margin: 0; }
.mobile-logout {
  display: none;
}
.mobile-workspace-nav { display:none; }
.nav-item:not([aria-current="page"]) { background: transparent; border-color: transparent; box-shadow: none; color: var(--muted); }
.nav-item { margin-bottom: 5px; }
@media (max-width: 760px) {
  .mobile-workspace-nav { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:4px; padding:8px; border-bottom:1px solid var(--line); background:var(--paper); }
  .mobile-workspace-nav a { display:flex; align-items:center; justify-content:center; min-height:44px; padding:8px 2px; border-radius:0; color:var(--muted); font-size:14px; line-height:1.5; text-align:center; text-wrap:balance; }
  .mobile-workspace-nav a[aria-current="page"] { background:transparent; color:var(--ink); font-weight:700; box-shadow: inset 0 -1.5px 0 var(--accent); }
  .mobile-logout {
    display: inline-flex;
  }
}
</style>
