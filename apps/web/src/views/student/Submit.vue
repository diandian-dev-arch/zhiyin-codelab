<template>
  <div class="student-submit">
    <!-- Header -->
    <header class="header">
      <button class="btn-back" @click="goBack">
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
          <path d="M12 4l-6 6 6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        返回
      </button>
      <div class="header-actions">
        <button class="btn-icon">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/>
            <path d="M12 16v-4M12 8h0" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
        </button>
      </div>
    </header>

    <!-- Assignment Info -->
    <div class="assignment-card">
      <div class="fold-corner fold-corner-tl"></div>

      <div class="assignment-header">
        <div class="assignment-icon">
          <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
            <rect x="10" y="6" width="28" height="36" rx="2" stroke="currentColor" stroke-width="2" fill="none"/>
            <path d="M10 14h28M16 10h0M20 10h0" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            <path d="M16 20h16M16 26h12M16 32h14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
        </div>
        <div class="assignment-info">
          <h1>{{ assignment.title }}</h1>
          <div class="meta-row">
            <span class="meta-item">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <rect x="3" y="4" width="10" height="1" rx="0.5" fill="currentColor"/>
                <path d="M8 1L2 4l6 3 6-3-6-3z" stroke="currentColor" stroke-width="1" fill="none"/>
                <path d="M3 5v3c0 1 1.5 2 5 2s5-1 5-2V5" stroke="currentColor" stroke-width="1" stroke-linecap="round"/>
              </svg>
              {{ assignment.course }}
            </span>
            <span class="meta-item">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5"/>
                <path d="M8 5v3l2 2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
              </svg>
              截止: {{ assignment.deadline }}
            </span>
            <span class="meta-item status-badge" :class="assignment.status">
              {{ getStatusText(assignment.status) }}
            </span>
          </div>
        </div>
      </div>

      <div class="assignment-description">
        <h3>作业要求</h3>
        <p>{{ assignment.description }}</p>
      </div>

      <div class="fold-corner fold-corner-br"></div>
    </div>

    <!-- Upload Section -->
    <div class="upload-section">
      <div class="section-title">
        <h2>提交作业</h2>
        <span class="file-count" v-if="files.length > 0">已选择 {{ files.length }} 个文件</span>
      </div>

      <div class="upload-area" @drop.prevent="handleDrop" @dragover.prevent @click="triggerFileInput">
        <input
          ref="fileInput"
          type="file"
          multiple
          @change="handleFileSelect"
          style="display: none"
        />

        <div class="upload-icon">
          <svg width="64" height="64" viewBox="0 0 64 64" fill="none">
            <rect x="12" y="20" width="40" height="32" rx="3" stroke="currentColor" stroke-width="2" fill="none" stroke-dasharray="4 4"/>
            <circle cx="32" cy="32" r="12" fill="currentColor" opacity="0.1"/>
            <path d="M32 26v12M26 32h12" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
            <path d="M22 44l-6 6h36l-6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity="0.5"/>
          </svg>
        </div>

        <div class="upload-text">
          <p class="upload-primary">点击或拖拽文件到这里上传</p>
          <p class="upload-secondary">支持 .zip, .py, .js, .java, .cpp 等格式</p>
        </div>
      </div>

      <!-- File List -->
      <div class="file-list" v-if="files.length > 0">
        <div class="file-item" v-for="(file, index) in files" :key="index">
          <div class="file-icon">
            <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
              <path d="M18 2H8a2 2 0 0 0-2 2v24a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V10l-8-8z" stroke="currentColor" stroke-width="1.5" fill="none"/>
              <path d="M18 2v8h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </div>
          <div class="file-info">
            <div class="file-name">{{ file.name }}</div>
            <div class="file-size">{{ formatFileSize(file.size) }}</div>
          </div>
          <button class="btn-remove" @click="removeFile(index)">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <path d="M5 5l10 10M15 5l-10 10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            </svg>
          </button>
        </div>
      </div>

      <!-- Comments -->
      <div class="comment-section">
        <label for="comments">备注说明（可选）</label>
        <textarea
          id="comments"
          v-model="comments"
          rows="4"
          placeholder="添加关于此次提交的说明..."
        ></textarea>
      </div>

      <!-- Submit Button -->
      <div class="submit-actions">
        <p v-if="error" class="error-message" role="alert">{{ error }}</p>
        <button class="btn-submit" :disabled="files.length === 0 || submitting" @click="submitAssignment">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <path d="M3 10l4 4 10-10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          {{ submitting ? '提交中…' : '提交作业' }}
        </button>
        <button class="btn-draft" :disabled="submitting" @click="saveDraft">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <path d="M15 2H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2z" stroke="currentColor" stroke-width="1.5"/>
            <path d="M7 10h6M7 14h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
          保存草稿
        </button>
      </div>
    </div>

    <!-- Previous Submissions -->
    <div class="history-section" v-if="submissions.length > 0">
      <h2>提交历史</h2>
      <div class="submissions-list">
        <div class="submission-item" v-for="submission in submissions" :key="submission.id">
          <div class="submission-header">
            <div class="submission-info">
              <span class="submission-date">{{ submission.date }}</span>
              <span class="submission-status" :class="submission.status">
                {{ getSubmissionStatusText(submission.status) }}
              </span>
            </div>
            <div class="submission-score" v-if="submission.score">
              {{ submission.score }}分
            </div>
          </div>
          <div class="submission-files">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M9 1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5L9 1z" stroke="currentColor" stroke-width="1" fill="none"/>
              <path d="M9 1v4h4" stroke="currentColor" stroke-width="1" stroke-linecap="round"/>
            </svg>
            {{ submission.files.join(', ') }}
          </div>
          <div class="submission-feedback" v-if="submission.feedback">
            <strong>反馈:</strong> {{ submission.feedback }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useRouter, useRoute } from 'vue-router';

