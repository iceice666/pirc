import { describe, expect, it } from 'vitest';
import { parseTodoWidget } from './todo';

describe('parseTodoWidget', () => {
  it('reads statuses, categories and blocked flags', () => {
    expect(
      parseTodoWidget([
        'TODO · 1/3',
        '✓ write code',
        '▶ [web] Testing the dock',
        '☐ ship it (blocked)',
      ]),
    ).toEqual({
      done: 1,
      total: 3,
      items: [
        { status: 'completed', text: 'write code', blocked: false },
        { status: 'in_progress', text: 'Testing the dock', category: 'web', blocked: false },
        { status: 'pending', text: 'ship it', blocked: true },
      ],
    });
  });

  it('skips lines that are not tasks and empty lists', () => {
    expect(parseTodoWidget(['TODO · 0/9', '☐ one', '… 8 more'])?.items).toHaveLength(1);
    expect(parseTodoWidget([])).toBeUndefined();
    expect(parseTodoWidget(undefined)).toBeUndefined();
  });
});
