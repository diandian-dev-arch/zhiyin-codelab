<template>
  <nav class="top-navbar">
    <div class="navbar-container">
      <router-link to="/" class="logo">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <rect x="3" y="3" width="18" height="18" rx="4" stroke="currentColor" stroke-width="2" fill="none"/>
          <path d="M7 12l4 4 6-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <span class="logo-text">知因 CodeLab</span>
      </router-link>

      <div class="nav-links">
        <router-link to="/teacher/tasks" class="nav-link" active-class="active">我的课程</router-link>
        <router-link to="/teacher/students" class="nav-link" active-class="active">学生管理</router-link>
        <router-link to="/teacher/analytics" class="nav-link" active-class="active">数据分析</router-link>
      </div>

      <div class="nav-right">
        <button class="icon-button" @click="$router.push('/notifications')">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <path d="M15 6.66667A5 5 0 1 0 5 6.66667c0 5.83333-2.5 7.5-2.5 7.5h15s-2.5-1.66667-2.5-7.5M11.4417 17.5a1.66667 1.66667 0 0 1-2.88333 0" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <span class="notification-badge" v-if="notificationCount > 0">{{ notificationCount }}</span>
        </button>

        <div class="user-info">
          <div class="user-avatar">{{ userName.charAt(0) }}</div>
          <span class="user-name">{{ userName }}</span>
        </div>
      </div>
    </div>
  </nav>
</template>

<script setup lang="ts">
import { ref } from 'vue';

defineProps<{
  userName?: string;
  notificationCount?: number;
}>();

const userName = ref('张老师');
const notificationCount = ref(3);
</script>

<style scoped>
.top-navbar {
  position: sticky;
  top: 0;
  z-index: 100;
  background: rgba(253, 251, 247, 0.95);
  backdrop-filter: blur(12px);
  border-bottom: 1px solid rgba(0, 0, 0, 0.06);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
}

.navbar-container {
  max-width: 1400px;
  margin: 0 auto;
  padding: 0 40px;
  height: 72px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

/* Logo */
.logo {
  display: flex;
  align-items: center;
  gap: 12px;
  text-decoration: none;
  transition: all 0.3s;
}

.logo:hover {
  transform: translateY(-1px);
}

.logo svg {
  color: var(--accent-blue);
}

.logo-text {
  font-size: 20px;
  font-weight: 800;
  color: var(--text-primary);
  font-family: 'Noto Serif SC', serif;
}

/* Nav Links */
.nav-links {
  display: flex;
  gap: 32px;
}

.nav-link {
  color: var(--text-secondary);
  text-decoration: none;
  font-weight: 600;
  font-size: 15px;
  padding: 8px 0;
  position: relative;
  transition: all 0.3s;
}

.nav-link::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: 0;
  width: 0;
  height: 2px;
  background: var(--accent-gold);
  transition: width 0.3s;
}

.nav-link:hover,
.nav-link.active {
  color: var(--text-primary);
}

.nav-link.active::after {
  width: 100%;
}

/* Nav Right */
.nav-right {
  display: flex;
  align-items: center;
  gap: 24px;
}

.icon-button {
  position: relative;
  width: 40px;
  height: 40px;
  border-radius: 10px;
  border: none;
  background: var(--bg-card);
  color: var(--text-secondary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.3s;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
}

.icon-button:hover {
  background: white;
  color: var(--text-primary);
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
}

.notification-badge {
  position: absolute;
  top: -4px;
  right: -4px;
  background: var(--accent-red);
  color: white;
  font-size: 11px;
  font-weight: 700;
  padding: 2px 6px;
  border-radius: 10px;
  min-width: 18px;
  text-align: center;
}

.user-info {
  display: flex;
  align-items: center;
  gap: 12px;
}

.user-avatar {
  width: 36px;
  height: 36px;
  background: linear-gradient(135deg, var(--accent-blue), #5a92c4);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  font-weight: 700;
  font-size: 14px;
}

.user-name {
  font-weight: 600;
  color: var(--text-primary);
  font-size: 14px;
}

@media (max-width: 768px) {
  .navbar-container {
    padding: 0 20px;
    height: 64px;
  }

  .nav-links {
    display: none;
  }

  .user-name {
    display: none;
  }
}
</style>