const router = useRouter();
const route = useRoute();
const fileInput = ref<HTMLInputElement | null>(null);
const files = ref<File[]>([]);
const comments = ref('');
const submitting = ref(false);
const error = ref('');

const assignment = ref({
  title: '响应式网页设计项目',
  course: 'Web 开发基础',
  deadline: '2024-03-25 23:59',
  status: 'pending',
  description: '创建一个响应式的个人作品集网站，要求包含：1) 使用HTML5语义化标签；2) 使用CSS Grid或Flexbox布局；3) 实现移动端适配；4) 添加动画效果。'
});

const submissions = ref([
  {
    id: 1,
    date: '2024-03-20 15:30',
    status: 'graded',
    score: 88,
    files: ['project-v1.zip'],
    feedback: '整体完成度较好，但移动端适配还需要优化。'
  }
]);

const goBack = () => {
  router.back();
};

const triggerFileInput = () => {
  fileInput.value?.click();
};

const handleFileSelect = (event: Event) => {
  const target = event.target as HTMLInputElement;
  if (target.files) {
    files.value.push(...Array.from(target.files));
  }
};

const handleDrop = (event: DragEvent) => {
  if (event.dataTransfer?.files) {
    files.value.push(...Array.from(event.dataTransfer.files));
  }
};

const removeFile = (index: number) => {
  files.value.splice(index, 1);
};

const formatFileSize = (bytes: number): string => {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
};

const submitAssignment = async () => {
  if (submitting.value) return;
  submitting.value = true;
  error.value = '';

  try {
    // TODO: 接入真实提交 API - /api/v2/tasks/:id/submissions
    // 区分"提交已保存"和"检查已执行"
    // 保留请求身份和不确定结果恢复逻辑
    console.log('Submit:', { files: files.value, comments: comments.value });

    // 暂时阻止提交，等待接入真实 API
    throw new Error('学生提交功能正在接入真实 API，暂时不可用。');

    // router.push('/student/courses');
  } catch (err: any) {
    error.value = err.message || '提交失败，请稍后重试';
  } finally {
    submitting.value = false;
  }
};

const saveDraft = async () => {
  if (submitting.value) return;
  error.value = '';

  try {
    // TODO: 接入真实草稿保存 API
    console.log('Save draft:', { files: files.value, comments: comments.value });

    // 暂时阻止操作，等待接入真实 API
    throw new Error('草稿保存功能正在接入真实 API，暂时不可用。');
  } catch (err: any) {
    error.value = err.message || '保存失败，请稍后重试';
  }
};

