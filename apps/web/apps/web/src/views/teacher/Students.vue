<template>
  <div class="teacher-students">
    <!-- Header -->
    <header class="header">
      <button class="btn-back" @click="goBack">
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
          <path d="M12 4l-6 6 6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        返回
      </button>
      <div class="header-center">
        <h1>学生管理</h1>
        <p class="subtitle">Web 开发基础 · 2024春季</p>
      </div>
      <div class="header-actions">
        <button class="btn-add">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <path d="M10 4v12M4 10h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
          添加学生
        </button>
      </div>
    </header>

    <!-- Stats Overview -->
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-icon">
          <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
            <circle cx="16" cy="11" r="5" stroke="currentColor" stroke-width="1.5" fill="none"/>
            <path d="M6 26c0-5.5 4.5-10 10-10s10 4.5 10 10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
        </div>
        <div class="stat-value">{{ stats.totalStudents }}</div>
        <div class="stat-label">学生总数</div>
      </div>

      <div class="stat-card">
        <div class="stat-icon active">
          <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
            <circle cx="16" cy="16" r="12" stroke="currentColor" stroke-width="1.5" fill="none"/>
            <path d="M10 16l4 4 8-8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>
        <div class="stat-value">{{ stats.activeStudents }}</div>
        <div class="stat-label">活跃学生</div>
      </div>

      <div class="stat-card">
        <div class="stat-icon">
          <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
            <path d="M16 4l-3 6H7l5 5-2 7 6-4 6 4-2-7 5-5h-6l-3-6z" stroke="currentColor" stroke-width="1.5" fill="none"/>
          </svg>
        </div>
        <div class="stat-value">{{ stats.averageScore }}</div>
        <div class="stat-label">平均分</div>
      </div>

      <div class="stat-card">
        <div class="stat-icon">
          <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
            <rect x="6" y="10" width="20" height="16" rx="2" stroke="currentColor" stroke-width="1.5" fill="none"/>
            <path d="M6 14h20M11 6v8M21 6v8" stroke="currentColor" stroke-width="1.5"/>
          </svg>
        </div>
        <div class="stat-value">{{ stats.completionRate }}%</div>
        <div class="stat-label">完成率</div>
      </div>
    </div>

    <!-- Filters and Search -->
    <div class="controls-bar">
      <div class="search-box">
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
          <circle cx="9" cy="9" r="6" stroke="currentColor" stroke-width="2"/>
          <path d="M13 13l4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        </svg>
        <input
          type="text"
          v-model="searchQuery"
          placeholder="搜索学生姓名或学号..."
        />
      </div>

      <div class="filters">
        <select v-model="sortBy" class="filter-select">
          <option value="name">按姓名排序</option>
          <option value="score">按成绩排序</option>
          <option value="submissions">按提交数排序</option>
          <option value="activity">按活跃度排序</option>
        </select>

        <select v-model="filterStatus" class="filter-select">
          <option value="all">全部学生</option>
          <option value="active">活跃</option>
          <option value="inactive">不活跃</option>
          <option value="at-risk">需要关注</option>
        </select>
      </div>
    </div>

    <!-- Students Table -->
    <div class="students-table-card">
      <div class="fold-corner fold-corner-tl"></div>

      <div class="table-container">
        <table class="students-table">
          <thead>
            <tr>
              <th>学生</th>
              <th>学号</th>
              <th>已提交</th>
              <th>平均分</th>
              <th>最后活跃</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="student in filteredStudents" :key="student.id" class="student-row">
              <td>
                <div class="student-cell">
                  <div class="student-avatar">{{ student.name.charAt(0) }}</div>
                  <div class="student-name">{{ student.name }}</div>
                </div>
              </td>
              <td>{{ student.studentId }}</td>
              <td>
                <div class="progress-cell">
                  <span class="progress-text">{{ student.submitted }}/{{ student.total }}</span>
                  <div class="mini-progress">
                    <div
                      class="mini-progress-fill"
                      :style="{ width: (student.submitted / student.total * 100) + '%' }"
                    ></div>
                  </div>
                </div>
              </td>
              <td>
                <span class="score-badge" :class="getScoreClass(student.averageScore)">
                  {{ student.averageScore }}
                </span>
              </td>
              <td>
                <span class="activity-time">{{ student.lastActive }}</span>
              </td>
              <td>
                <span class="status-badge" :class="student.status">
                  {{ getStatusText(student.status) }}
                </span>
              </td>
              <td>
                <div class="action-buttons">
                  <button class="btn-action" @click="viewStudent(student.id)" title="查看详情">
                    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                      <circle cx="9" cy="9" r="3" stroke="currentColor" stroke-width="1.5"/>
                      <path d="M1 9s3-6 8-6 8 6 8 6-3 6-8 6-8-6-8-6z" stroke="currentColor" stroke-width="1.5"/>
                    </svg>
                  </button>
                  <button class="btn-action" @click="sendMessage(student.id)" title="发送消息">
                    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                      <path d="M16 2L8 10M16 2l-6 14-2-6-6-2 14-6z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                  </button>
                  <button class="btn-action danger" @click="removeStudent(student.id)" title="移除">
                    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                      <path d="M4 4l10 10M14 4l-10 10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                    </svg>
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="fold-corner fold-corner-br"></div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { useRouter } from 'vue-router';

