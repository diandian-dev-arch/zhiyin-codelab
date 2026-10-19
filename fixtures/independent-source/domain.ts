export type Task = { id: string; title: string; done: boolean };
export type Action = { type: 'add'; title: string } | { type: 'toggle'; id: string } | { type: 'remove'; id: string };
export function transition(tasks: Task[], action: Action): Task[] {
  if (action.type === 'add') return action.title.trim()
    ? [...tasks, { id: crypto.randomUUID(), title: action.title.trim(), done: false }] : tasks;
  if (action.type === 'remove') return tasks.filter(task => task.id !== action.id);
  return tasks.map(task => task.id === action.id ? { ...task, done: !task.done } : task);
}
export function visible(tasks: Task[], mode: string) {
  if (mode === 'active') return tasks.filter(task => !task.done);
  if (mode === 'done') return tasks.filter(task => task.done);
  return tasks;
}