const getStatusText = (status: string) => {
  const statusMap: Record<string, string> = {
    pending: '进行中',
    submitted: '已提交',
    graded: '已批改'
  };
  return statusMap[status] || status;
};

const getSubmissionStatusText = (status: string) => {
  const statusMap: Record<string, string> = {
    pending: '待批改',
    graded: '已批改',
    draft: '草稿'
  };
  return statusMap[status] || status;
};
</script>

<style scoped>
.student-submit {
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

/* Assignment Card */
.assignment-card {
  position: relative;
  background: var(--bg-card);
  border-radius: 20px;
  padding: 2.5rem;
  margin-bottom: 2rem;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05), 0 10px 30px rgba(0, 0, 0, 0.08);
}

.assignment-header {
  display: flex;
  gap: 1.5rem;
  margin-bottom: 2rem;
}

.assignment-icon {
  width: 72px;
  height: 72px;
  background: linear-gradient(135deg, rgba(76, 175, 80, 0.1), rgba(102, 187, 106, 0.1));
  border-radius: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--accent-green);
  flex-shrink: 0;
}

.assignment-info h1 {
  font-size: 1.75rem;
  font-weight: 800;
  margin-bottom: 0.75rem;
  font-family: 'Noto Serif SC', serif;
}

.meta-row {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  align-items: center;
}

.meta-item {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  color: var(--text-secondary);
  font-size: 0.9rem;
}

.status-badge {
  padding: 0.375rem 0.875rem;
  border-radius: 8px;
  font-weight: 600;
  font-size: 0.85rem;
}

.status-badge.pending {
  background: rgba(255, 152, 0, 0.1);
  color: var(--accent-orange);
}

.status-badge.submitted {
  background: rgba(70, 130, 180, 0.1);
  color: var(--accent-blue);
}

.status-badge.graded {
  background: rgba(76, 175, 80, 0.1);
  color: var(--accent-green);
}

.assignment-description {
  background: rgba(0, 0, 0, 0.02);
  border-left: 3px solid var(--accent-green);
  padding: 1.25rem 1.5rem;
  border-radius: 8px;
}

.assignment-description h3 {
  font-size: 1rem;
  font-weight: 700;
  margin-bottom: 0.75rem;
}

.assignment-description p {
  line-height: 1.7;
  color: var(--text-secondary);
}

/* Upload Section */
.upload-section {
  background: var(--bg-card);
  border-radius: 20px;
  padding: 2.5rem;
  margin-bottom: 2rem;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05), 0 10px 30px rgba(0, 0, 0, 0.08);
}

.section-title {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1.5rem;
}

.section-title h2 {
  font-size: 1.25rem;
  font-weight: 800;
  font-family: 'Noto Serif SC', serif;
}

.file-count {
  color: var(--accent-green);
  font-weight: 600;
  font-size: 0.9rem;
}

.upload-area {
  border: 2px dashed rgba(0, 0, 0, 0.15);
  border-radius: 16px;
  padding: 3rem 2rem;
  text-align: center;
  cursor: pointer;
  transition: all 0.3s;
  background: rgba(76, 175, 80, 0.02);
}

.upload-area:hover {
  border-color: var(--accent-green);
  background: rgba(76, 175, 80, 0.05);
}

.upload-icon {
  color: var(--accent-green);
  margin-bottom: 1rem;
}

.upload-primary {
  font-size: 1.125rem;
  font-weight: 600;
  margin-bottom: 0.5rem;
  color: var(--text-primary);
}

.upload-secondary {
  color: var(--text-secondary);
  font-size: 0.9rem;
}

/* File List */
.file-list {
  margin: 1.5rem 0;
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
  min-width: 0;
}

