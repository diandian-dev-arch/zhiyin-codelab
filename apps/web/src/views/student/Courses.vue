<template>
  <div class="student-courses">
    <!-- Header -->
    <header class="header">
      <div class="header-left">
        <h1>我的课程</h1>
        <p class="subtitle">查看课程和提交作业</p>
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
        <div class="user-avatar">S</div>
      </div>
    </header>

    <!-- Quick Stats -->
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-icon">
          <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
            <rect x="5" y="8" width="22" height="18" rx="2" stroke="currentColor" stroke-width="1.5" fill="none"/>
            <path d="M5 13h22M10 8v5M22 8v5" stroke="currentColor" stroke-width="1.5"/>
          </svg>
        </div>
        <div class="stat-info">
          <div class="stat-value">{{ stats.activeCourses }}</div>
          <div class="stat-label">进行中课程</div>
        </div>
      </div>

      <div class="stat-card">
        <div class="stat-icon">
          <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
            <circle cx="16" cy="16" r="12" stroke="currentColor" stroke-width="1.5" fill="none"/>
            <path d="M16 8v8l4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
        </div>
        <div class="stat-info">
          <div class="stat-value">{{ stats.pendingTasks }}</div>
          <div class="stat-label">待完成作业</div>
        </div>
      </div>

      <div class="stat-card">
        <div class="stat-icon">
          <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
            <circle cx="16" cy="16" r="12" stroke="currentColor" stroke-width="1.5" fill="none"/>
            <path d="M10 16l4 4 8-8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>
        <div class="stat-info">
          <div class="stat-value">{{ stats.completedTasks }}</div>
          <div class="stat-label">已完成作业</div>
        </div>
      </div>

      <div class="stat-card">
        <div class="stat-icon">
          <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
            <path d="M16 4l-3 6H7l5 5-2 7 6-4 6 4-2-7 5-5h-6l-3-6z" stroke="currentColor" stroke-width="1.5" fill="none"/>
          </svg>
        </div>
        <div class="stat-info">
          <div class="stat-value">{{ stats.averageScore }}</div>
          <div class="stat-label">平均分数</div>
        </div>
      </div>
    </div>

    <!-- Courses List -->
    <div class="courses-section">
      <div class="section-header">
        <h2>课程列表</h2>
        <div class="filters">
          <button
            class="filter-btn"
            :class="{ active: filter === 'all' }"
            @click="filter = 'all'"
          >
            全部
          </button>
          <button
            class="filter-btn"
            :class="{ active: filter === 'active' }"
            @click="filter = 'active'"
          >
            进行中
          </button>
          <button
            class="filter-btn"
            :class="{ active: filter === 'completed' }"
            @click="filter = 'completed'"
          >
            已完成
          </button>
        </div>
      </div>

      <div class="courses-grid">
        <div class="course-card" v-for="course in filteredCourses" :key="course.id">
          <div class="fold-corner fold-corner-tl"></div>

          <div class="course-header">
            <div class="course-icon">
              <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
                <rect x="6" y="8" width="28" height="24" rx="2" stroke="currentColor" stroke-width="2" fill="none"/>
                <path d="M14 18l3 3-3 3M22 24h6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </div>
            <div class="course-info">
              <h3>{{ course.name }}</h3>
              <div class="teacher-info">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <rect x="3" y="7" width="10" height="1.5" rx="0.75" fill="currentColor"/>
                  <path d="M8 2L2 5.5 8 9l6-3.5L8 2z" fill="currentColor" opacity="0.3"/>
                  <path d="M8 2L2 5.5 8 9l6-3.5L8 2z" stroke="currentColor" stroke-width="1" fill="none"/>
                  <path d="M3.5 7v3c0 1.5 2 3 4.5 3s4.5-1.5 4.5-3V7" stroke="currentColor" stroke-width="1" stroke-linecap="round"/>
                </svg>
                {{ course.teacher }}
              </div>
            </div>
            <div class="course-status" :class="course.status">
              {{ course.status === 'active' ? '进行中' : '已完成' }}
            </div>
          </div>

          <div class="course-stats">
            <div class="stat-item">
              <span class="stat-label">完成进度</span>
              <span class="stat-value">{{ course.completedTasks }}/{{ course.totalTasks }}</span>
            </div>
            <div class="progress-bar">
              <div class="progress-fill" :style="{ width: (course.completedTasks / course.totalTasks * 100) + '%' }"></div>
            </div>
          </div>

          <div class="upcoming-task" v-if="course.upcomingTask">
            <div class="task-badge">即将截止</div>
            <div class="task-info">
              <div class="task-name">{{ course.upcomingTask.name }}</div>
              <div class="task-deadline">
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <circle cx="7" cy="7" r="5.5" stroke="currentColor" stroke-width="1"/>
                  <path d="M7 4v3l2 2" stroke="currentColor" stroke-width="1" stroke-linecap="round"/>
                </svg>
                {{ course.upcomingTask.deadline }}
              </div>
            </div>
          </div>

          <div class="course-actions">
            <router-link :to="`/student/submit/${course.id}`" class="btn-primary-small">
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <path d="M9 3v12M3 9h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
              </svg>
              提交作业
            </router-link>
            <router-link :to="`/student/report/${course.id}`" class="btn-outline-small">
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <path d="M3 6l6-3 6 3M3 6v6l6 3M3 6l6 3m0-3l6 3M9 9v9m0-9l6-3v6l-6 3" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
              </svg>
              查看报告
            </router-link>
          </div>

          <div class="fold-corner fold-corner-br"></div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { useRouter } from 'vue-router';

