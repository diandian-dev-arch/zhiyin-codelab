import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { testDB } from './db';
import { migrate, type DB } from '../apps/api/src/db';
import { createApp } from '../apps/api/src/app';
import { hashPassword, verifyPassword } from '../apps/api/src/auth';
import { initializeTeacherTrial } from '../scripts/teacher-trial-fixtures';

const accounts = {
  teacher: { email: 'trial-teacher@example.invalid', password: 'Isolated-trial-teacher-3901!' },
  student: { email: 'trial-student@example.invalid', password: 'Isolated-trial-student-4902!' },
};
const origin = 'http://trial-setup.invalid';
let db: DB;
beforeEach(async () => {
  db = await testDB();
  await migrate(db);
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('External networking is forbidden in teacher trial fixtures'));
});
afterEach(async () => { await db.close(); vi.restoreAllMocks(); });

async function trialApp() {
  return createApp(db, { origin, secure: false, businessVersion: 2, executionApproved: false, model: 'disabled', image: 'disabled', packs: [], coursework: { background: false }, teacherTrial: true, sessionCookieName: 'codelab_teacher_trial_sid' });
}
async function login(app: Awaited<ReturnType<typeof trialApp>>, account = accounts.teacher) {
  const result = await app.inject({ method: 'POST', url: '/api/v1/session/login', headers: { origin }, payload: account });
  expect(result.statusCode).toBe(200);
  const cookie = result.cookies.find(item => item.name === 'codelab_teacher_trial_sid');
  expect(cookie).toBeDefined();
  return { origin, cookie: `${cookie!.name}=${cookie!.value}`, 'x-csrf-token': result.json().csrf as string };
}

