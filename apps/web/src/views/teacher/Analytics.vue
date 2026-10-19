<template>
  <div class="teacher-analytics">
    <!-- Header -->
    <header class="header">
      <button class="btn-back" @click="goBack">
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
          <path d="M12 4l-6 6 6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        返回
      </button>
      <div class="header-center">
        <h1>数据分析</h1>
        <p class="subtitle">Web 开发基础 · 2024春季</p>
      </div>
      <div class="header-actions">
        <StudioSelect v-model="timeRange" class="time-select">
          <option value="week">本周</option>
          <option value="month">本月</option>
          <option value="semester">本学期</option>
        </StudioSelect>
      </div>
    </header>

    <!-- Key Metrics -->
    <div class="metrics-grid">
      <div class="metric-card">
        <div class="metric-icon">
          <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
            <circle cx="16" cy="11" r="5" stroke="currentColor" stroke-width="1.5" fill="none"/>
            <path d="M6 26c0-5.5 4.5-10 10-10s10 4.5 10 10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
        </div>
        <div class="metric-value">{{ metrics.totalStudents }}</div>
        <div class="metric-label">总学生数</div>
        <div class="metric-change positive">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M6 10V2M2 6l4-4 4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          +3 本周
        </div>
      </div>

      <div class="metric-card">
        <div class="metric-icon">
          <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
            <rect x="6" y="10" width="20" height="16" rx="2" stroke="currentColor" stroke-width="1.5" fill="none"/>
            <path d="M6 14h20M11 6v8M21 6v8" stroke="currentColor" stroke-width="1.5"/>
          </svg>
        </div>
        <div class="metric-value">{{ metrics.assignmentsCompleted }}</div>
        <div class="metric-label">已完成作业</div>
        <div class="metric-change positive">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M6 10V2M2 6l4-4 4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          +23 本周
        </div>
      </div>

      <div class="metric-card">
        <div class="metric-icon">
          <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
            <path d="M16 4l-3 6H7l5 5-2 7 6-4 6 4-2-7 5-5h-6l-3-6z" stroke="currentColor" stroke-width="1.5" fill="none"/>
          </svg>
        </div>
        <div class="metric-value">{{ metrics.averageScore }}</div>
        <div class="metric-label">平均分</div>
        <div class="metric-change positive">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M6 10V2M2 6l4-4 4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          +2.5 vs 上周
        </div>
      </div>

      <div class="metric-card">
        <div class="metric-icon">
          <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
            <circle cx="16" cy="16" r="12" stroke="currentColor" stroke-width="1.5" fill="none"/>
            <path d="M10 16l4 4 8-8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>
        <div class="metric-value">{{ metrics.completionRate }}%</div>
        <div class="metric-label">完成率</div>
        <div class="metric-change negative">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M6 2v8M2 6l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          -3% vs 上周
        </div>
      </div>
    </div>

    <!-- Charts Row -->
    <div class="charts-row">
      <!-- Score Distribution -->
      <div class="chart-card">
        <div class="fold-corner fold-corner-tl"></div>
        <h3>成绩分布</h3>
        <div class="chart-container">
          <div class="bar-chart">
            <div class="bar-item" v-for="range in scoreDistribution" :key="range.label">
              <div class="bar-wrapper">
                <div class="bar-fill" :style="{ height: range.percentage + '%' }">
                  <span class="bar-label">{{ range.count }}</span>
                </div>
              </div>
              <div class="bar-label-text">{{ range.label }}</div>
            </div>
          </div>
        </div>
      </div>

      <!-- Submission Trend -->
      <div class="chart-card">
        <div class="fold-corner fold-corner-tr"></div>
        <h3>提交趋势</h3>
        <div class="chart-container">
          <div class="line-chart">
            <div class="line-item" v-for="day in submissionTrend" :key="day.label">
              <div class="line-point" :style="{ height: day.percentage + '%' }">
                <div class="point-dot"></div>
                <span class="point-value">{{ day.value }}</span>
              </div>
              <div class="line-label">{{ day.label }}</div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Performance Tables -->
    <div class="tables-row">
      <!-- Top Performers -->
      <div class="performance-card">
        <h3>
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <path d="M10 2l-2 4H4l3 3-1 5 4-2 4 2-1-5 3-3h-4l-2-4z" stroke="currentColor" stroke-width="1.5" fill="none"/>
          </svg>
          优秀学生
        </h3>
        <div class="performance-list">
          <div class="performance-item" v-for="(student, index) in topPerformers" :key="student.name">
            <div class="rank-badge" :class="getRankClass(index)">{{ index + 1 }}</div>
            <div class="performance-avatar">{{ student.name.charAt(0) }}</div>
            <div class="performance-info">
              <div class="performance-name">{{ student.name }}</div>
              <div class="performance-score">平均分: {{ student.score }}</div>
            </div>
            <div class="performance-trend positive">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M8 12V4M4 8l4-4 4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </div>
          </div>
        </div>
      </div>

      <!-- At-Risk Students -->
      <div class="performance-card at-risk">
        <h3>
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <path d="M10 2L3 17h14L10 2z" stroke="currentColor" stroke-width="1.5" fill="none"/>
            <path d="M10 8v4M10 14h0" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
          需要关注
        </h3>
        <div class="performance-list">
          <div class="performance-item" v-for="student in atRiskStudents" :key="student.name">
            <div class="risk-badge">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5"/>
                <path d="M8 5v4M8 11h0" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
              </svg>
            </div>
            <div class="performance-avatar risk">{{ student.name.charAt(0) }}</div>
            <div class="performance-info">
              <div class="performance-name">{{ student.name }}</div>
              <div class="performance-issue">{{ student.issue }}</div>
            </div>
            <button class="btn-contact">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M14 2L7 9M14 2l-5 12-2-5-5-2 12-5z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Activity Heatmap -->
    <div class="heatmap-card">
      <div class="fold-corner fold-corner-bl"></div>
      <h3>活跃度热力图</h3>
      <div class="heatmap-container">
        <div class="heatmap-row" v-for="week in activityHeatmap" :key="week.week">
          <div class="heatmap-label">{{ week.week }}</div>
          <div class="heatmap-days">
            <div
              class="heatmap-cell"
              v-for="day in week.days"
              :key="day.date"
              :class="getActivityClass(day.activity)"
              :title="`${day.date}: ${day.activity} 次活动`"
            ></div>
          </div>
        </div>
      </div>
      <div class="heatmap-legend">
        <span>少</span>
        <div class="legend-cell level-0"></div>
        <div class="legend-cell level-1"></div>
        <div class="legend-cell level-2"></div>
        <div class="legend-cell level-3"></div>
        <div class="legend-cell level-4"></div>
        <span>多</span>
      </div>
      <div class="fold-corner fold-corner-br"></div>
    </div>
  </div>
