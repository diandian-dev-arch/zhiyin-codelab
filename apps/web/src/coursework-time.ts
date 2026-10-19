/** datetime-local controls represent the course's Beijing time, not the browser's zone. */
export function courseDeadline(value: string): string | null {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value))
    throw new Error("请输入有效的北京时间");
  const date = new Date(`${value}+08:00`);
  if (!Number.isFinite(date.getTime())) throw new Error("请输入有效的北京时间");
  return date.toISOString();
}

export const courseTime = (value: string | null) =>
  value
    ? new Date(value).toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai",
        hour12: false,
      })
    : "不设截止";
