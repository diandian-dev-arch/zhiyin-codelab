<template>
  <div class="notifications-page">
    <header class="header">
      <button class="btn-back" @click="goBack">
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
          <path d="M12 4l-6 6 6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        返回
      </button>
      <h1>通知</h1>
      <button class="btn-clear" @click="clearAll" v-if="notifications.length > 0">
        清空
      </button>
      <div v-else></div>
    </header>

    <div class="notifications-container">
      <div v-if="notifications.length === 0" class="empty-state">
        <div class="empty-icon">
          <svg width="80" height="80" viewBox="0 0 80 80" fill="none">
            <circle cx="40" cy="40" r="35" stroke="currentColor" stroke-width="2" opacity="0.2"/>
            <path d="M50 28A15 15 0 1 0 30 28c0 17.5-7.5 22.5-7.5 22.5h35S50 45.5 50 28M44.33 62.5a5 5 0 0 1-8.66 0"
                  stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>
        <p class="empty-text">暂无通知</p>
      </div>

      <div v-else class="notifications-list">
        <div
          class="notification-item"
          v-for="notification in notifications"
          :key="notification.id"
          :class="{ unread: !notification.read }"
        >
          <div class="notification-icon" :class="notification.type">
            <svg v-if="notification.type === 'assignment'" width="32" height="32" viewBox="0 0 32 32" fill="none">
              <rect x="7" y="4" width="18" height="24" rx="1.5" stroke="currentColor" stroke-width="1.5" fill="none"/>
              <path d="M7 10h18M11 7h0M15 7h0" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
              <path d="M11 14h10M11 18h8M11 22h6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
            <svg v-else-if="notification.type === 'grade'" width="32" height="32" viewBox="0 0 32 32" fill="none">
              <path d="M16 4l-2.5 5-5.5 0.7 4 4-1 5.8 5-2.6 5 2.6-1-5.8 4-4-5.5-0.7L16 4z" stroke="currentColor" stroke-width="1.5" fill="none"/>
            </svg>
            <svg v-else-if="notification.type === 'comment'" width="32" height="32" viewBox="0 0 32 32" fill="none">
              <path d="M28 16c0 6.627-5.373 12-12 12-1.5 0-3-.3-4.5-.8L6 29l1.8-5.5C7.3 22 7 20.5 7 19c0-6.627 5.373-12 12-12s12 5.373 12 12z" stroke="currentColor" stroke-width="1.5" fill="none"/>
              <path d="M12 16h8M12 12h8M12 20h5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
            <svg v-else width="32" height="32" viewBox="0 0 32 32" fill="none">
              <circle cx="16" cy="16" r="12" stroke="currentColor" stroke-width="1.5" fill="none"/>
              <path d="M16 10v6M16 22h0" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            </svg>
          </div>

          <div class="notification-content">
            <div class="notification-title">{{ notification.title }}</div>
            <div class="notification-message">{{ notification.message }}</div>
            <div class="notification-time">{{ notification.time }}</div>
          </div>

          <button class="btn-delete" @click="deleteNotification(notification.id)">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <path d="M5 5l10 10M15 5l-10 10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            </svg>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';

const router = useRouter();

interface Notification {
  id: number;
  type: 'assignment' | 'grade' | 'comment' | 'system';
  title: string;
  message: string;
  time: string;
  read: boolean;
}

const notifications = ref<Notification[]>([
  {
    id: 1,
    type: 'assignment',
    title: '新作业发布',
    message: 'Web 开发基础课程发布了新作业"响应式布局实现"',
    time: '2小时前',
    read: false
  },
  {
    id: 2,
    type: 'grade',
    title: '作业已批改',
    message: '你的作业"Python 数据分析项目"已批改完成，得分 88 分',
    time: '5小时前',
    read: false
  },
  {
    id: 3,
    type: 'comment',
    title: '收到新评论',
    message: '张教授对你的作业进行了评论',
    time: '1天前',
    read: true
  },
  {
    id: 4,
    type: 'system',
    title: '系统通知',
    message: '系统将在本周六进行维护，预计维护时间2小时',
    time: '2天前',
    read: true
  }
]);

