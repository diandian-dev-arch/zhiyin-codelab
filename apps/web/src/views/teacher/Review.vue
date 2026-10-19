<template>
  <div class="teacher-review">
    <!-- Header -->
    <header class="header">
      <button class="btn-back" @click="goBack">
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
          <path d="M12 4l-6 6 6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        返回
      </button>
      <div class="header-center">
        <h1>作业审阅</h1>
        <p class="subtitle">{{ assignment.course }} - {{ assignment.title }}</p>
      </div>
      <div class="header-actions">
        <button class="btn-icon" @click="showInfo">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/>
            <path d="M12 16v-4M12 8h0" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
        </button>
      </div>
    </header>

    <div class="review-container">
      <!-- Left Panel: Student List -->
      <div class="students-panel">
        <div class="panel-header">
          <h2>学生列表</h2>
          <span class="count">{{ submissions.length }}</span>
        </div>

        <div class="filter-tabs">
          <button
            class="filter-tab"
            :class="{ active: filter === 'all' }"
            @click="filter = 'all'"
          >
            全部
          </button>
          <button
            class="filter-tab"
            :class="{ active: filter === 'pending' }"
            @click="filter = 'pending'"
          >
            待批改
          </button>
          <button
            class="filter-tab"
            :class="{ active: filter === 'graded' }"
            @click="filter = 'graded'"
          >
            已批改
          </button>
        </div>

        <div class="students-list">
          <div
            class="student-item"
            v-for="submission in filteredSubmissions"
            :key="submission.id"
            :class="{ active: selectedSubmission?.id === submission.id }"
            @click="selectSubmission(submission)"
          >
            <div class="student-avatar">{{ submission.student.charAt(0) }}</div>
            <div class="student-info">
              <div class="student-name">{{ submission.student }}</div>
              <div class="student-meta">
                <span class="submit-time">{{ submission.submitTime }}</span>
              </div>
            </div>
            <div class="student-status">
              <span v-if="submission.status === 'pending'" class="status-badge pending">待批改</span>
              <span v-else class="status-badge graded">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path d="M3 8l3 3 7-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
                {{ submission.score }}
              </span>
            </div>
          </div>
        </div>
      </div>

      <!-- Right Panel: Review Content -->
      <div class="review-panel" v-if="selectedSubmission">
        <div class="review-card">
          <div class="fold-corner fold-corner-tl"></div>

          <!-- Student Info -->
          <div class="student-header">
            <div class="student-avatar-large">{{ selectedSubmission.student.charAt(0) }}</div>
            <div class="student-details">
              <h3>{{ selectedSubmission.student }}</h3>
              <div class="meta-row">
                <span class="meta-item">
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                    <circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5"/>
                    <path d="M8 5v3l2 2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                  </svg>
                  提交时间: {{ selectedSubmission.submitTime }}
                </span>
                <span class="meta-item">
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                    <path d="M2 8l4-4 4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>
                  第 {{ selectedSubmission.attemptNumber }} 次提交
                </span>
              </div>
            </div>
          </div>

          <!-- Files Section -->
          <div class="files-section">
            <h4>提交文件</h4>
            <div class="files-list">
              <div class="file-card" v-for="file in selectedSubmission.files" :key="file.name">
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
                <button class="btn-view">
                  <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                    <circle cx="9" cy="9" r="3" stroke="currentColor" stroke-width="1.5"/>
                    <path d="M1 9s3-6 8-6 8 6 8 6-3 6-8 6-8-6-8-6z" stroke="currentColor" stroke-width="1.5"/>
                  </svg>
                  查看
                </button>
              </div>
            </div>
          </div>

          <!-- Code Preview -->
          <div class="code-section">
            <h4>代码预览</h4>
            <div class="code-preview">
              <div class="code-header">
                <span class="code-file">main.py</span>
                <div class="code-actions">
                  <button class="btn-code-action">
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                      <rect x="2" y="2" width="12" height="12" rx="1" stroke="currentColor" stroke-width="1.5"/>
                      <path d="M5 2v12M11 2v12M2 8h12" stroke="currentColor" stroke-width="1.5"/>
                    </svg>
                  </button>
                  <button class="btn-code-action">
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                      <rect x="4" y="4" width="8" height="8" rx="1" stroke="currentColor" stroke-width="1.5"/>
                      <path d="M2 6V3a1 1 0 0 1 1-1h3M10 2h3a1 1 0 0 1 1 1v3" stroke="currentColor" stroke-width="1.5"/>
                    </svg>
                  </button>
                </div>
              </div>
              <pre class="code-content"><code>{{ selectedSubmission.codePreview }}</code></pre>
            </div>
          </div>

          <!-- Grading Section -->
          <div class="grading-section">
            <h4>评分与反馈</h4>

            <div class="score-input-group">
              <label for="score">分数</label>
              <div class="score-input-wrapper">
                <input
                  type="number"
                  id="score"
                  v-model.number="gradeForm.score"
                  min="0"
                  max="100"
                  placeholder="0-100"
                />
                <span class="score-suffix">/ 100</span>
              </div>
            </div>

            <div class="feedback-group">
              <label for="feedback">评语</label>
              <textarea
                id="feedback"
                v-model="gradeForm.feedback"
                rows="6"
                placeholder="请输入对学生作业的评价和建议..."
              ></textarea>
            </div>

            <div class="rubric-section">
              <label>评分细则</label>
              <div class="rubric-items">
                <div class="rubric-item" v-for="(item, index) in gradeForm.rubric" :key="index">
                  <div class="rubric-label">{{ item.label }}</div>
                  <input
                    type="number"
                    v-model.number="item.score"
                    :max="item.maxScore"
                    min="0"
                  />
                  <span class="rubric-max">/ {{ item.maxScore }}</span>
                </div>
              </div>
            </div>
          </div>

          <!-- Action Buttons -->
          <div class="review-actions">
            <button class="btn-submit-grade" @click="submitGrade">
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                <path d="M3 10l4 4 10-10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
              提交评分
            </button>
            <button class="btn-save-draft" @click="saveDraft">
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                <path d="M15 2H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2z" stroke="currentColor" stroke-width="1.5"/>
                <path d="M13 2v5H7V2M7 18v-6h6v6" stroke="currentColor" stroke-width="1.5"/>
              </svg>
              保存草稿
            </button>
          </div>

          <div class="fold-corner fold-corner-br"></div>
        </div>
      </div>

      <!-- Empty State -->
      <div class="review-panel empty" v-else>
        <div class="empty-state">
          <div class="empty-icon">
            <svg width="80" height="80" viewBox="0 0 80 80" fill="none">
              <rect x="15" y="10" width="50" height="60" rx="3" stroke="currentColor" stroke-width="2" fill="none" stroke-dasharray="4 4"/>
              <path d="M25 25h30M25 35h25M25 45h28" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.3"/>
            </svg>
          </div>
          <p class="empty-text">请从左侧选择学生作业进行审阅</p>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { useRouter, useRoute } from 'vue-router';

