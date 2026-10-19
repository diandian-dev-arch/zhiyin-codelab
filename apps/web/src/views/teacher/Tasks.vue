<template>
  <div class="teacher-tasks">
    <!-- Header -->
    <header class="header">
      <div class="header-left">
        <h1>我的任务</h1>
        <p class="subtitle">管理和监控所有教学任务</p>
      </div>
      <div class="header-actions">
        <button class="btn-icon" @click="showNotifications">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
            <path d="M18 8A6 6 0 1 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0"
                  stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
        <button class="btn-icon" @click="showSettings">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="2"/>
            <path d="M12 1v6m0 6v6M23 12h-6m-6 0H1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
        </button>
        <div class="user-avatar">T</div>
      </div>
    </header>

    <!-- Statistics -->
    <div class="stats-grid">
      <div class="stat-card" v-for="stat in stats" :key="stat.label">
        <div class="fold-corner fold-corner-tr"></div>
        <div class="stat-icon" v-html="stat.icon"></div>
        <div class="stat-info">
          <div class="stat-value">{{ stat.value }}</div>
          <div class="stat-label">{{ stat.label }}</div>
        </div>
      </div>
    </div>

    <!-- Course Cards -->
    <div class="courses-section">
      <div class="section-header">
        <h2>课程列表</h2>
        <button class="btn-primary">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <path d="M10 4v12M4 10h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
          新建课程
        </button>
      </div>

      <div class="courses-grid">
        <div class="course-card" v-for="course in courses" :key="course.id">
          <div class="fold-corner fold-corner-tl"></div>

          <div class="course-header">
            <div class="course-icon" v-html="course.icon"></div>
            <div class="course-meta">
              <h3>{{ course.name }}</h3>
              <div class="meta-info">
                <span class="meta-item">
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                    <circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5"/>
                    <path d="M8 5v3l2 2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                  </svg>
                  {{ course.period }}
                </span>
                <span class="meta-item">
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                    <circle cx="8" cy="6" r="2.5" stroke="currentColor" stroke-width="1.5"/>
                    <path d="M3 13c0-2.5 2-4.5 5-4.5s5 2 5 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                  </svg>
                  {{ course.students }}人
                </span>
              </div>
            </div>
          </div>

          <div class="course-stats">
            <div class="progress-bar">
              <div class="progress-fill" :style="{ width: course.progress + '%' }"></div>
            </div>
            <div class="progress-label">
              <span>作业完成度</span>
              <span class="progress-value">{{ course.progress }}%</span>
            </div>
          </div>

          <div class="course-actions">
            <router-link :to="`/teacher/review/${course.id}`" class="btn-secondary">
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <path d="M2 9l4 4L16 3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
              审阅作业
            </router-link>
            <button class="btn-outline" @click="viewCourse(course.id)">
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <rect x="2" y="3" width="14" height="12" rx="1.5" stroke="currentColor" stroke-width="1.5"/>
                <path d="M2 7h14M6 3v4M12 3v4" stroke="currentColor" stroke-width="1.5"/>
              </svg>
              课程详情
            </button>
          </div>

          <div class="fold-corner fold-corner-br"></div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';

const router = useRouter();

const stats = [
  {
    label: '活跃课程',
    value: '5',
    icon: `<svg width="32" height="32" viewBox="0 0 32 32" fill="none">
      <rect x="5" y="9" width="22" height="3" rx="1.5" fill="currentColor"/>
      <path d="M16 3L6 8l10 5 10-5L16 3z" fill="currentColor" opacity="0.3"/>
      <path d="M16 3L6 8l10 5 10-5L16 3z" stroke="currentColor" stroke-width="1.5" fill="none"/>
      <path d="M7 11v6c0 3 4 6 9 6s9-3 9-6v-6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    </svg>`
  },
  {
    label: '待审阅',
    value: '23',
    icon: `<svg width="32" height="32" viewBox="0 0 32 32" fill="none">
      <rect x="6" y="4" width="20" height="24" rx="2" stroke="currentColor" stroke-width="1.5" fill="none"/>
      <path d="M6 10h20M11 7h0M15 7h0" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      <path d="M11 16h10M11 20h8M11 24h6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    </svg>`
  },
  {
    label: '已完成',
    value: '156',
    icon: `<svg width="32" height="32" viewBox="0 0 32 32" fill="none">
      <circle cx="16" cy="16" r="12" stroke="currentColor" stroke-width="1.5" fill="none"/>
      <path d="M10 16l4 4 8-8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`
  },
  {
    label: '学生总数',
    value: '128',
    icon: `<svg width="32" height="32" viewBox="0 0 32 32" fill="none">
      <circle cx="16" cy="11" r="4" stroke="currentColor" stroke-width="1.5" fill="none"/>
      <circle cx="9" cy="13" r="3" stroke="currentColor" stroke-width="1.5" fill="none"/>
      <circle cx="23" cy="13" r="3" stroke="currentColor" stroke-width="1.5" fill="none"/>
      <path d="M16 16c-4 0-7 2.5-7 5.5v3h14v-3c0-3-3-5.5-7-5.5z" stroke="currentColor" stroke-width="1.5" fill="none"/>
      <path d="M5 22c0-1.5 1.5-3 4-3M27 22c0-1.5-1.5-3-4-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    </svg>`
  }
];