describe('independent teacher-trial initialization', () => {
  it('creates real published coursework, a fixed synthetic source snapshot and student receipt without any AI or execution artifacts', async () => {
    const ids = await initializeTeacherTrial(db, accounts);
    expect(Object.values(ids).every(id => /^[a-f0-9-]{36}$/.test(id))).toBe(true);
    const users = (await db.query('SELECT email,name,role,password_hash FROM users ORDER BY role')).rows;
    expect(users).toHaveLength(2);
    expect(users.find(user => user.role === 'teacher')?.email).toBe(accounts.teacher.email);
    expect(verifyPassword(accounts.teacher.password, users.find(user => user.role === 'teacher').password_hash)).toBe(true);
    for (const table of ['user_model_settings', 'course_repository_connections', 'course_git_identities', 'runs', 'execution_attempts', 'source_analyses', 'source_model_calls', 'course_analyses', 'course_self_checks', 'course_model_consents', 'reports', 'publications', 'course_evaluations', 'sessions']) {
      expect((await db.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count, table).toBe(0);
    }
    const stored = (await db.query('SELECT s.*,snapshot.files,snapshot.content_hash FROM course_submissions s JOIN course_snapshots snapshot ON snapshot.id=s.snapshot_id WHERE s.id=$1', [ids.submissionId])).rows[0];
    expect(stored.task_id).toBe(ids.taskId);
    expect(stored.sequence).toBe(1);
    expect(stored.note).toContain('非敏感合成样例');
    expect(stored.content_hash).toBeTruthy();
    expect(Object.keys(stored.files).sort()).toEqual(['README.md', 'src/search.ts']);
    expect(stored.files['src/search.ts']).toContain('!item.includes(query)');
    const guide = await readFile(new URL('../docs/TEACHER_TRIAL_GUIDE.md', import.meta.url), 'utf8');
    for (const content of Object.values(stored.files) as string[]) expect(guide).toContain(content.trim());
    expect(guide).not.toContain(accounts.teacher.password);
    expect(guide).not.toContain(accounts.student.password);
    const app = await trialApp();
    try {
      const teacher = await login(app);
      const student = await login(app, accounts.student);
      const assignment = await app.inject({ url: `/api/v2/assignments/${ids.assignmentId}`, headers: teacher });
      expect(assignment.statusCode).toBe(200);
      expect(assignment.json().assignment.status).toBe('published');
      expect(assignment.json().tasks).toHaveLength(1);
      const receipt = await app.inject({ url: `/api/v2/course-submissions/${ids.submissionId}`, headers: student });
      expect(receipt.statusCode).toBe(200);
      expect(receipt.json().snapshot.files).toBeUndefined();
      const source = await app.inject({ url: `/api/v2/course-submissions/${ids.submissionId}/source?path=src%2Fsearch.ts`, headers: student });
      expect(source.statusCode).toBe(200);
      expect(source.json().content).toBe(stored.files['src/search.ts']);
    } finally { await app.close(); }
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('reuses the marker without resetting credentials, deleting or recreating the teacher manual publication', async () => {
    const ids = await initializeTeacherTrial(db, accounts);
    const original = (await db.query('SELECT id,password_hash FROM users ORDER BY id')).rows;
    const app = await trialApp();
    let evaluationId = '';
    try {
      const teacher = await login(app);
      const draft = await app.inject({ method: 'POST', url: `/api/v2/course-submissions/${ids.submissionId}/evaluations`, headers: teacher, payload: { feedback: '人工试用反馈：实际匹配条件与任务目标相反，建议核对空查询和大小写边界。', outcome: 'needs_revision', analysisId: null } });
      expect(draft.statusCode).toBe(201);
      evaluationId = draft.json().id;
      const published = await app.inject({ method: 'POST', url: `/api/v2/course-evaluations/${evaluationId}/publish`, headers: teacher });
      expect(published.statusCode).toBe(200);
    } finally { await app.close(); }
    const repeated = await initializeTeacherTrial(db, { teacher: { ...accounts.teacher, password: 'Ignored-repeat-password-3301!' }, student: { ...accounts.student, password: 'Ignored-repeat-password-3302!' } });
    expect(repeated).toEqual(ids);
    expect((await db.query('SELECT id,password_hash FROM users ORDER BY id')).rows).toEqual(original);
    expect((await db.query('SELECT status,feedback FROM course_evaluations WHERE id=$1', [evaluationId])).rows[0]).toMatchObject({ status: 'published', feedback: expect.stringContaining('人工试用反馈') });
    for (const table of ['course_assignments', 'course_tasks', 'course_imports', 'course_snapshots', 'course_submissions']) expect((await db.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count).toBe(1);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('refuses an unmarked non-empty business database without adding a marker or changing the existing account', async () => {
    const id = randomUUID(), hash = hashPassword('Unrelated-local-test-password-0021!');
    await db.query('INSERT INTO users(id,email,name,role,password_hash) VALUES($1,$2,$3,$4,$5)', [id, 'existing@example.invalid', 'existing synthetic account', 'teacher', hash]);
    await expect(initializeTeacherTrial(db, accounts)).rejects.toThrow('TEACHER_TRIAL_DATABASE_NOT_EMPTY');
    expect((await db.query('SELECT id,password_hash FROM users')).rows).toEqual([{ id, password_hash: hash }]);
    expect((await db.query("SELECT to_regclass('teacher_trial_setup') AS name")).rows[0].name).toBeNull();
    expect((await db.query('SELECT count(*)::int AS count FROM classes')).rows[0].count).toBe(0);
  });

  it('refuses a missing tracked sample instead of silently seeding a replacement', async () => {
    const ids = await initializeTeacherTrial(db, accounts);
    await db.query('UPDATE teacher_trial_setup SET submission_id=$1', [randomUUID()]);
    await expect(initializeTeacherTrial(db, accounts)).rejects.toThrow('TEACHER_TRIAL_SEED_MISSING');
    expect((await db.query('SELECT id FROM course_submissions')).rows).toEqual([{ id: ids.submissionId }]);
    expect((await db.query('SELECT count(*)::int AS count FROM users')).rows[0].count).toBe(2);
  });

  it('rolls back accounts, metadata and real coursework together if a later business step fails', async () => {
    const fault = (target: DB): DB => ({
      ...target,
      query: async (sql, params) => {
        if (sql.startsWith('INSERT INTO course_imports')) throw new Error('deterministic local setup failure');
        return target.query(sql, params);
      },
      transaction: fn => target.transaction(tx => fn(fault(tx))),
    });
    await expect(initializeTeacherTrial(fault(db), accounts)).rejects.toThrow('TEACHER_TRIAL_SETUP_STEP_FAILED');
    for (const table of ['users', 'classes', 'course_assignments', 'course_tasks', 'course_imports', 'course_snapshots', 'course_submissions', 'sessions']) expect((await db.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count, table).toBe(0);
    expect((await db.query("SELECT to_regclass('teacher_trial_setup') AS name")).rows[0].name).toBeNull();
  });
});
