import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { parseTeacherTrialSecrets, teacherTrialEnvironment } from '../scripts/teacher-trial-config';

const valid = () => ({ version: 1, environmentId: randomUUID(), databasePassword: 'a'.repeat(64), controlToken: 'b'.repeat(64),
  teacher: { email: 'teacher@trial.codelab.local', password: 'synthetic-teacher-password-only' },
  student: { email: 'student@trial.codelab.local', password: 'synthetic-student-password-only' } });

it('validates existing trial-only credentials without accepting unrelated account or database configuration', () => {
  const value = valid();
  expect(parseTeacherTrialSecrets(value)).toBe(value);
  for (const invalid of [null, [], {}, { ...value, version: 2 }, { ...value, environmentId: '../business-v2' },
    { ...value, databasePassword: '' }, { ...value, controlToken: 'short' }, { ...value, databaseUrl: 'not-allowed' },
    { ...value, teacher: { ...value.teacher, email: 'teacher@codelab.local' } }, { ...value, student: { ...value.student, password: 'short' } },
    { ...value, teacher: { ...value.teacher, apiKey: 'never-inherit' } }]) {
    expect(() => parseTeacherTrialSecrets(invalid)).toThrow('TEACHER_TRIAL_CREDENTIALS_INVALID');
  }
});

it('passes only operating-system environment to trial children, not model, database, proxy or Node preload configuration', () => {
  const environment = { Path: 'runtime-only', SystemRoot: 'system', APPDATA: 'user-config', TMP: 'temporary',
    MODEL_API_KEY: 'synthetic-never-pass', OPENAI_API_KEY: 'synthetic-never-pass', DATABASE_URL: 'synthetic-never-pass',
    RUNNER_TOKEN: 'synthetic-never-pass', NODE_OPTIONS: '--import=not-allowed', HTTP_PROXY: 'not-allowed',
    VITE_SECRET: 'not-allowed', CODELAB_V2_RUNTIME_FILE: 'not-allowed', DOCKER_HOST: 'tcp://remote.invalid' };
  expect(teacherTrialEnvironment(environment)).toEqual({ Path: 'runtime-only', SystemRoot: 'system', APPDATA: 'user-config', TMP: 'temporary' });
  expect(environment.NODE_OPTIONS).toBe('--import=not-allowed');
});