const router = useRouter();
const route = useRoute();
const filter = ref<'all' | 'pending' | 'graded'>('all');

interface Submission {
  id: number;
  student: string;
  submitTime: string;
  status: 'pending' | 'graded';
  score?: number;
  attemptNumber: number;
  files: Array<{ name: string; size: string }>;
  codePreview: string;
}

const assignment = ref({
  course: 'Web 开发基础',
  title: '响应式网页设计项目'
});

const submissions = ref<Submission[]>([
  {
    id: 1,
    student: '张三',
    submitTime: '2024-03-20 15:30',
    status: 'pending',
    attemptNumber: 1,
    files: [
      { name: 'index.html', size: '8.5 KB' },
      { name: 'style.css', size: '12.3 KB' },
      { name: 'script.js', size: '5.2 KB' }
    ],
    codePreview: `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>个人作品集</title>
    <link rel="stylesheet" href="style.css">
</head>
<body>
    <header>
        <nav>...</nav>
    </header>
    <main>
        <section class="hero">...</section>
    </main>
</body>
</html>`
  },
  {
    id: 2,
    student: '李四',
    submitTime: '2024-03-19 22:15',
    status: 'graded',
    score: 88,
    attemptNumber: 2,
    files: [
      { name: 'project.zip', size: '156 KB' }
    ],
    codePreview: `// JavaScript code here...`
  },
  {
    id: 3,
    student: '王五',
    submitTime: '2024-03-21 10:00',
    status: 'pending',
    attemptNumber: 1,
    files: [
      { name: 'portfolio.html', size: '15.8 KB' }
    ],
    codePreview: `<!-- HTML code here... -->`
  }
]);