const router = useRouter();

const searchQuery = ref('');
const sortBy = ref('name');
const filterStatus = ref('all');

const stats = {
  totalStudents: 45,
  activeStudents: 38,
  averageScore: 82.5,
  completionRate: 76
};

interface Student {
  id: number;
  name: string;
  studentId: string;
  submitted: number;
  total: number;
  averageScore: number;
  lastActive: string;
  status: 'active' | 'inactive' | 'at-risk';
}

const students = ref<Student[]>([
  {
    id: 1,
    name: '张三',
    studentId: '2024001',
    submitted: 11,
    total: 12,
    averageScore: 88,
    lastActive: '2小时前',
    status: 'active'
  },
  {
    id: 2,
    name: '李四',
    studentId: '2024002',
    submitted: 10,
    total: 12,
    averageScore: 85,
    lastActive: '1天前',
    status: 'active'
  },
  {
    id: 3,
    name: '王五',
    studentId: '2024003',
    submitted: 12,
    total: 12,
    averageScore: 92,
    lastActive: '5小时前',
    status: 'active'
  },
  {
    id: 4,
    name: '赵六',
    studentId: '2024004',
    submitted: 7,
    total: 12,
    averageScore: 68,
    lastActive: '5天前',
    status: 'at-risk'
  },
  {
    id: 5,
    name: '孙七',
    studentId: '2024005',
    submitted: 8,
    total: 12,
    averageScore: 76,
    lastActive: '3天前',
    status: 'inactive'
  }
]);

const filteredStudents = computed(() => {
  let result = students.value;

  // Filter by search query
  if (searchQuery.value) {
    const query = searchQuery.value.toLowerCase();
    result = result.filter(s =>
      s.name.toLowerCase().includes(query) ||
      s.studentId.includes(query)
    );
  }

  // Filter by status
  if (filterStatus.value !== 'all') {
    result = result.filter(s => s.status === filterStatus.value);
  }

  // Sort
  result = [...result].sort((a, b) => {
    switch (sortBy.value) {
      case 'name':
        return a.name.localeCompare(b.name);
      case 'score':
        return b.averageScore - a.averageScore;
      case 'submissions':
        return b.submitted - a.submitted;
      default:
        return 0;
    }
  });

  return result;
});

const goBack = () => {
  router.back();
};

const getScoreClass = (score: number) => {
  if (score >= 90) return 'excellent';
  if (score >= 80) return 'good';
  if (score >= 70) return 'average';
  return 'poor';
};

const getStatusText = (status: string) => {
  const statusMap: Record<string, string> = {
    active: '活跃',
    inactive: '不活跃',
    'at-risk': '需关注'
  };
  return statusMap[status] || status;
};

