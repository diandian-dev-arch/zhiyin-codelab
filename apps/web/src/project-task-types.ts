import type { SourceProjectReportData } from '@codelab/contracts/source';

export type ProjectRubric = { id: string; title: string; description?: string };
export type ProjectEvaluation = {
  feedback?: string;
  outcome?: 'achieved' | 'needs_revision' | 'pending';
  featured: boolean;
  featureReason?: string;
  updatedAt?: string;
};
export type ProjectSubmission = {
  id: string;
  taskId: string;
  userId: string;
  studentName: string;
  projectId: string;
  projectName: string;
  version: number;
  note: string;
  revisionNote: string;
  createdAt: string;
  late: boolean;
  analysisId: string | null;
  analysisStatus: string | null;
  reviewCount: number;
  recommendations: number;
  evaluation: ProjectEvaluation | null;
  showcaseConsent: boolean;
};
export type ProjectTaskData = {
  task: {
    taskId: string;
    classId: string;
    title: string;
    description: string;
    kind: 'project';
    dueAt: string | null;
    teacherId: string;
    rubric: ProjectRubric[];
  };
  submissions: ProjectSubmission[];
  showcase: ProjectSubmission[];
  myProjects: Array<{ id: string; name: string; status: string | null }>;
};
export type ProjectPeerReview = {
  id: string;
  reviewerId: string;
  reviewerName: string;
  strength: string;
  improvement: string;
  recommend: boolean;
  updatedAt: string;
};
export type ProjectReportEnvelope = {
  report: SourceProjectReportData;
  read?: Record<string, unknown>;
  coverage?: { indexedFiles: number; readFiles: number };
};
export type ProjectSubmissionDetail = {
  submission: ProjectSubmission;
  analysis: { id: string; status: string; report: ProjectReportEnvelope | SourceProjectReportData | null } | null;
  pendingAnalysis?: { id: string; status: string; code?: string | null; canCancel?: boolean; report?: SourceProjectReportData | null } | null;
  peerReviews: ProjectPeerReview[];
  myReview?: ProjectPeerReview | null;
};