</template>

<script setup lang="ts">
import StudioSelect from '../../components/StudioSelect.vue';
import { ref } from 'vue';
import { useRouter } from 'vue-router';

const router = useRouter();
const timeRange = ref('month');

const metrics = {
  totalStudents: 45,
  assignmentsCompleted: 387,
  averageScore: 82.5,
  completionRate: 76
};

const scoreDistribution = [
  { label: '0-59', count: 3, percentage: 15 },
  { label: '60-69', count: 5, percentage: 25 },
  { label: '70-79', count: 12, percentage: 60 },
  { label: '80-89', count: 18, percentage: 90 },
  { label: '90-100', count: 7, percentage: 35 }
];

const submissionTrend = [
  { label: '周一', value: 12, percentage: 40 },
  { label: '周二', value: 18, percentage: 60 },
  { label: '周三', value: 25, percentage: 83 },
  { label: '周四', value: 30, percentage: 100 },
  { label: '周五', value: 22, percentage: 73 },
  { label: '周六', value: 15, percentage: 50 },
  { label: '周日', value: 10, percentage: 33 }
];

const topPerformers = [
  { name: '王五', score: 92 },
  { name: '张三', score: 88 },
  { name: '李四', score: 85 },
  { name: '赵六', score: 83 }
];

const atRiskStudents = [
  { name: '孙七', issue: '5次未提交' },
  { name: '周八', issue: '平均分68' },
  { name: '吴九', issue: '7天未活跃' }
];

const activityHeatmap = [
  {
    week: '第1周',
    days: [
      { date: '3/4', activity: 12 },
      { date: '3/5', activity: 18 },
      { date: '3/6', activity: 25 },
      { date: '3/7', activity: 30 },
      { date: '3/8', activity: 22 },
      { date: '3/9', activity: 15 },
      { date: '3/10', activity: 8 }
    ]
  },
  {
    week: '第2周',
    days: [
      { date: '3/11', activity: 10 },
      { date: '3/12', activity: 20 },
      { date: '3/13', activity: 28 },
      { date: '3/14', activity: 35 },
      { date: '3/15', activity: 25 },
      { date: '3/16', activity: 12 },
      { date: '3/17', activity: 6 }
    ]
  },
  {
    week: '第3周',
    days: [
      { date: '3/18', activity: 15 },
      { date: '3/19', activity: 22 },
      { date: '3/20', activity: 30 },
      { date: '3/21', activity: 28 },
      { date: '3/22', activity: 20 },
      { date: '3/23', activity: 10 },
      { date: '3/24', activity: 5 }
    ]
  },
  {
    week: '第4周',
    days: [
      { date: '3/25', activity: 18 },
      { date: '3/26', activity: 25 },
      { date: '3/27', activity: 32 },
      { date: '3/28', activity: 40 },
      { date: '3/29', activity: 28 },
      { date: '3/30', activity: 16 },
      { date: '3/31', activity: 9 }
    ]
  }
];