const router = useRouter();
const filter = ref<'all' | 'active' | 'completed'>('all');

const stats = {
  activeCourses: 4,
  pendingTasks: 7,
  completedTasks: 23,
  averageScore: 85
};

const courses = ref([
  {
    id: 1,
    name: 'Web 开发基础',
    teacher: '张教授',
    status: 'active',
    completedTasks: 8,
    totalTasks: 12,
    upcomingTask: {
      name: '响应式布局实现',
      deadline: '2天后'
    }
  },
  {
    id: 2,
    name: 'Python 编程',
    teacher: '李老师',
    status: 'active',
    completedTasks: 6,
    totalTasks: 10,
    upcomingTask: {
      name: '数据分析项目',
      deadline: '5天后'
    }
  },
  {
    id: 3,
    name: '数据结构',
    teacher: '王教授',
    status: 'active',
    completedTasks: 9,
    totalTasks: 15,
    upcomingTask: {
      name: '二叉树实现',
      deadline: '明天'
    }
  },
  {
    id: 4,
    name: '算法设计',
    teacher: '陈老师',
    status: 'completed',
    completedTasks: 12,
    totalTasks: 12,
    upcomingTask: null
  }
]);

const filteredCourses = computed(() => {
  if (filter.value === 'all') return courses.value;
  return courses.value.filter(c => c.status === filter.value);
});

const showNotifications = () => {
  router.push('/notifications');
};

const showSettings = () => {
  router.push('/settings');
};
</script>

<style scoped>
.student-courses {
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
  background: linear-gradient(135deg, var(--accent-green), #66bb6a);
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 1.125rem;
  box-shadow: 0 2px 8px rgba(76, 175, 80, 0.3);
}

/* Stats */
.stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 1.25rem;
  margin-bottom: 3rem;
}

.stat-card {
  background: var(--bg-card);
  border-radius: 14px;
  padding: 1.5rem;
  display: flex;
  align-items: center;
  gap: 1rem;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05), 0 6px 16px rgba(0, 0, 0, 0.05);
  transition: all 0.3s;
}

.stat-card:hover {
  transform: translateY(-3px);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08), 0 12px 24px rgba(0, 0, 0, 0.08);
}

.stat-icon {
  width: 48px;
  height: 48px;
  background: linear-gradient(135deg, rgba(76, 175, 80, 0.1), rgba(102, 187, 106, 0.1));
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--accent-green);
  flex-shrink: 0;
}

.stat-info {
  flex: 1;
}

.stat-value {
  font-size: 1.75rem;
  font-weight: 800;
  line-height: 1;
  margin-bottom: 0.25rem;
}

.stat-label {
  color: var(--text-secondary);
  font-size: 0.85rem;
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
  flex-wrap: wrap;
  gap: 1rem;
}

.section-header h2 {
  font-size: 1.5rem;
  font-weight: 800;
  font-family: 'Noto Serif SC', serif;
}

.filters {
  display: flex;
  gap: 0.5rem;
  background: var(--bg-card);
  padding: 0.375rem;
  border-radius: 10px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
}

.filter-btn {
  padding: 0.5rem 1.25rem;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-weight: 600;
  font-size: 0.9rem;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.3s;
}

.filter-btn:hover {
  color: var(--text-primary);
}

.filter-btn.active {
  background: linear-gradient(135deg, var(--accent-green), #66bb6a);
  color: white;
  box-shadow: 0 2px 8px rgba(76, 175, 80, 0.2);
}

/* Courses Grid */
.courses-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
  gap: 1.5rem;
}