const viewStudent = (id: number) => {
  console.log('View student:', id);
  alert(`查看学生 ${id} 的详细信息`);
};

const sendMessage = (id: number) => {
  console.log('Send message to:', id);
  alert(`发送消息给学生 ${id}`);
};

const removeStudent = (id: number) => {
  if (confirm('确定要移除此学生吗？')) {
    students.value = students.value.filter(s => s.id !== id);
  }
};
</script>

<style scoped>
.teacher-students {
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
  margin-bottom: 2rem;
  gap: 1rem;
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
  flex-shrink: 0;
}

.btn-back:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
}

.header-center {
  flex: 1;
  text-align: center;
}

.header-center h1 {
  font-size: 1.75rem;
  font-weight: 800;
  margin-bottom: 0.25rem;
  font-family: 'Noto Serif SC', serif;
}

.subtitle {
  color: var(--text-secondary);
  font-size: 0.9rem;
}

.btn-add {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.75rem 1.5rem;
  background: linear-gradient(135deg, var(--accent-blue), #5a9fd4);
  color: white;
  border: none;
  border-radius: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.3s;
  box-shadow: 0 2px 8px rgba(70, 130, 180, 0.2);
  flex-shrink: 0;
}

.btn-add:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 16px rgba(70, 130, 180, 0.3);
}

/* Stats */
.stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 1.25rem;
  margin-bottom: 2rem;
}

.stat-card {
  background: var(--bg-card);
  border-radius: 16px;
  padding: 1.75rem;
  text-align: center;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05), 0 6px 16px rgba(0, 0, 0, 0.05);
  transition: all 0.3s;
}

.stat-card:hover {
  transform: translateY(-4px);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08), 0 12px 24px rgba(0, 0, 0, 0.08);
}

.stat-icon {
  width: 56px;
  height: 56px;
  background: linear-gradient(135deg, rgba(70, 130, 180, 0.1), rgba(90, 159, 212, 0.1));
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--accent-blue);
  margin: 0 auto 1rem;
}

.stat-icon.active {
  background: linear-gradient(135deg, rgba(76, 175, 80, 0.1), rgba(102, 187, 106, 0.1));
  color: var(--accent-green);
}

.stat-value {
  font-size: 1.875rem;
  font-weight: 800;
  margin-bottom: 0.375rem;
}

.stat-label {
  color: var(--text-secondary);
  font-size: 0.875rem;
  font-weight: 500;
}

/* Controls */
.controls-bar {
  display: flex;
  gap: 1rem;
  margin-bottom: 2rem;
  flex-wrap: wrap;
}

.search-box {
  flex: 1;
  min-width: 280px;
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.875rem 1.25rem;
  background: var(--bg-card);
  border-radius: 12px;
  border: 2px solid rgba(0, 0, 0, 0.05);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
  transition: all 0.3s;
}

.search-box:focus-within {
  border-color: var(--accent-blue);
  box-shadow: 0 0 0 3px rgba(70, 130, 180, 0.1);
}

.search-box svg {
  color: var(--text-tertiary);
  flex-shrink: 0;
}

.search-box input {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  font-size: 0.95rem;
  font-family: inherit;
}

.filters {
  display: flex;
  gap: 0.75rem;
}

.filter-select {
  padding: 0.875rem 1.25rem;
  background: var(--bg-card);
  border: 2px solid rgba(0, 0, 0, 0.05);
  border-radius: 12px;
  font-size: 0.95rem;
  font-family: inherit;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.3s;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
}

.filter-select:hover {
  border-color: rgba(0, 0, 0, 0.1);
}

.filter-select:focus {
  outline: none;
  border-color: var(--accent-blue);
  box-shadow: 0 0 0 3px rgba(70, 130, 180, 0.1);
}

/* Table */
.students-table-card {
  position: relative;
  background: var(--bg-card);
  border-radius: 20px;
  padding: 2rem;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05), 0 10px 30px rgba(0, 0, 0, 0.08);
}

.table-container {
  overflow-x: auto;
}

.students-table {
  width: 100%;
  border-collapse: collapse;
}