const goBack = () => {
  router.back();
};

const getRankClass = (index: number) => {
  if (index === 0) return 'gold';
  if (index === 1) return 'silver';
  if (index === 2) return 'bronze';
  return '';
};

const getActivityClass = (activity: number) => {
  if (activity === 0) return 'level-0';
  if (activity < 10) return 'level-1';
  if (activity < 20) return 'level-2';
  if (activity < 30) return 'level-3';
  return 'level-4';
};
</script>

<style scoped>
.teacher-analytics {
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

.time-select {
  padding: 0.75rem 1.25rem;
  background: var(--bg-card);
  border: 2px solid rgba(0, 0, 0, 0.05);
  border-radius: 12px;
  font-size: 0.95rem;
  font-family: inherit;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.3s;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
}

.time-select:focus {
  outline: none;
  border-color: var(--accent-blue);
  box-shadow: 0 0 0 3px rgba(70, 130, 180, 0.1);
}

/* Metrics */
.metrics-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 1.25rem;
  margin-bottom: 2rem;
}

.metric-card {
  background: var(--bg-card);
  border-radius: 16px;
  padding: 1.75rem;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05), 0 6px 16px rgba(0, 0, 0, 0.05);
  transition: all 0.3s;
}

.metric-card:hover {
  transform: translateY(-4px);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08), 0 12px 24px rgba(0, 0, 0, 0.08);
}

.metric-icon {
  width: 56px;
  height: 56px;
  background: linear-gradient(135deg, rgba(70, 130, 180, 0.1), rgba(90, 159, 212, 0.1));
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--accent-blue);
  margin-bottom: 1rem;
}

.metric-value {
  font-size: 2rem;
  font-weight: 800;
  margin-bottom: 0.375rem;
}

.metric-label {
  color: var(--text-secondary);
  font-size: 0.875rem;
  font-weight: 500;
  margin-bottom: 0.625rem;
}

.metric-change {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  font-size: 0.8rem;
  font-weight: 600;
  padding: 0.25rem 0.625rem;
  border-radius: 6px;
}

.metric-change.positive {
  background: rgba(76, 175, 80, 0.1);
  color: var(--accent-green);
}

.metric-change.negative {
  background: rgba(229, 57, 53, 0.1);
  color: var(--accent-red);
}

/* Charts */
.charts-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
  gap: 1.5rem;
  margin-bottom: 2rem;
}

.chart-card {
  position: relative;
  background: var(--bg-card);
  border-radius: 20px;
  padding: 2rem;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05), 0 10px 30px rgba(0, 0, 0, 0.08);
}

.chart-card h3 {
  font-size: 1.125rem;
  font-weight: 700;
  margin-bottom: 1.5rem;
}

.chart-container {
  height: 240px;
  display: flex;
  align-items: flex-end;
  justify-content: center;
}

/* Bar Chart */
.bar-chart {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: flex-end;
  justify-content: space-around;
  gap: 1rem;
}

.bar-item {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
}

.bar-wrapper {
  width: 100%;
  height: 200px;
  display: flex;
  align-items: flex-end;
}

.bar-fill {
  width: 100%;
  background: linear-gradient(180deg, var(--accent-blue), #5a9fd4);
  border-radius: 8px 8px 0 0;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 0.5rem;
  transition: height 0.6s cubic-bezier(0.4, 0, 0.2, 1);
  position: relative;
}

.bar-fill .bar-label {
  color: white;
  font-weight: 700;
  font-size: 0.875rem;
}

.bar-label-text {
  font-size: 0.8rem;
  color: var(--text-secondary);
  font-weight: 600;
}

/* Line Chart */
.line-chart {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0 1rem;
}

.line-item {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
}

.line-point {
  width: 100%;
  height: 200px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  position: relative;
}

.point-dot {
  width: 12px;
  height: 12px;
  background: var(--accent-green);
  border: 3px solid white;
  border-radius: 50%;
  box-shadow: 0 2px 8px rgba(76, 175, 80, 0.3);
}

.point-value {
  position: absolute;
  top: -1.5rem;
  font-size: 0.8rem;
  font-weight: 700;
  color: var(--text-primary);
}

.line-label {
  font-size: 0.8rem;
  color: var(--text-secondary);
  font-weight: 600;
}

/* Performance Tables */
.tables-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
  gap: 1.5rem;
  margin-bottom: 2rem;
}

.performance-card {
  background: var(--bg-card);
  border-radius: 20px;
  padding: 2rem;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05), 0 10px 30px rgba(0, 0, 0, 0.08);
}

