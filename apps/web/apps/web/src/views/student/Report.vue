<template>
  <div class="student-report">
    <!-- Header -->
    <header class="header">
      <button class="btn-back" @click="goBack">
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
          <path d="M12 4l-6 6 6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        返回
      </button>
      <div class="header-center">
        <h1>作业报告</h1>
        <p class="subtitle">{{ report.course }} - {{ report.title }}</p>
      </div>
      <button class="btn-download">
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
          <path d="M3 13v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4M10 3v10M6 9l4 4 4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        下载报告
      </button>
    </header>

    <!-- Score Card -->
    <div class="score-card">
      <div class="fold-corner fold-corner-tl"></div>

      <div class="score-section">
        <div class="score-display">
          <div class="score-value">{{ report.score }}</div>
          <div class="score-label">总分</div>
        </div>

        <div class="score-details">
          <div class="detail-item">
            <div class="detail-label">提交时间</div>
            <div class="detail-value">{{ report.submitTime }}</div>
          </div>
          <div class="detail-item">
            <div class="detail-label">批改时间</div>
            <div class="detail-value">{{ report.gradeTime }}</div>
          </div>
          <div class="detail-item">
            <div class="detail-label">状态</div>
            <div class="detail-value">
              <span class="status-badge graded">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path d="M3 8l3 3 7-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
                已批改
              </span>
            </div>
          </div>
        </div>
      </div>

      <div class="fold-corner fold-corner-br"></div>
    </div>

    <!-- Rubric Breakdown -->
    <div class="rubric-card">
      <h2>评分细则</h2>

      <div class="rubric-chart">
        <div class="rubric-item" v-for="item in report.rubric" :key="item.label">
          <div class="rubric-header">
            <span class="rubric-label">{{ item.label }}</span>
            <span class="rubric-score">{{ item.score }}/{{ item.maxScore }}</span>
          </div>
          <div class="rubric-bar">
            <div
              class="rubric-fill"
              :style="{ width: (item.score / item.maxScore * 100) + '%' }"
            ></div>
          </div>
        </div>
      </div>
    </div>

    <!-- Teacher Feedback -->
    <div class="feedback-card">
      <div class="fold-corner fold-corner-tr"></div>

      <div class="feedback-header">
        <div class="teacher-info">
          <div class="teacher-avatar">
            <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
              <rect x="5" y="9" width="22" height="3" rx="1.5" fill="currentColor"/>
              <path d="M16 3L6 8l10 5 10-5L16 3z" fill="currentColor" opacity="0.3"/>
              <path d="M16 3L6 8l10 5 10-5L16 3z" stroke="currentColor" stroke-width="1.5" fill="none"/>
              <path d="M7 11v6c0 3 4 6 9 6s9-3 9-6v-6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
          </div>
          <div>
            <h3>教师评语</h3>
            <p class="teacher-name">{{ report.teacher }}</p>
          </div>
        </div>
      </div>

      <div class="feedback-content">
        <p>{{ report.feedback }}</p>
      </div>
    </div>

    <!-- Submitted Files -->
    <div class="files-card">
      <h2>提交文件</h2>

      <div class="files-list">
        <div class="file-item" v-for="file in report.files" :key="file.name">
          <div class="file-icon">
            <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
              <path d="M18 2H8a2 2 0 0 0-2 2v24a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V10l-8-8z" stroke="currentColor" stroke-width="1.5" fill="none"/>
              <path d="M18 2v8h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </div>
          <div class="file-info">
            <div class="file-name">{{ file.name }}</div>
            <div class="file-size">{{ file.size }}</div>
          </div>
          <button class="btn-view-file">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <circle cx="9" cy="9" r="3" stroke="currentColor" stroke-width="1.5"/>
              <path d="M1 9s3-6 8-6 8 6 8 6-3 6-8 6-8-6-8-6z" stroke="currentColor" stroke-width="1.5"/>
            </svg>
            查看
          </button>
        </div>
      </div>
    </div>

    <!-- Statistics -->
    <div class="stats-section">
      <h2>作业统计</h2>

      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-icon">
            <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
              <circle cx="16" cy="16" r="12" stroke="currentColor" stroke-width="1.5" fill="none"/>
              <path d="M16 8v8l4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
          </div>
          <div class="stat-value">{{ report.stats.timeSpent }}</div>
          <div class="stat-label">完成用时</div>
        </div>

        <div class="stat-card">
          <div class="stat-icon">
            <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
              <path d="M4 16l8-8 6 6 10-10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
              <circle cx="12" cy="16" r="2" fill="currentColor"/>
              <circle cx="18" cy="10" r="2" fill="currentColor"/>
              <circle cx="28" cy="4" r="2" fill="currentColor"/>
            </svg>
          </div>
          <div class="stat-value">{{ report.stats.attempts }}</div>
          <div class="stat-label">提交次数</div>
        </div>

        <div class="stat-card">
          <div class="stat-icon">
            <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
              <rect x="6" y="10" width="20" height="16" rx="2" stroke="currentColor" stroke-width="1.5" fill="none"/>
              <path d="M6 14h20M11 6v8M21 6v8" stroke="currentColor" stroke-width="1.5"/>
            </svg>
          </div>
          <div class="stat-value">{{ report.stats.linesOfCode }}</div>
          <div class="stat-label">代码行数</div>
        </div>

        <div class="stat-card">
          <div class="stat-icon">
            <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
              <path d="M16 4l-3 6H7l5 5-2 7 6-4 6 4-2-7 5-5h-6l-3-6z" stroke="currentColor" stroke-width="1.5" fill="none"/>
            </svg>
          </div>
          <div class="stat-value">{{ report.stats.classRank }}</div>
          <div class="stat-label">班级排名</div>
        </div>
      </div>
    </div>

    <!-- Action Buttons -->
    <div class="action-section">
      <button class="btn-resubmit" @click="resubmit">
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
          <path d="M1 4v6h6M19 16v-6h-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M2.5 10c1-3.5 4-6 7.5-6 5 0 9 4 9 9s-4 9-9 9c-3.5 0-6.5-2-8-5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        </svg>
        重新提交
      </button>
      <router-link to="/student/courses" class="btn-back-to-courses">
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
          <rect x="3" y="5" width="14" height="12" rx="1.5" stroke="currentColor" stroke-width="1.5" fill="none"/>
          <path d="M3 9h14M7 5v4M13 5v4" stroke="currentColor" stroke-width="1.5"/>
        </svg>
        返回课程列表
      </router-link>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useRouter, useRoute } from 'vue-router';