const courses = ref([
  {
    id: 1,
    name: 'Web 开发基础',
    period: '2024春季',
    students: 45,
    progress: 78,
    icon: `<svg width="40" height="40" viewBox="0 0 40 40" fill="none">
      <rect x="6" y="8" width="28" height="24" rx="2" stroke="currentColor" stroke-width="2" fill="none"/>
      <path d="M14 18l3 3-3 3M22 24h6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`
  },
  {
    id: 2,
    name: 'Python 编程',
    period: '2024春季',
    students: 38,
    progress: 65,
    icon: `<svg width="40" height="40" viewBox="0 0 40 40" fill="none">
      <rect x="6" y="8" width="28" height="24" rx="2" stroke="currentColor" stroke-width="2" fill="none"/>
      <path d="M14 18l3 3-3 3M22 24h6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`
  },
  {
    id: 3,
    name: '数据结构',
    period: '2024春季',
    students: 52,
    progress: 82,
    icon: `<svg width="40" height="40" viewBox="0 0 40 40" fill="none">
      <rect x="6" y="8" width="28" height="24" rx="2" stroke="currentColor" stroke-width="2" fill="none"/>
      <path d="M14 18l3 3-3 3M22 24h6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`
  }
]);

const showNotifications = () => {
  router.push('/notifications');
};

const showSettings = () => {
  router.push('/settings');
};

const viewCourse = (courseId: number) => {
  console.log('View course:', courseId);
};
</script>

<style scoped>
.teacher-tasks {
  min-height: 100vh;
  padding: 2rem;
  max-width: 1400px;
  margin: 0 auto;
}

/* Header */
.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 2.5rem;
}

.header-left h1 {
  font-size: 2rem;
  font-weight: 800;
  margin-bottom: 0.25rem;
  font-family: 'Noto Serif SC', serif;
}

.subtitle {
  color: var(--text-secondary);
  font-size: 0.95rem;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.btn-icon {
  width: 44px;
  height: 44px;
  border-radius: 12px;
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

.btn-icon:hover {
  background: white;
  color: var(--text-primary);
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
}

.user-avatar {
  width: 44px;
  height: 44px;
  border-radius: 12px;
  background: linear-gradient(135deg, var(--accent-blue), #5a9fd4);
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 1.125rem;
  box-shadow: 0 2px 8px rgba(70, 130, 180, 0.3);
}

/* Statistics */
.stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 1.5rem;
  margin-bottom: 3rem;
}

.stat-card {
  position: relative;
  background: var(--bg-card);
  border-radius: 16px;
  padding: 1.75rem;
  display: flex;
  align-items: center;
  gap: 1.25rem;
  box-shadow:
    0 1px 3px rgba(0, 0, 0, 0.05),
    0 8px 24px rgba(0, 0, 0, 0.06);
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.stat-card:hover {
  transform: translateY(-4px);
  box-shadow:
    0 2px 8px rgba(0, 0, 0, 0.08),
    0 16px 40px rgba(0, 0, 0, 0.1);
}

.stat-icon {
  width: 56px;
  height: 56px;
  background: linear-gradient(135deg, rgba(70, 130, 180, 0.1), rgba(218, 165, 32, 0.1));
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--accent-blue);
  flex-shrink: 0;
}

.stat-info {
  flex: 1;
}

.stat-value {
  font-size: 2rem;
  font-weight: 800;
  line-height: 1;
  margin-bottom: 0.375rem;
}

.stat-label {
  color: var(--text-secondary);
  font-size: 0.9rem;
  font-weight: 500;
}

/* Courses Section */
.courses-section {
  margin-bottom: 3rem;
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1.5rem;
}

.section-header h2 {
  font-size: 1.5rem;
  font-weight: 800;
  font-family: 'Noto Serif SC', serif;
}

.btn-primary {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  background: linear-gradient(135deg, var(--accent-blue), #5a9fd4);
  color: white;
  border: none;
  padding: 0.75rem 1.5rem;
  border-radius: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.3s;
  box-shadow: 0 2px 8px rgba(70, 130, 180, 0.2);
}

.btn-primary:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 16px rgba(70, 130, 180, 0.3);
}

/* Courses Grid */
.courses-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(380px, 1fr));
  gap: 1.5rem;
}

