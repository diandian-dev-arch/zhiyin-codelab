import type { DB } from './db.js';

/** Only minimal navigation metadata; never include review drafts or evidence. */
export async function taskOverviews(db: DB, taskIds: string[], user: {id: string; role: string}) {
  if (!taskIds.length) return new Map<string, any>();
  const teacher = user.role === 'teacher';
  const rows = (await db.query(`
    WITH latest AS (
      SELECT DISTINCT ON (s.task_id,s.user_id) s.id,s.task_id,s.user_id,s.created_at
      FROM submissions s JOIN tasks t ON t.id=s.task_id JOIN classes c ON c.id=t.class_id
      WHERE s.task_id=ANY($1::uuid[]) AND s.contract_version=2 AND
        ${teacher ? 'c.teacher_id=$2' : 's.user_id=$2 AND EXISTS(SELECT 1 FROM memberships m WHERE m.class_id=c.id AND m.user_id=$2)'}
      ORDER BY s.task_id,s.user_id,s.created_at DESC,s.id DESC
    )
    SELECT s.*,u.name AS student_name,r.id AS run_id,r.status,
      EXISTS(SELECT 1 FROM report_revisions rr WHERE rr.run_id=r.id) AS has_report,
      p.id AS publication_id,p.publication_no
    FROM latest s JOIN users u ON u.id=s.user_id
    LEFT JOIN LATERAL (SELECT id,status FROM runs WHERE submission_id=s.id AND contract_version=2
      ORDER BY created_at DESC,id DESC LIMIT 1) r ON true
    LEFT JOIN LATERAL (SELECT id,publication_no FROM publications WHERE run_id=r.id
      ORDER BY publication_no DESC LIMIT 1) p ON true
    ORDER BY s.created_at DESC,s.id DESC`, [taskIds,user.id])).rows;
  const result = new Map<string, any>(taskIds.map(id => [id, teacher
    ? {submittedStudents:0,pendingReviewCount:0,pendingReviews:[]}
    : {latestSubmission:null,latestPublication:null}]));
  for (const row of rows) {
    const entry = result.get(row.task_id);
    const submission = {submissionId:row.id,submittedAt:new Date(row.created_at).toISOString(),
      runId:row.run_id ?? null,status:row.status ?? 'saved',publicationId:row.publication_id ?? null};
    if (teacher) {
      entry.submittedStudents++;
      if (row.has_report && !row.publication_id) {
        entry.pendingReviewCount++;
        if (entry.pendingReviews.length < 5) entry.pendingReviews.push({...submission,studentName:row.student_name});
      }
    } else entry.latestSubmission = submission;
  }
  if (!teacher) {
    // A newer unreviewed submission must not hide the student's older published feedback.
    const publications = (await db.query(`SELECT DISTINCT ON (s.task_id)
      s.task_id,s.id AS submission_id,p.id,p.publication_no,p.published_at
      FROM publications p JOIN runs r ON r.id=p.run_id JOIN submissions s ON s.id=r.submission_id
      JOIN tasks t ON t.id=s.task_id
      WHERE s.task_id=ANY($1::uuid[]) AND s.user_id=$2 AND r.contract_version=2
      AND EXISTS(SELECT 1 FROM memberships m WHERE m.class_id=t.class_id AND m.user_id=$2)
      ORDER BY s.task_id,p.published_at DESC,p.id DESC`,[taskIds,user.id])).rows;
    for (const row of publications) result.get(row.task_id).latestPublication = {
      publicationId:row.id,publicationNo:row.publication_no,submissionId:row.submission_id,
      publishedAt:new Date(row.published_at).toISOString(),
    };
  }
  return result;
}