const router = useRouter();
const route = useRoute();

const report = ref({
  course: 'Web 开发基础',
  title: '响应式网页设计项目',
  score: 88,
  submitTime: '2024-03-20 15:30',
  gradeTime: '2024-03-21 10:15',
  teacher: '张教授',
  feedback: '整体完成度较好，代码结构清晰，HTML 语义化做得不错。响应式布局实现正确，使用了 Flexbox 和 Grid 布局。建议：1) 移动端的触摸体验可以进一步优化，按钮点击区域可以适当增大；2) 动画效果可以更加流畅，考虑使用 transform 而不是直接改变 width/height；3) 代码注释可以更详细一些，特别是复杂的 CSS 选择器部分。继续加油！',
  rubric: [
    { label: '代码质量', score: 26, maxScore: 30 },
    { label: '功能完整度', score: 28, maxScore: 30 },
    { label: '界面设计', score: 18, maxScore: 20 },
    { label: '响应式适配', score: 16, maxScore: 20 }
  ],
  files: [
    { name: 'index.html', size: '8.5 KB' },
    { name: 'style.css', size: '12.3 KB' },
    { name: 'script.js', size: '5.2 KB' },
    { name: 'images.zip', size: '234 KB' }
  ],
  stats: {
    timeSpent: '12小时',
    attempts: 2,
    linesOfCode: 450,
    classRank: '8/45'
  }
});

const goBack = () => {
  router.back();
};

const resubmit = () => {
  router.push(`/student/submit/${route.params.id}`);
};
</script>

<style scoped>
.student-report {
  min-height: 100vh;
  padding: 2rem;
  max-width: 1000px;
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

.btn-download {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.75rem 1.25rem;
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

.btn-download:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 16px rgba(70, 130, 180, 0.3);
}

/* Score Card */
.score-card {
  position: relative;
  background: linear-gradient(135deg, var(--accent-green), #66bb6a);
  color: white;
  border-radius: 20px;
  padding: 2.5rem;
  margin-bottom: 2rem;
  box-shadow: 0 4px 20px rgba(76, 175, 80, 0.3);
}

.score-section {
  display: flex;
  gap: 3rem;
  align-items: center;
}

.score-display {
  text-align: center;
  padding-right: 3rem;
  border-right: 2px solid rgba(255, 255, 255, 0.2);
}

.score-value {
  font-size: 5rem;
  font-weight: 900;
  line-height: 1;
  margin-bottom: 0.5rem;
  text-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}

.score-label {
  font-size: 1.125rem;
  font-weight: 600;
  opacity: 0.9;
}

.score-details {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.detail-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.detail-label {
  font-weight: 600;
  opacity: 0.9;
}

.detail-value {
  font-weight: 700;
}

.status-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.375rem 0.875rem;
  border-radius: 8px;
  font-weight: 600;
  font-size: 0.875rem;
}

.status-badge.graded {
  background: rgba(255, 255, 255, 0.25);
}

/* Rubric Card */
.rubric-card,
.feedback-card,
.files-card {
  background: var(--bg-card);
  border-radius: 20px;
  padding: 2.5rem;
  margin-bottom: 2rem;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05), 0 10px 30px rgba(0, 0, 0, 0.08);
}

.rubric-card h2,
.files-card h2,
.stats-section h2 {
  font-size: 1.25rem;
  font-weight: 800;
  margin-bottom: 1.5rem;
  font-family: 'Noto Serif SC', serif;
}

.rubric-chart {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.rubric-item {
  display: flex;
  flex-direction: column;
  gap: 0.625rem;
}

.rubric-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.rubric-label {
  font-weight: 600;
}

.rubric-score {
  font-weight: 700;
  color: var(--accent-green);
  font-size: 1.125rem;
}

.rubric-bar {
  width: 100%;
  height: 12px;
  background: rgba(0, 0, 0, 0.05);
  border-radius: 999px;
  overflow: hidden;
}

.rubric-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--accent-green), #66bb6a);
  border-radius: 999px;
  transition: width 0.6s cubic-bezier(0.4, 0, 0.2, 1);
}