.course-card {
  position: relative;
  background: var(--bg-card);
  border-radius: 20px;
  padding: 2rem;
  box-shadow:
    0 1px 3px rgba(0, 0, 0, 0.05),
    0 10px 30px rgba(0, 0, 0, 0.06);
  transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
}

.course-card:hover {
  transform: translateY(-6px);
  box-shadow:
    0 2px 8px rgba(0, 0, 0, 0.08),
    0 20px 50px rgba(0, 0, 0, 0.12);
}

.course-header {
  display: flex;
  gap: 1.25rem;
  margin-bottom: 1.5rem;
}

.course-icon {
  width: 64px;
  height: 64px;
  background: linear-gradient(135deg, rgba(70, 130, 180, 0.1), rgba(90, 159, 212, 0.1));
  border-radius: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--accent-blue);
  flex-shrink: 0;
}

.course-meta h3 {
  font-size: 1.25rem;
  font-weight: 700;
  margin-bottom: 0.625rem;
}

.meta-info {
  display: flex;
  gap: 1rem;
}

.meta-item {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  color: var(--text-secondary);
  font-size: 0.875rem;
}

.meta-item svg {
  color: var(--text-tertiary);
}

/* Progress */
.course-stats {
  margin-bottom: 1.5rem;
}

.progress-bar {
  width: 100%;
  height: 8px;
  background: rgba(0, 0, 0, 0.05);
  border-radius: 999px;
  overflow: hidden;
  margin-bottom: 0.5rem;
}

.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--accent-blue), var(--accent-green));
  border-radius: 999px;
  transition: width 0.6s cubic-bezier(0.4, 0, 0.2, 1);
}

.progress-label {
  display: flex;
  justify-content: space-between;
  font-size: 0.85rem;
  color: var(--text-secondary);
}

.progress-value {
  font-weight: 600;
  color: var(--text-primary);
}

/* Actions */
.course-actions {
  display: flex;
  gap: 0.75rem;
}

.btn-secondary,
.btn-outline {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  padding: 0.75rem 1rem;
  border-radius: 10px;
  font-weight: 600;
  font-size: 0.9rem;
  cursor: pointer;
  transition: all 0.3s;
  text-decoration: none;
  border: none;
}

.btn-secondary {
  background: linear-gradient(135deg, var(--accent-green), #66bb6a);
  color: white;
  box-shadow: 0 2px 8px rgba(76, 175, 80, 0.2);
}

.btn-secondary:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(76, 175, 80, 0.3);
}

.btn-outline {
  background: white;
  color: var(--text-primary);
  border: 2px solid rgba(0, 0, 0, 0.1);
}

.btn-outline:hover {
  border-color: var(--accent-blue);
  color: var(--accent-blue);
  transform: translateY(-2px);
}

/* Fold Corners */
.fold-corner {
  position: absolute;
  width: 32px;
  height: 32px;
  overflow: hidden;
}

.fold-corner::before {
  content: '';
  position: absolute;
  width: 100%;
  height: 100%;
  transition: all 0.3s;
}

.fold-corner-tl {
  top: 0;
  left: 0;
}

.fold-corner-tl::before {
  background: linear-gradient(135deg, transparent 50%, rgba(184, 217, 240, 0.5) 50%);
}

.fold-corner-tr {
  top: 0;
  right: 0;
}

.fold-corner-tr::before {
  background: linear-gradient(225deg, transparent 50%, rgba(200, 230, 201, 0.5) 50%);
}

.fold-corner-br {
  bottom: 0;
  right: 0;
}

.fold-corner-br::before {
  background: linear-gradient(315deg, transparent 50%, rgba(255, 224, 178, 0.5) 50%);
}

.stat-card:hover .fold-corner::before,
.course-card:hover .fold-corner::before {
  transform: scale(1.2);
}

/* Responsive */
@media (max-width: 768px) {
  .teacher-tasks {
    padding: 1.5rem 1rem;
  }

  .header {
    flex-direction: column;
    align-items: flex-start;
    gap: 1rem;
  }

  .header-actions {
    width: 100%;
    justify-content: flex-end;
  }

  .stats-grid {
    grid-template-columns: 1fr;
  }

  .courses-grid {
    grid-template-columns: 1fr;
  }

  .section-header {
    flex-direction: column;
    align-items: flex-start;
    gap: 1rem;
  }

  .btn-primary {
    width: 100%;
    justify-content: center;
  }
}
</style>