const selectedSubmission = ref<Submission | null>(null);

const gradeForm = ref({
  score: 0,
  feedback: '',
  rubric: [
    { label: '代码质量', score: 0, maxScore: 30 },
    { label: '功能完整度', score: 0, maxScore: 30 },
    { label: '界面设计', score: 0, maxScore: 20 },
    { label: '响应式适配', score: 0, maxScore: 20 }
  ]
});

const filteredSubmissions = computed(() => {
  if (filter.value === 'all') return submissions.value;
  return submissions.value.filter(s => s.status === filter.value);
});

const goBack = () => {
  router.back();
};

const selectSubmission = (submission: Submission) => {
  selectedSubmission.value = submission;
  gradeForm.value.score = submission.score || 0;
  gradeForm.value.feedback = '';
};

const showInfo = () => {
  alert('作业信息');
};

const submitGrade = () => {
  console.log('Submit grade:', gradeForm.value);
  alert('此页面是未接入的设计原型。请从实训任务进入真实提交进行复核；此处没有保存评分。');
};

const saveDraft = () => {
  console.log('Save draft:', gradeForm.value);
  alert('此页面是未接入的设计原型，此处没有保存草稿。');
};
</script>

<style scoped>
.teacher-review {
  min-height: 100vh;
  padding: 2rem;
  max-width: 1600px;
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
  flex-shrink: 0;
}

.btn-icon:hover {
  background: white;
  color: var(--text-primary);
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
}

/* Container */
.review-container {
  display: grid;
  grid-template-columns: 320px 1fr;
  gap: 1.5rem;
  align-items: start;
}

/* Students Panel */
.students-panel {
  background: var(--bg-card);
  border-radius: 18px;
  padding: 1.5rem;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05), 0 8px 20px rgba(0, 0, 0, 0.06);
  position: sticky;
  top: 2rem;
  max-height: calc(100vh - 4rem);
  display: flex;
  flex-direction: column;
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1.25rem;
}

.panel-header h2 {
  font-size: 1.125rem;
  font-weight: 700;
}

.count {
  background: rgba(70, 130, 180, 0.1);
  color: var(--accent-blue);
  padding: 0.25rem 0.75rem;
  border-radius: 12px;
  font-size: 0.875rem;
  font-weight: 700;
}

.filter-tabs {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 1rem;
  background: rgba(0, 0, 0, 0.02);
  padding: 0.375rem;
  border-radius: 10px;
}

.filter-tab {
  flex: 1;
  padding: 0.5rem;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-weight: 600;
  font-size: 0.85rem;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.3s;
}

.filter-tab:hover {
  color: var(--text-primary);
}

.filter-tab.active {
  background: white;
  color: var(--accent-blue);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.08);
}