/* Feedback Card */
.feedback-card {
  position: relative;
}

.feedback-header {
  display: flex;
  align-items: center;
  margin-bottom: 1.5rem;
  padding-bottom: 1.5rem;
  border-bottom: 2px solid rgba(0, 0, 0, 0.05);
}

.teacher-info {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.teacher-avatar {
  width: 56px;
  height: 56px;
  background: linear-gradient(135deg, var(--accent-blue), #5a9fd4);
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
}

.feedback-header h3 {
  font-size: 1.125rem;
  font-weight: 700;
  margin-bottom: 0.25rem;
}

.teacher-name {
  color: var(--text-secondary);
  font-size: 0.9rem;
}

.feedback-content {
  background: rgba(70, 130, 180, 0.05);
  padding: 1.5rem;
  border-radius: 12px;
  border-left: 3px solid var(--accent-blue);
}

.feedback-content p {
  line-height: 1.8;
  color: var(--text-secondary);
}

/* Files */
.files-list {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.file-item {
  display: flex;
  align-items: center;
  gap: 1rem;
  background: white;
  padding: 1rem 1.25rem;
  border-radius: 12px;
  border: 1px solid rgba(0, 0, 0, 0.08);
  transition: all 0.3s;
}

.file-item:hover {
  border-color: var(--accent-green);
  box-shadow: 0 2px 8px rgba(76, 175, 80, 0.1);
}

.file-icon {
  color: var(--accent-green);
  flex-shrink: 0;
}

.file-info {
  flex: 1;
}

.file-name {
  font-weight: 600;
  margin-bottom: 0.25rem;
}

.file-size {
  color: var(--text-secondary);
  font-size: 0.85rem;
}

.btn-view-file {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.5rem 1rem;
  background: rgba(76, 175, 80, 0.1);
  color: var(--accent-green);
  border: none;
  border-radius: 8px;
  font-weight: 600;
  font-size: 0.875rem;
  cursor: pointer;
  transition: all 0.3s;
}

.btn-view-file:hover {
  background: var(--accent-green);
  color: white;
}

/* Statistics */
.stats-section {
  margin-bottom: 2rem;
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 1.25rem;
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
  background: linear-gradient(135deg, rgba(76, 175, 80, 0.1), rgba(102, 187, 106, 0.1));
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--accent-green);
  margin: 0 auto 1rem;
}

.stat-value {
  font-size: 1.75rem;
  font-weight: 800;
  margin-bottom: 0.375rem;
}

.stat-label {
  color: var(--text-secondary);
  font-size: 0.875rem;
  font-weight: 500;
}

/* Actions */
.action-section {
  display: flex;
  gap: 1rem;
}

.btn-resubmit,
.btn-back-to-courses {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  padding: 1rem 1.5rem;
  border-radius: 12px;
  font-weight: 700;
  font-size: 1rem;
  cursor: pointer;
  transition: all 0.3s;
  text-decoration: none;
  border: none;
}

.btn-resubmit {
  background: linear-gradient(135deg, var(--accent-orange), #ffa726);
  color: white;
  box-shadow: 0 4px 16px rgba(255, 152, 0, 0.3);
}

.btn-resubmit:hover {
  transform: translateY(-2px);
  box-shadow: 0 6px 24px rgba(255, 152, 0, 0.4);
}

.btn-back-to-courses {
  background: white;
  color: var(--text-primary);
  border: 2px solid rgba(0, 0, 0, 0.1);
}

.btn-back-to-courses:hover {
  border-color: var(--accent-green);
  color: var(--accent-green);
  transform: translateY(-2px);
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
  background: linear-gradient(135deg, transparent 50%, rgba(255, 255, 255, 0.2) 50%);
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
  background: linear-gradient(315deg, transparent 50%, rgba(255, 255, 255, 0.2) 50%);
}

.score-card:hover .fold-corner::before,
.feedback-card:hover .fold-corner::before {
  transform: scale(1.2);
}

/* Responsive */
@media (max-width: 768px) {
  .student-report {
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

  .score-section {
    flex-direction: column;
    gap: 2rem;
  }

  .score-display {
    border-right: none;
    border-bottom: 2px solid rgba(255, 255, 255, 0.2);
    padding-right: 0;
    padding-bottom: 2rem;
  }

  .stats-grid {
    grid-template-columns: repeat(2, 1fr);
  }

  .action-section {
    flex-direction: column;
  }
}
</style>