.performance-card h3 {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 1.125rem;
  font-weight: 700;
  margin-bottom: 1.5rem;
  color: var(--accent-blue);
}

.performance-card.at-risk h3 {
  color: var(--accent-red);
}

.performance-list {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.performance-item {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 1rem;
  background: white;
  border-radius: 12px;
  border: 1px solid rgba(0, 0, 0, 0.05);
  transition: all 0.3s;
}

.performance-item:hover {
  border-color: var(--accent-blue);
  box-shadow: 0 2px 8px rgba(70, 130, 180, 0.1);
}

.rank-badge {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.05);
  color: var(--text-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 800;
  font-size: 0.875rem;
  flex-shrink: 0;
}

.rank-badge.gold {
  background: linear-gradient(135deg, #ffd700, #ffed4e);
  color: #8b6914;
}

.rank-badge.silver {
  background: linear-gradient(135deg, #c0c0c0, #e8e8e8);
  color: #666;
}

.rank-badge.bronze {
  background: linear-gradient(135deg, #cd7f32, #e09756);
  color: #5c3a1a;
}

.risk-badge {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  background: rgba(229, 57, 53, 0.1);
  color: var(--accent-red);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.performance-avatar {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  background: linear-gradient(135deg, var(--accent-blue), #5a9fd4);
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  flex-shrink: 0;
}

.performance-avatar.risk {
  background: linear-gradient(135deg, var(--accent-red), #ef5350);
}

.performance-info {
  flex: 1;
  min-width: 0;
}

.performance-name {
  font-weight: 600;
  margin-bottom: 0.25rem;
}

.performance-score,
.performance-issue {
  font-size: 0.85rem;
  color: var(--text-secondary);
}

.performance-trend {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.performance-trend.positive {
  background: rgba(76, 175, 80, 0.1);
  color: var(--accent-green);
}

.btn-contact {
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
  flex-shrink: 0;
}

.btn-contact:hover {
  background: var(--accent-blue);
  color: white;
  transform: scale(1.1);
}

/* Heatmap */
.heatmap-card {
  position: relative;
  background: var(--bg-card);
  border-radius: 20px;
  padding: 2rem;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05), 0 10px 30px rgba(0, 0, 0, 0.08);
}

.heatmap-card h3 {
  font-size: 1.125rem;
  font-weight: 700;
  margin-bottom: 1.5rem;
}

.heatmap-container {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-bottom: 1rem;
}

.heatmap-row {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.heatmap-label {
  width: 60px;
  font-size: 0.8rem;
  color: var(--text-secondary);
  font-weight: 600;
}

.heatmap-days {
  display: flex;
  gap: 0.375rem;
}

.heatmap-cell {
  width: 20px;
  height: 20px;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.3s;
}

.heatmap-cell:hover {
  transform: scale(1.2);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
}

.heatmap-cell.level-0 {
  background: rgba(0, 0, 0, 0.05);
}

.heatmap-cell.level-1 {
  background: rgba(70, 130, 180, 0.2);
}

.heatmap-cell.level-2 {
  background: rgba(70, 130, 180, 0.4);
}

.heatmap-cell.level-3 {
  background: rgba(70, 130, 180, 0.6);
}

.heatmap-cell.level-4 {
  background: rgba(70, 130, 180, 0.9);
}

.heatmap-legend {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  justify-content: flex-end;
  padding-top: 1rem;
  border-top: 1px solid rgba(0, 0, 0, 0.05);
}

.heatmap-legend span {
  font-size: 0.8rem;
  color: var(--text-secondary);
}

.legend-cell {
  width: 16px;
  height: 16px;
  border-radius: 3px;
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

.fold-corner-tr {
  top: 0;
  right: 0;
}

.fold-corner-tr::before {
  background: linear-gradient(225deg, transparent 50%, rgba(200, 230, 201, 0.5) 50%);
}

.fold-corner-bl {
  bottom: 0;
  left: 0;
}

.fold-corner-bl::before {
  background: linear-gradient(45deg, transparent 50%, rgba(248, 187, 208, 0.5) 50%);
}

.fold-corner-br {
  bottom: 0;
  right: 0;
}

.fold-corner-br::before {
  background: linear-gradient(315deg, transparent 50%, rgba(255, 224, 178, 0.5) 50%);
}

.chart-card:hover .fold-corner::before,
.heatmap-card:hover .fold-corner::before {
  transform: scale(1.2);
}

/* Responsive */
@media (max-width: 992px) {
  .charts-row,
  .tables-row {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 768px) {
  .teacher-analytics {
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

  .metrics-grid {
    grid-template-columns: repeat(2, 1fr);
  }

  .heatmap-days {
    gap: 0.25rem;
  }

  .heatmap-cell {
    width: 16px;
    height: 16px;
  }
}
</style>