.students-list {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.student-item {
  display: flex;
  align-items: center;
  gap: 0.875rem;
  padding: 1rem;
  background: white;
  border-radius: 12px;
  border: 2px solid transparent;
  cursor: pointer;
  transition: all 0.3s;
}

.student-item:hover {
  border-color: var(--accent-blue);
  transform: translateX(4px);
}

.student-item.active {
  border-color: var(--accent-blue);
  background: linear-gradient(135deg, rgba(70, 130, 180, 0.05), rgba(90, 159, 212, 0.05));
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
  font-size: 1.125rem;
  flex-shrink: 0;
}

.student-info {
  flex: 1;
  min-width: 0;
}

.student-name {
  font-weight: 600;
  margin-bottom: 0.25rem;
}

.student-meta {
  font-size: 0.8rem;
  color: var(--text-secondary);
}

.student-status {
  flex-shrink: 0;
}

.status-badge {
  padding: 0.375rem 0.75rem;
  border-radius: 8px;
  font-size: 0.8rem;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
}

.status-badge.pending {
  background: rgba(255, 152, 0, 0.1);
  color: var(--accent-orange);
}

.status-badge.graded {
  background: rgba(76, 175, 80, 0.1);
  color: var(--accent-green);
}

/* Review Panel */
.review-panel {
  min-height: 600px;
}

.review-panel.empty {
  background: var(--bg-card);
  border-radius: 20px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05), 0 10px 30px rgba(0, 0, 0, 0.08);
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 6rem 2rem;
  text-align: center;
}

.empty-icon {
  color: var(--text-tertiary);
  margin-bottom: 1.5rem;
}

.empty-text {
  color: var(--text-secondary);
  font-size: 1.125rem;
}

.review-card {
  position: relative;
  background: var(--bg-card);
  border-radius: 20px;
  padding: 2.5rem;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05), 0 10px 30px rgba(0, 0, 0, 0.08);
}

/* Student Header */
.student-header {
  display: flex;
  gap: 1.5rem;
  margin-bottom: 2.5rem;
  padding-bottom: 2rem;
  border-bottom: 2px solid rgba(0, 0, 0, 0.05);
}