const goBack = () => {
  router.back();
};

const clearAll = () => {
  if (confirm('确定要清空所有通知吗？')) {
    notifications.value = [];
  }
};

const deleteNotification = (id: number) => {
  notifications.value = notifications.value.filter(n => n.id !== id);
};
</script>

<style scoped>
.notifications-page {
  min-height: 100vh;
  padding: 2rem;
  max-width: 900px;
  margin: 0 auto;
}

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 2rem;
}

.header h1 {
  font-size: 1.75rem;
  font-weight: 800;
  font-family: 'Noto Serif SC', serif;
}

.btn-back {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.75rem 1.25rem;
  background: var(--bg-card);
  border: none;
  border-radius: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.3s;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
}

.btn-back:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
}

.btn-clear {
  padding: 0.75rem 1.25rem;
  background: rgba(229, 57, 53, 0.1);
  color: var(--accent-red);
  border: none;
  border-radius: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.3s;
}

.btn-clear:hover {
  background: var(--accent-red);
  color: white;
  transform: translateY(-2px);
}

/* Empty State */
.empty-state {
  background: var(--bg-card);
  border-radius: 20px;
  padding: 4rem 2rem;
  text-align: center;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05), 0 10px 30px rgba(0, 0, 0, 0.08);
}

.empty-icon {
  color: var(--text-tertiary);
  margin-bottom: 1.5rem;
}

.empty-text {
  color: var(--text-secondary);
  font-size: 1.125rem;
  font-weight: 500;
}

/* Notifications List */
.notifications-list {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.notification-item {
  display: flex;
  gap: 1.25rem;
  background: var(--bg-card);
  padding: 1.5rem;
  border-radius: 16px;
  border: 2px solid transparent;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05), 0 6px 16px rgba(0, 0, 0, 0.06);
  transition: all 0.3s;
}

.notification-item:hover {
  transform: translateY(-2px);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08), 0 12px 24px rgba(0, 0, 0, 0.08);
}

.notification-item.unread {
  border-color: var(--accent-blue);
  background: linear-gradient(135deg, rgba(70, 130, 180, 0.03), rgba(90, 159, 212, 0.03));
}

.notification-icon {
  width: 56px;
  height: 56px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.notification-icon.assignment {
  background: rgba(70, 130, 180, 0.1);
  color: var(--accent-blue);
}

.notification-icon.grade {
  background: rgba(255, 193, 7, 0.1);
  color: var(--accent-gold);
}

.notification-icon.comment {
  background: rgba(76, 175, 80, 0.1);
  color: var(--accent-green);
}

.notification-icon.system {
  background: rgba(0, 0, 0, 0.05);
  color: var(--text-secondary);
}

.notification-content {
  flex: 1;
  min-width: 0;
}

.notification-title {
  font-size: 1.0625rem;
  font-weight: 700;
  margin-bottom: 0.375rem;
}

.notification-message {
  color: var(--text-secondary);
  font-size: 0.9375rem;
  line-height: 1.5;
  margin-bottom: 0.5rem;
}

.notification-time {
  color: var(--text-tertiary);
  font-size: 0.8125rem;
}

.btn-delete {
  width: 36px;
  height: 36px;
  border-radius: 8px;
  border: none;
  background: rgba(229, 57, 53, 0.1);
  color: var(--accent-red);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.3s;
  flex-shrink: 0;
  opacity: 0;
}

.notification-item:hover .btn-delete {
  opacity: 1;
}

.btn-delete:hover {
  background: var(--accent-red);
  color: white;
  transform: scale(1.1);
}

@media (max-width: 768px) {
  .notifications-page {
    padding: 1.5rem 1rem;
  }

  .header h1 {
    font-size: 1.5rem;
  }

  .notification-item {
    padding: 1.25rem;
    gap: 1rem;
  }

  .notification-icon {
    width: 48px;
    height: 48px;
  }

  .btn-delete {
    opacity: 1;
  }
}
</style>
