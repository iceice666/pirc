// @vitest-environment jsdom
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { snapshotFromRaw } from '../api';
import { app } from '../app.svelte';
import { MAX_HIGHLIGHT } from '../markdown';
import { fromSnapshot } from '../state';
import type { ToolCall } from '../types';
import ToolCard from './ToolCard.svelte';

let component: ReturnType<typeof mount> | undefined;
let target: HTMLDivElement;

afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  target?.remove();
  app.sessionState = undefined;
});

function render(tool: ToolCall) {
  target = document.createElement('div');
  document.body.append(target);
  component = mount(ToolCard, { target, props: { tool } });
  flushSync();
  const summary = target.querySelector<HTMLButtonElement>('.tool-summary')!;
  return {
    summary,
    toggle() {
      summary.click();
      flushSync();
    },
  };
}

describe('ToolCard', () => {
  it('summarises the call and renders details only when expanded', () => {
    const { summary, toggle } = render({
      id: 't1',
      name: 'edit',
      status: 'succeeded',
      input: { path: 'src/app.ts' },
      diff: '-old line\n+new line',
    });
    expect(summary.textContent).toContain('src/app.ts');
    expect(summary.getAttribute('aria-expanded')).toBe('false');
    expect(target.querySelector('.tool-diff')).toBeNull();
    toggle();
    expect(summary.getAttribute('aria-expanded')).toBe('true');
    expect(target.querySelector('.tool-diff')?.textContent).toContain('+new line');
    toggle();
    expect(target.querySelector('.tool-diff')).toBeNull();
  });

  it('opens a failed call by default so the error is visible', () => {
    const { summary } = render({
      id: 't2',
      name: 'bash',
      status: 'failed',
      input: { command: 'false' },
      output: 'exit code 1',
    });
    expect(summary.getAttribute('aria-expanded')).toBe('true');
    expect(target.textContent).toContain('exit code 1');
  });

  it('clips a very large output instead of highlighting it all', () => {
    const { toggle } = render({
      id: 't3',
      name: 'read',
      status: 'succeeded',
      input: { path: 'big.ts' },
      output: 'x'.repeat(MAX_HIGHLIGHT + 1234),
    });
    toggle();
    const text = target.textContent ?? '';
    expect(text).toContain('1,234 more characters not shown');
    expect(text.length).toBeLessThan(MAX_HIGHLIGHT + 1000);
  });

  it('shows a ptc script as the operations it ran, each expandable, and its script on demand', () => {
    const { summary, toggle } = render({
      id: 'p1',
      name: 'ptc',
      status: 'succeeded',
      input: { code: 'await tools.read({ path: "a.ts" }); return 1;' },
      output: '1',
      operations: [
        { id: 'p1:op1', name: 'read', status: 'succeeded', input: { path: 'a.ts' }, output: 'x' },
        { id: 'p1:op2', name: 'read', status: 'succeeded', input: { path: 'b.ts' }, output: 'y' },
        {
          id: 'p1:op3',
          name: 'edit',
          status: 'failed',
          input: { path: 'a.ts' },
          output: 'oldText not found',
        },
      ],
    });
    // A summary of what it did, not its source.
    expect(summary.textContent).toContain('Script');
    expect(summary.textContent).toContain('read ×2, edit');
    expect(summary.textContent).not.toContain('tools.read');
    const operations = [...target.querySelectorAll('.tool-operations .tool-card')];
    expect(operations.map((card) => card.getAttribute('data-tool'))).toEqual([
      'read',
      'read',
      'edit',
    ]);
    // The failed operation opens by itself; the script does not.
    expect(target.textContent).toContain('oldText not found');
    expect(target.querySelector('.tool-content pre code')?.textContent ?? '').not.toContain(
      'tools.read',
    );
    toggle();
    expect(target.textContent).toContain('Script');
    expect(target.textContent).toContain('tools.read({ path: "a.ts" })');
    expect(target.textContent).toContain('Result');
  });

  it('marks the operation a pending question or approval belongs to', () => {
    const fixture = JSON.parse(
      readFileSync(
        path.resolve(__dirname, '../../../../../fixtures/timeline/ptc-operations.json'),
        'utf8',
      ),
    );
    app.sessionState = fromSnapshot(snapshotFromRaw(fixture.snapshot, null));
    const script = app.sessionState.messages.find((message) => message.tools?.length)!.tools![0]!;
    render(script);
    const cards = [...target.querySelectorAll('.tool-operations .tool-card')];
    expect(cards.map((card) => card.getAttribute('data-tool'))).toEqual(['read', 'edit']);
    expect(cards[0]!.querySelector('.tool-waiting')).toBeNull();
    expect(cards[1]!.querySelector('.tool-waiting')?.textContent).toContain('Waiting for approval');
  });
});
