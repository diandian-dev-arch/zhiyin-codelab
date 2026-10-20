import { randomUUID } from 'node:crypto';
import { hashPassword } from '../apps/api/src/auth.js';
import { createApp } from '../apps/api/src/app.js';
import type { DB } from '../apps/api/src/db.js';

type TrialAccounts = { teacher: { email: string; password: string }; student: { email: string; password: string } };
type TrialIds = { classId: string; assignmentId: string; taskId: string; submissionId: string };
const origin = 'http://trial-setup.invalid';
const purpose = 'codelab-teacher-trial-v1';
const sampleCode = `// Synthetic, non-sensitive sample. Contains deliberate search defects.
export function searchItems(items: readonly string[], query: string): string[] {
  return items.filter(item => !item.includes(query));
}
`;
const sampleReadme = `# Non-sensitive synthetic teacher-trial sample

This is a deliberately defective search function, not a real student's work.
Goal: match titles case-insensitively after trimming the query; an empty query returns all items.
Example: searchItems(['Vue Basics', 'TypeScript'], ' vue ') should return ['Vue Basics'].
The supplied function does not meet this goal. The teacher may inspect it and publish manual feedback.
No project execution, model call, AI report or real teacher outcome is included.
`;

function accountEmails(accounts: TrialAccounts) {
  const emails = [accounts.teacher.email.trim().toLowerCase(), accounts.student.email.trim().toLowerCase()];
  if (emails[0] === emails[1] || emails.some(email => email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))
    throw new Error('TEACHER_TRIAL_ACCOUNTS_INVALID: 请使用两个不同的有效试用账号。');
  return emails;
}

async function verifyExisting(db: DB, row: any, emails: string[]): Promise<TrialIds> {
  if (row.purpose !== purpose || row.version !== 1) throw new Error('TEACHER_TRIAL_MARKER_INVALID: 试用库标记不匹配，未修改数据。');
  const found = (await db.query(`SELECT c.id,snapshot.files FROM classes c
    JOIN users teacher ON teacher.id=c.teacher_id AND teacher.role='teacher'
    JOIN memberships m ON m.class_id=c.id AND m.user_id=$2
    JOIN users student ON student.id=m.user_id AND student.role='student'
    JOIN course_assignments a ON a.class_id=c.id AND a.id=$4
    JOIN course_tasks t ON t.assignment_id=a.id AND t.task_id=$5
    JOIN course_task_revisions revision ON revision.id=t.current_revision_id AND revision.task_id=t.task_id
    JOIN course_submissions s ON s.task_id=t.task_id AND s.id=$6 AND s.submitted_by=student.id
    JOIN course_subjects subject ON subject.id=s.subject_id AND subject.assignment_id=a.id AND subject.user_id=student.id
    JOIN course_snapshots snapshot ON snapshot.id=s.snapshot_id AND snapshot.owner_id=student.id
    JOIN course_imports imported ON imported.id=snapshot.import_id AND imported.snapshot_id=snapshot.id AND imported.task_id=t.task_id AND imported.status='ready'
    WHERE c.id=$3 AND teacher.id=$1 AND teacher.email=$7 AND student.email=$8`,
  [row.teacher_id, row.student_id, row.class_id, row.assignment_id, row.task_id, row.submission_id, ...emails])).rows;
  if (found.length !== 1 || found[0].files?.['src/search.ts'] !== sampleCode || found[0].files?.['README.md'] !== sampleReadme)
    throw new Error('TEACHER_TRIAL_SEED_MISSING: 原试用账号或样例关系已缺失/改变；未重置密码，也未补造任何成果。请人工核对试用库。');
  return { classId: row.class_id, assignmentId: row.assignment_id, taskId: row.task_id, submissionId: row.submission_id };
}

