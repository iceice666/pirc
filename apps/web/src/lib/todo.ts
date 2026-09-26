/**
 * The agent's todo list reaches the browser as a plain-text widget (key
 * `local-todo`): a `TODO · done/total` header, then one line per task,
 * `<mark> [category] label (blocked)`, with ✓ / ▶ / ☐ for completed /
 * in progress / pending. This turns those lines back into rows for the dock.
 */
export const TODO_WIDGET = 'local-todo';

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
  status: TodoStatus;
  text: string;
  category?: string;
  blocked: boolean;
}

export interface TodoList {
  items: TodoItem[];
  done: number;
  total: number;
}

const MARKS: Record<string, TodoStatus> = { '✓': 'completed', '▶': 'in_progress', '☐': 'pending' };

export function parseTodoWidget(lines: string[] | undefined): TodoList | undefined {
  if (!lines?.length) return undefined;
  const header = /^TODO · (\d+)\/(\d+)$/.exec(lines[0] ?? '');
  const items: TodoItem[] = [];
  for (const line of lines.slice(header ? 1 : 0)) {
    const status = MARKS[line.charAt(0)];
    // Older runners appended "… N more"; anything unmarked is not a task.
    if (!status) continue;
    let text = line.slice(1).trim();
    let category: string | undefined;
    const tagged = /^\[([^\]]*)\] (.*)$/.exec(text);
    if (tagged) {
      category = tagged[1];
      text = tagged[2] ?? '';
    }
    const blocked = text.endsWith(' (blocked)');
    if (blocked) text = text.slice(0, -' (blocked)'.length);
    items.push({ status, text, blocked, ...(category ? { category } : {}) });
  }
  const done = header
    ? Number(header[1])
    : items.filter((item) => item.status === 'completed').length;
  const total = header ? Number(header[2]) : items.length;
  return total ? { items, done, total } : undefined;
}