.file-name {
  font-weight: 600;
  margin-bottom: 0.25rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.file-size {
  color: var(--text-secondary);
  font-size: 0.85rem;
}

.btn-remove {
  width: 32px;
  height: 32px;
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
}

.btn-remove:hover {
  background: var(--accent-red);
  color: white;
}

/* Comments */
.comment-section {
  margin: 1.5rem 0;
}

.comment-section label {
  display: block;
  font-weight: 600;
  margin-bottom: 0.75rem;
  font-size: 0.95rem;
}

.comment-section textarea {
  width: 100%;
  padding: 1rem;
  border: 2px solid rgba(0, 0, 0, 0.08);
  border-radius: 12px;
  font-family: inherit;
  font-size: 0.95rem;
  resize: vertical;
  transition: all 0.3s;
}

.comment-section textarea:focus {
  outline: none;
  border-color: var(--accent-green);
  box-shadow: 0 0 0 3px rgba(76, 175, 80, 0.1);
}

/* Submit Actions */
.submit-actions {
  display: flex;
  gap: 1rem;
  margin-top: 2rem;
}

.btn-submit,
.btn-draft {
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

.btn-submit {
  background: linear-gradient(135deg, var(--accent-green), #66bb6a);
  color: white;
  box-shadow: 0 4px 16px rgba(76, 175, 80, 0.3);
}

.btn-submit:hover:not(:disabled) {
  transform: translateY(-2px);
  box-shadow: 0 6px 24px rgba(76, 175, 80, 0.4);
}

.btn-submit:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-draft {
  background: white;
  color: var(--text-primary);
  border: 2px solid rgba(0, 0, 0, 0.1);
}

.btn-draft:hover {
  border-color: var(--accent-blue);
  color: var(--accent-blue);
  transform: translateY(-2px);
}

/* History Section */
.history-section {
  background: var(--bg-card);
  border-radius: 20px;
  padding: 2.5rem;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05), 0 10px 30px rgba(0, 0, 0, 0.08);
}

.history-section h2 {
  font-size: 1.25rem;
  font-weight: 800;
  margin-bottom: 1.5rem;
  font-family: 'Noto Serif SC', serif;
}

.submissions-list {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.submission-item {
  background: white;
  padding: 1.25rem 1.5rem;
  border-radius: 12px;
  border: 1px solid rgba(0, 0, 0, 0.08);
}

.submission-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.75rem;
}

.submission-info {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.submission-date {
  font-weight: 600;
  font-size: 0.9rem;
}

.submission-status {
  padding: 0.25rem 0.75rem;
  border-radius: 6px;
  font-size: 0.8rem;
  font-weight: 600;
}

.submission-status.graded {
  background: rgba(76, 175, 80, 0.1);
  color: var(--accent-green);
}

.submission-status.pending {
  background: rgba(255, 152, 0, 0.1);
  color: var(--accent-orange);
}

.submission-score {
  font-size: 1.25rem;
  font-weight: 800;
  color: var(--accent-green);
}

.submission-files {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  color: var(--text-secondary);
  font-size: 0.875rem;
  margin-bottom: 0.5rem;
}

.submission-feedback {
  background: rgba(70, 130, 180, 0.05);
  padding: 0.875rem 1rem;
  border-radius: 8px;
  font-size: 0.9rem;
  line-height: 1.6;
  color: var(--text-secondary);
}

.submission-feedback strong {
  color: var(--text-primary);
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
  background: linear-gradient(135deg, transparent 50%, rgba(200, 230, 201, 0.5) 50%);
}

.fold-corner-br {
  bottom: 0;
  right: 0;
}

.fold-corner-br::before {
  background: linear-gradient(315deg, transparent 50%, rgba(255, 224, 178, 0.5) 50%);
}

.assignment-card:hover .fold-corner::before {
  transform: scale(1.2);
}

/* Responsive */
@media (max-width: 768px) {
  .student-submit {
    padding: 1.5rem 1rem;
  }

  .assignment-card,
  .upload-section,
  .history-section {
    padding: 1.75rem 1.5rem;
  }

  .assignment-header {
    flex-direction: column;
    align-items: flex-start;
  }

  .assignment-info h1 {
    font-size: 1.5rem;
  }

  .submit-actions {
    flex-direction: column;
  }

  .meta-row {
    flex-direction: column;
    align-items: flex-start;
    gap: 0.5rem;
  }

  .upload-area {
    padding: 2rem 1.5rem;
  }
}
</style>
