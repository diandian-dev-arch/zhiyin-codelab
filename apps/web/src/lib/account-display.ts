/** Keep real names intact while removing development labels from account UI. */
export function accountDisplayName(name: string | null | undefined): string {
  if (name === '示例学生') return '学生';
  if (name === '示例教师') return '教师';
  return name ?? '';
}
