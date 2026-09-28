// @vitest-environment jsdom
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_HIGHLIGHT } from '../markdown';
import type { ToolCall } from '../types';
import ToolCard from './ToolCard.svelte';

let component: ReturnType<typeof mount> | undefined;
let target: HTMLDivElement;

afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  target?.remove();
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
});