.student-avatar-large {
  width: 72px;
  height: 72px;
  border-radius: 16px;
  background: linear-gradient(135deg, var(--accent-blue), #5a9fd4);
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 800;
  font-size: 1.75rem;
  flex-shrink: 0;
  box-shadow: 0 4px 16px rgba(70, 130, 180, 0.3);
}

.student-details h3 {
  font-size: 1.5rem;
  font-weight: 800;
  margin-bottom: 0.75rem;
}

.meta-row {
  display: flex;
  flex-wrap: wrap;
  gap: 1.5rem;
}

.meta-item {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  color: var(--text-secondary);
  font-size: 0.9rem;
}

/* Files Section */
.files-section,
.code-section,
.grading-section {
  margin-bottom: 2.5rem;
}

.files-section h4,
.code-section h4,
.grading-section h4 {
  font-size: 1.125rem;
  font-weight: 700;
  margin-bottom: 1rem;
}

.files-list {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.file-card {
  display: flex;
  align-items: center;
  gap: 1rem;
  background: white;
  padding: 1rem 1.25rem;
  border-radius: 12px;
  border: 1px solid rgba(0, 0, 0, 0.08);
  transition: all 0.3s;
}

.file-card:hover {
  border-color: var(--accent-blue);
  box-shadow: 0 2px 8px rgba(70, 130, 180, 0.1);
}

.file-icon {
  color: var(--accent-blue);
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

.btn-view {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.5rem 1rem;
  background: rgba(70, 130, 180, 0.1);
  color: var(--accent-blue);
  border: none;
  border-radius: 8px;
  font-weight: 600;
  font-size: 0.875rem;
  cursor: pointer;
  transition: all 0.3s;
}

.btn-view:hover {
  background: var(--accent-blue);
  color: white;
}

/* Code Preview */
.code-preview {
  background: #1e1e1e;
  border-radius: 12px;
  overflow: hidden;
}

.code-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.875rem 1.25rem;
  background: #2d2d2d;
  border-bottom: 1px solid #3d3d3d;
}

.code-file {
  color: #e0e0e0;
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.875rem;
  font-weight: 600;
}

.code-actions {
  display: flex;
  gap: 0.5rem;
}

.btn-code-action {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  border: none;
  background: rgba(255, 255, 255, 0.1);
  color: #e0e0e0;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.3s;
}

.btn-code-action:hover {
  background: rgba(255, 255, 255, 0.2);
}

.code-content {
  padding: 1.5rem 1.25rem;
  margin: 0;
  overflow-x: auto;
}

.code-content code {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.875rem;
  line-height: 1.6;
  color: #e0e0e0;
}

/* Grading Section */
.score-input-group,
.feedback-group {
  margin-bottom: 1.5rem;
}

.score-input-group label,
.feedback-group label,
.rubric-section label {
  display: block;
  font-weight: 600;
  margin-bottom: 0.625rem;
  font-size: 0.95rem;
}

.score-input-wrapper {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  max-width: 200px;
}

.score-input-wrapper input {
  flex: 1;
  padding: 0.875rem 1rem;
  border: 2px solid rgba(0, 0, 0, 0.08);
  border-radius: 12px;
  font-size: 1.125rem;
  font-weight: 700;
  font-family: inherit;
  transition: all 0.3s;
  text-align: center;
}

.score-input-wrapper input:focus {
  outline: none;
  border-color: var(--accent-blue);
  box-shadow: 0 0 0 3px rgba(70, 130, 180, 0.1);
}

.score-suffix {
  font-weight: 600;
  color: var(--text-secondary);
}

.feedback-group textarea {
  width: 100%;
  padding: 1rem;
  border: 2px solid rgba(0, 0, 0, 0.08);
  border-radius: 12px;
  font-family: inherit;
  font-size: 0.95rem;
  resize: vertical;
  transition: all 0.3s;
}

.feedback-group textarea:focus {
  outline: none;
  border-color: var(--accent-blue);
  box-shadow: 0 0 0 3px rgba(70, 130, 180, 0.1);
}

/* Rubric */
.rubric-items {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.rubric-item {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 1rem 1.25rem;
  background: white;
  border-radius: 12px;
  border: 1px solid rgba(0, 0, 0, 0.08);
}

.rubric-label {
  flex: 1;
  font-weight: 600;
}

.rubric-item input {
  width: 70px;
  padding: 0.5rem 0.75rem;
  border: 2px solid rgba(0, 0, 0, 0.08);
  border-radius: 8px;
  font-size: 1rem;
  font-weight: 600;
  text-align: center;
  font-family: inherit;
  transition: all 0.3s;
}

.rubric-item input:focus {
  outline: none;
  border-color: var(--accent-blue);
  box-shadow: 0 0 0 3px rgba(70, 130, 180, 0.1);
}

.rubric-max {
  color: var(--text-secondary);
  font-weight: 600;
}

/* Actions */
.review-actions {
  display: flex;
  gap: 1rem;
  margin-top: 2rem;
}

.btn-submit-grade,
.btn-save-draft {
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
  border: none;
}

.btn-submit-grade {
  background: linear-gradient(135deg, var(--accent-green), #66bb6a);
  color: white;
  box-shadow: 0 4px 16px rgba(76, 175, 80, 0.3);
}

.btn-submit-grade:hover {
  transform: translateY(-2px);
  box-shadow: 0 6px 24px rgba(76, 175, 80, 0.4);
}

.btn-save-draft {
  background: white;
  color: var(--text-primary);
  border: 2px solid rgba(0, 0, 0, 0.1);
}

.btn-save-draft:hover {
  border-color: var(--accent-blue);
  color: var(--accent-blue);
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
  background: linear-gradient(135deg, transparent 50%, rgba(184, 217, 240, 0.5) 50%);
}

.fold-corner-br {
  bottom: 0;
  right: 0;
}

.fold-corner-br::before {
  background: linear-gradient(315deg, transparent 50%, rgba(255, 224, 178, 0.5) 50%);
}

.review-card:hover .fold-corner::before {
  transform: scale(1.2);
}

/* Responsive */
@media (max-width: 1200px) {
  .review-container {
    grid-template-columns: 280px 1fr;
  }
}

@media (max-width: 992px) {
  .review-container {
    grid-template-columns: 1fr;
  }

  .students-panel {
    position: static;
    max-height: none;
  }
}

@media (max-width: 768px) {
  .teacher-review {
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

  .review-card {
    padding: 1.75rem 1.5rem;
  }

  .review-actions {
    flex-direction: column;
  }
}
</style>