.students-table thead th {
  text-align: left;
  padding: 1rem 0.75rem;
  font-weight: 700;
  font-size: 0.875rem;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  border-bottom: 2px solid rgba(0, 0, 0, 0.08);
}

.student-row {
  border-bottom: 1px solid rgba(0, 0, 0, 0.05);
  transition: all 0.3s;
}

.student-row:hover {
  background: rgba(70, 130, 180, 0.03);
}

.students-table tbody td {
  padding: 1.125rem 0.75rem;
  vertical-align: middle;
}

.student-cell {
  display: flex;
  align-items: center;
  gap: 0.875rem;
}

.student-avatar {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  background: linear-gradient(135deg, var(--accent-blue), #5a9fd4);
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 1rem;
  flex-shrink: 0;
}

.student-name {
  font-weight: 600;
}

.progress-cell {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

.progress-text {
  font-weight: 600;
  font-size: 0.875rem;
}

.mini-progress {
  width: 80px;
  height: 6px;
  background: rgba(0, 0, 0, 0.05);
  border-radius: 999px;
  overflow: hidden;
}

.mini-progress-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--accent-blue), var(--accent-green));
  border-radius: 999px;
  transition: width 0.6s cubic-bezier(0.4, 0, 0.2, 1);
}

.score-badge {
  padding: 0.375rem 0.875rem;
  border-radius: 8px;
  font-weight: 700;
  font-size: 0.9rem;
  display: inline-block;
}

.score-badge.excellent {
  background: rgba(76, 175, 80, 0.1);
  color: var(--accent-green);
}

.score-badge.good {
  background: rgba(70, 130, 180, 0.1);
  color: var(--accent-blue);
}

.score-badge.average {
  background: rgba(255, 152, 0, 0.1);
  color: var(--accent-orange);
}

.score-badge.poor {
  background: rgba(229, 57, 53, 0.1);
  color: var(--accent-red);
}

.activity-time {
  color: var(--text-secondary);
  font-size: 0.875rem;
}

.status-badge {
  padding: 0.375rem 0.875rem;
  border-radius: 8px;
  font-weight: 600;
  font-size: 0.8rem;
  display: inline-block;
}

.status-badge.active {
  background: rgba(76, 175, 80, 0.1);
  color: var(--accent-green);
}

.status-badge.inactive {
  background: rgba(0, 0, 0, 0.05);
  color: var(--text-secondary);
}

.status-badge.at-risk {
  background: rgba(229, 57, 53, 0.1);
  color: var(--accent-red);
}

.action-buttons {
  display: flex;
  gap: 0.5rem;
}

.btn-action {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  border: none;
  background: rgba(70, 130, 180, 0.1);
  color: var(--accent-blue);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.3s;
}

.btn-action:hover {
  background: var(--accent-blue);
  color: white;
  transform: scale(1.1);
}

.btn-action.danger {
  background: rgba(229, 57, 53, 0.1);
  color: var(--accent-red);
}

.btn-action.danger:hover {
  background: var(--accent-red);
  color: white;
}

/* Fold Corners */
.fold-corner {
  position: absolute;
  width: 36px;
  height: 36px;
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

.fold-corner-br {
  bottom: 0;
  right: 0;
}

.fold-corner-br::before {
  background: linear-gradient(315deg, transparent 50%, rgba(255, 224, 178, 0.5) 50%);
}

.students-table-card:hover .fold-corner::before {
  transform: scale(1.2);
}

/* Responsive */
@media (max-width: 768px) {
  .teacher-students {
    padding: 1.5rem 1rem;
  }

  .header {
    flex-wrap: wrap;
  }

  .header-center {
    flex-basis: 100%;
    order: -1;
    margin-bottom: 1rem;
  }

  .stats-grid {
    grid-template-columns: repeat(2, 1fr);
  }

  .controls-bar {
    flex-direction: column;
  }

  .search-box {
    width: 100%;
  }

  .table-container {
    overflow-x: scroll;
  }

  .students-table {
    min-width: 800px;
  }
}
</style>