.course-card {
  position: relative;
  background: var(--bg-card);
  border-radius: 18px;
  padding: 1.75rem;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05), 0 8px 20px rgba(0, 0, 0, 0.06);
  transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
}

.course-card:hover {
  transform: translateY(-6px);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08), 0 16px 40px rgba(0, 0, 0, 0.1);
}

.course-header {
  display: flex;
  align-items: flex-start;
  gap: 1rem;
  margin-bottom: 1.25rem;
}

.course-icon {
  width: 56px;
  height: 56px;
  background: linear-gradient(135deg, rgba(76, 175, 80, 0.1), rgba(102, 187, 106, 0.1));
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--accent-green);
  flex-shrink: 0;
}

.course-info {
  flex: 1;
  min-width: 0;
}

.course-info h3 {
  font-size: 1.125rem;
  font-weight: 700;
  margin-bottom: 0.5rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.teacher-info {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  color: var(--text-secondary);
  font-size: 0.875rem;
}

.course-status {
  padding: 0.375rem 0.875rem;
  border-radius: 8px;
  font-size: 0.8rem;
  font-weight: 600;
  flex-shrink: 0;
}

.course-status.active {
  background: rgba(76, 175, 80, 0.1);
  color: var(--accent-green);
}

.course-status.completed {
  background: rgba(0, 0, 0, 0.05);
  color: var(--text-secondary);
}

/* Course Stats */
.course-stats {
  margin-bottom: 1.25rem;
}

.stat-item {
  display: flex;
  justify-content: space-between;
  margin-bottom: 0.5rem;
  font-size: 0.875rem;
}

.stat-item .stat-label {
  color: var(--text-secondary);
}

.stat-item .stat-value {
  font-weight: 700;
  color: var(--text-primary);
}

.progress-bar {
  width: 100%;
  height: 6px;
  background: rgba(0, 0, 0, 0.05);
  border-radius: 999px;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--accent-green), #66bb6a);
  border-radius: 999px;
  transition: width 0.6s cubic-bezier(0.4, 0, 0.2, 1);
}

/* Upcoming Task */
.upcoming-task {
  background: rgba(255, 152, 0, 0.08);
  border-left: 3px solid var(--accent-orange);
  border-radius: 8px;
  padding: 0.875rem 1rem;
  margin-bottom: 1.25rem;
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.task-badge {
  background: var(--accent-orange);
  color: white;
  padding: 0.25rem 0.625rem;
  border-radius: 6px;
  font-size: 0.75rem;
  font-weight: 700;
  flex-shrink: 0;
}

.task-info {
  flex: 1;
  min-width: 0;
}

.task-name {
  font-weight: 600;
  font-size: 0.9rem;
  margin-bottom: 0.25rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.task-deadline {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  color: var(--text-secondary);
  font-size: 0.8rem;
}

/* Actions */
.course-actions {
  display: flex;
  gap: 0.75rem;
}

.btn-primary-small,
.btn-outline-small {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  padding: 0.625rem 1rem;
  border-radius: 10px;
  font-weight: 600;
  font-size: 0.875rem;
  cursor: pointer;
  transition: all 0.3s;
  text-decoration: none;
  border: none;
}

.btn-primary-small {
  background: linear-gradient(135deg, var(--accent-green), #66bb6a);
  color: white;
  box-shadow: 0 2px 8px rgba(76, 175, 80, 0.2);
}

.btn-primary-small:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(76, 175, 80, 0.3);
}

.btn-outline-small {
  background: white;
  color: var(--text-primary);
  border: 2px solid rgba(0, 0, 0, 0.1);
}

.btn-outline-small:hover {
  border-color: var(--accent-green);
  color: var(--accent-green);
  transform: translateY(-2px);
}

/* Fold Corners */
.fold-corner {
  position: absolute;
  width: 28px;
  height: 28px;
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
  background: linear-gradient(135deg, transparent 50%, rgba(200, 230, 201, 0.5) 50%);
}

.fold-corner-br {
  bottom: 0;
  right: 0;
}

.fold-corner-br::before {
  background: linear-gradient(315deg, transparent 50%, rgba(255, 224, 178, 0.5) 50%);
}

.course-card:hover .fold-corner::before {
  transform: scale(1.2);
}

/* Responsive */
@media (max-width: 768px) {
  .student-courses {
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
    grid-template-columns: repeat(2, 1fr);
  }

  .courses-grid {
    grid-template-columns: 1fr;
  }

  .section-header {
    flex-direction: column;
    align-items: flex-start;
  }

  .filters {
    width: 100%;
  }

  .filter-btn {
    flex: 1;
  }
}
</style>
