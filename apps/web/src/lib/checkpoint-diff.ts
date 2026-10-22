/** Bound private file previews before producing a diff or mounting DOM nodes. */
export const CHECKPOINT_PREVIEW_LIMIT = 16_000;

export function boundCheckpointText(text: string | null): { text: string; truncated: boolean } {
  if (text === null) return { text: '', truncated: false };
  return text.length > CHECKPOINT_PREVIEW_LIMIT
    ? { text: text.slice(0, CHECKPOINT_PREVIEW_LIMIT), truncated: true }
    : { text, truncated: false };
}

interface Row {
  kind: 'ctx' | 'add' | 'del';
  text: string;
}

function lines(text: string): string[] {
  if (!text) return [];
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const result = normalized.split('\n');
  if (result[result.length - 1] === '') result.pop();
  return result;
}

function lcsRows(before: string[], after: string[]): Row[] {
  const width = after.length + 1;
  const table = new Uint16Array((before.length + 1) * width);
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      const at = i * width + j;
      table[at] =
        before[i] === after[j]
          ? table[(i + 1) * width + j + 1]! + 1
          : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
  }
  const rows: Row[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) {
      rows.push({ kind: 'ctx', text: before[i]! });
      i++;
      j++;
    } else if (
      i < before.length &&
      (j === after.length || table[(i + 1) * width + j]! >= table[i * width + j + 1]!)
    ) {
      rows.push({ kind: 'del', text: before[i++]! });
    } else {
      rows.push({ kind: 'add', text: after[j++]! });
    }
  }
  return rows;
}

/**
 * Build a small unified diff for the existing DiffView component. Small files
 * use an LCS; larger previews use one changed block with matching edge context.
 */
export function checkpointDiff(beforeText: string | null, afterText: string | null, path: string) {
  const before = lines(boundCheckpointText(beforeText).text);
  const after = lines(boundCheckpointText(afterText).text);
  if (before.length === after.length && before.every((line, index) => line === after[index]))
    return '';

  let rows: Row[];
  if (before.length * after.length <= 65_000) rows = lcsRows(before, after);
  else {
    let prefix = 0;
    while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix])
      prefix++;
    let suffix = 0;
    while (
      suffix < before.length - prefix &&
      suffix < after.length - prefix &&
      before[before.length - suffix - 1] === after[after.length - suffix - 1]
    )
      suffix++;
    rows = [
      ...before.slice(0, prefix).map((text) => ({ kind: 'ctx' as const, text })),
      ...before
        .slice(prefix, before.length - suffix)
        .map((text) => ({ kind: 'del' as const, text })),
      ...after.slice(prefix, after.length - suffix).map((text) => ({ kind: 'add' as const, text })),
      ...before.slice(before.length - suffix).map((text) => ({ kind: 'ctx' as const, text })),
    ];
  }

  const changed = rows.flatMap((row, index) => (row.kind === 'ctx' ? [] : [index]));
  if (!changed.length) return '';
  const groups: Array<{ start: number; end: number }> = [];
  for (const index of changed) {
    const start = Math.max(0, index - 3);
    const end = Math.min(rows.length, index + 4);
    const previous = groups[groups.length - 1];
    if (previous && start <= previous.end) previous.end = end;
    else groups.push({ start, end });
  }

  const output = [`diff --git a/${path} b/${path}`];
  for (const group of groups) {
    const visible = rows.slice(group.start, group.end);
    const oldBefore = rows.slice(0, group.start).filter((row) => row.kind !== 'add').length;
    const newBefore = rows.slice(0, group.start).filter((row) => row.kind !== 'del').length;
    const oldCount = visible.filter((row) => row.kind !== 'add').length;
    const newCount = visible.filter((row) => row.kind !== 'del').length;
    const oldStart = oldBefore + (oldCount ? 1 : 0);
    const newStart = newBefore + (newCount ? 1 : 0);
    output.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const row of visible)
      output.push(`${row.kind === 'ctx' ? ' ' : row.kind === 'add' ? '+' : '-'}${row.text}`);
  }
  return output.join('\n');
}