export async function initializeTeacherTrial(db: DB, accounts: TrialAccounts): Promise<TrialIds> {
  const emails = accountEmails(accounts);
  return db.transaction(async tx => {
    await tx.query('SELECT pg_advisory_xact_lock(41728)');
    const markerExists = (await tx.query("SELECT to_regclass('teacher_trial_setup') AS name")).rows[0]?.name;
    if (markerExists) {
      const markers = (await tx.query('SELECT * FROM teacher_trial_setup')).rows;
      if (markers.length !== 1) throw new Error('TEACHER_TRIAL_MARKER_INVALID: 试用库标记缺失或不唯一，未修改数据。');
      return verifyExisting(tx, markers[0], emails);
    }
    const tables = (await tx.query("SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_type='BASE TABLE' AND table_name<>'schema_migrations'")).rows;
    for (const { table_name: table } of tables) {
      const quoted = `"${String(table).replaceAll('"', '""')}"`;
      if ((await tx.query(`SELECT 1 FROM ${quoted} LIMIT 1`)).rows.length)
        throw new Error('TEACHER_TRIAL_DATABASE_NOT_EMPTY: 拒绝把未标记的非空业务库当作试用库；未修改已有记录。');
    }
    for (const account of [accounts.teacher, accounts.student]) {
      if (account.password.length < 12 || account.password.length > 200)
        throw new Error('TEACHER_TRIAL_PASSWORD_INVALID: 新试用账号密码须为12至200位。');
    }
    await tx.exec(`CREATE TABLE teacher_trial_setup (
      singleton boolean PRIMARY KEY CHECK(singleton), purpose text NOT NULL, version integer NOT NULL,
      teacher_id uuid NOT NULL, student_id uuid NOT NULL, class_id uuid NOT NULL,
      assignment_id uuid NOT NULL, task_id uuid NOT NULL, submission_id uuid NOT NULL
    )`);
    const teacherId = randomUUID(), studentId = randomUUID(), classId = randomUUID();
    for (const [id, email, name, role, password] of [
      [teacherId, emails[0], '试用教师', 'teacher', accounts.teacher.password],
      [studentId, emails[1], '合成样例学生', 'student', accounts.student.password],
    ]) await tx.query('INSERT INTO users(id,email,name,role,password_hash) VALUES($1,$2,$3,$4,$5)', [id, email, name, role, hashPassword(password)]);
    await tx.query('INSERT INTO classes(id,name,teacher_id) VALUES($1,$2,$3)', [classId, '教师试用 · 非敏感合成样例班', teacherId]);
    await tx.query('INSERT INTO memberships(class_id,user_id) VALUES($1,$2)', [classId, studentId]);

    const app = await createApp(tx, {
      origin, secure: false, businessVersion: 2, executionApproved: false, model: 'disabled', image: 'disabled', packs: [],
      coursework: { background: false }, teacherTrial: true, sessionCookieName: 'codelab_teacher_trial_sid',
    });
    try {
      async function login(account: TrialAccounts['teacher'], email: string) {
        const response = await app.inject({ method: 'POST', url: '/api/v1/session/login', headers: { origin }, payload: { email, password: account.password } });
        if (response.statusCode !== 200) throw new Error('TEACHER_TRIAL_LOGIN_FAILED: 试用初始化认证失败。');
        const cookie = response.cookies.find(item => item.name === 'codelab_teacher_trial_sid');
        if (!cookie) throw new Error('TEACHER_TRIAL_COOKIE_INVALID: 未取得独立的试用会话。');
        return { origin, cookie: `${cookie.name}=${cookie.value}`, 'x-csrf-token': response.json().csrf as string };
      }
      const teacherHeaders = await login(accounts.teacher, emails[0]);
      const studentHeaders = await login(accounts.student, emails[1]);
      async function request(method: 'GET' | 'POST', path: string, headers: Record<string, string>, payload?: object) {
        const response = await app.inject({ method, url: `/api/v2${path}`, headers, ...(payload ? { payload } : {}) });
        if (response.statusCode < 200 || response.statusCode >= 300)
          throw new Error(`TEACHER_TRIAL_SETUP_STEP_FAILED: 样例业务步骤未成功（HTTP ${response.statusCode}），初始化事务将回滚。`);
        return response.json();
      }
      const assignment = await request('POST', '/assignments', teacherHeaders, {
        classId, title: '[非敏感合成样例] 搜索函数人工评阅', subjectMode: 'individual', status: 'published',
        tasks: [{ title: '[有意缺陷样例] 搜索函数', description: '这是非敏感合成代码，不是真实学生作业。目标：忽略查询首尾空格和大小写，返回包含查询词的标题；空查询返回全部。请人工阅读源码并给出有依据的建议。',
          requirements: [{ id: 'R1', title: '查询词去除首尾空格后，按大小写不敏感的包含关系匹配' }, { id: 'R2', title: '空查询返回全部条目，不修改原数组' }],
          allowCode: false, allowedSources: ['snippet', 'files', 'zip'], requiredPaths: ['src/search.ts'], starter: sampleCode }],
      });
      const detail = await request('GET', `/assignments/${assignment.id}`, teacherHeaders);
      const taskId = detail.tasks[0]?.task_id;
      const task = await request('GET', `/course-tasks/${taskId}`, studentHeaders);
      const imported = await request('POST', '/imports', studentHeaders, {
        taskId, type: 'files', files: [{ path: 'README.md', content: sampleReadme }, { path: 'src/search.ts', content: sampleCode }],
      });
      const submitted = await request('POST', `/course-tasks/${taskId}/submissions`, { ...studentHeaders, 'idempotency-key': randomUUID() }, {
        subjectId: task.subjects.find((subject: any) => subject.user_id === studentId)?.id,
        snapshotId: imported.snapshot_id, taskRevisionId: task.task.current_revision_id,
        note: '非敏感合成样例；有意保留搜索缺陷，供教师练习人工点评。未运行测试、未调用模型、未生成报告。',
      });
      const result = { classId, assignmentId: assignment.id as string, taskId: taskId as string, submissionId: submitted.submission.id as string };
      for (const headers of [teacherHeaders, studentHeaders]) {
        const logout = await app.inject({ method: 'POST', url: '/api/v1/session/logout', headers });
        if (logout.statusCode !== 200) throw new Error('TEACHER_TRIAL_LOGOUT_FAILED: 试用初始化会话未正常关闭。');
      }
      await tx.query('INSERT INTO teacher_trial_setup VALUES(true,$1,1,$2,$3,$4,$5,$6,$7)', [purpose, teacherId, studentId, classId, result.assignmentId, result.taskId, result.submissionId]);
      return result;
    } finally { await app.close(); }
  });
}
