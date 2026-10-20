import assert from 'node:assert/strict';

export type TrialSecrets = { version: 1; environmentId: string; databasePassword: string; controlToken: string;
  teacher: { email: string; password: string }; student: { email: string; password: string } };

export function parseTeacherTrialSecrets(value: unknown): TrialSecrets {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'TEACHER_TRIAL_CREDENTIALS_INVALID');
  const v = value as TrialSecrets;
  assert(Object.keys(v).sort().join(',') === 'controlToken,databasePassword,environmentId,student,teacher,version' && v.version === 1 &&
    typeof v.environmentId === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v.environmentId) &&
    typeof v.databasePassword === 'string' && /^[a-f0-9]{64}$/.test(v.databasePassword) &&
    typeof v.controlToken === 'string' && /^[a-f0-9]{64}$/.test(v.controlToken), 'TEACHER_TRIAL_CREDENTIALS_INVALID');
  for (const [role, email] of [['teacher', 'teacher@trial.codelab.local'], ['student', 'student@trial.codelab.local']] as const) {
    const account = v[role];
    assert(account && Object.keys(account).sort().join(',') === 'email,password' && account.email === email &&
      typeof account.password === 'string' && account.password.length >= 24 && account.password.length <= 128,
    'TEACHER_TRIAL_CREDENTIALS_INVALID');
  }
  return v;
}

export function teacherTrialEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const operatingNames = new Set(['path','pathext','systemroot','windir','temp','tmp','userprofile','appdata','localappdata','comspec','os','processor_architecture','programfiles','programfiles(x86)','commonprogramfiles','systemdrive','homedrive','homepath']);
  return Object.fromEntries(Object.entries(environment).filter(([name]) => operatingNames.has(name.toLowerCase())));
}
