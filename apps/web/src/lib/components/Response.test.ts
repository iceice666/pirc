// @vitest-environment jsdom
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, it } from 'vitest';
import type { ConversationMessage } from '../types';
import { responseParts, responseSummary, timelineItems } from '../work';
import ResponseHarness from './ResponseHarness.svelte';

let component: { update(next: ConversationMessage[]): void } | undefined;
let target: HTMLDivElement;
afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  target?.remove();
});
const message = (id: string, extra: Partial<ConversationMessage> = {}): ConversationMessage => ({
  id,
  role: 'assistant',
  content: '',
  createdAt: '2026-10-23T00:00:00Z',
  ...extra,
});
function render(messages: ConversationMessage[]) {
  target = document.createElement('div');
  document.body.append(target);
  component = mount(ResponseHarness, { target, props: { initial: messages } });
  flushSync();
}
function click(selector: string) {
  target.querySelector<HTMLButtonElement>(selector)!.click();
  flushSync();
}
it('keeps thoughts, scripts and nested failures collapsed while answers and warnings stay visible', () => {
  render([
    message('t', {
      thinking: 'private thinking detail',
      tools: [
        {
          id: 'script',
          name: 'ptc',
          status: 'failed',
          input: { code: 'large script body' },
          operations: [
            { id: 'nested', name: 'bash', status: 'failed', output: 'long failed command output' },
          ],
        },
      ],
    }),
    message('answer', { content: 'Final answer' }),
    message('warn', {
      role: 'system',
      systemKind: 'notice',
      level: 'warning',
      content: 'Stopped after 200 turns',
    }),
  ]);
  expect(target.querySelectorAll('.activity-toggle')).toHaveLength(1);
  expect(target.textContent).toContain('1 failed');
  expect(target.textContent).toContain('Final answer');
  expect(target.textContent).toContain('Stopped after 200 turns');
  expect(target.textContent).not.toContain('private thinking detail');
  expect(target.querySelector('.tool-card')).toBeNull();
  click('.activity-toggle');
  expect(target.querySelector('.thinking-content')).toBeNull();
  expect(target.textContent).not.toContain('large script body');
  expect(target.querySelector('.tool-operations')).toBeNull();
  click('.tool-summary');
  expect(target.textContent).toContain('large script body');
  expect(target.textContent).not.toContain('long failed command output');
  click('.tool-operations .tool-summary');
  expect(target.textContent).toContain('long failed command output');
});
it('updates the latest nested operation without opening either disclosure on completion or failure', () => {
  const initial = [
    message('t', {
      tools: [
        {
          id: 'script',
          name: 'ptc',
          status: 'running',
          operations: [
            { id: 'a', name: 'read', status: 'succeeded' },
            { id: 'b', name: 'bash', status: 'running' },
          ],
        },
      ],
    }),
  ];
  render(initial);
  expect(target.textContent).toContain('Running: bash');
  click('.activity-toggle');
  expect(target.querySelector('.tool-summary')?.getAttribute('aria-expanded')).toBe('false');
  component!.update([
    message('t', {
      tools: [
        {
          id: 'script',
          name: 'ptc',
          status: 'failed',
          operations: [
            { id: 'a', name: 'read', status: 'succeeded' },
            { id: 'b', name: 'bash', status: 'failed', output: 'huge error details' },
          ],
        },
      ],
    }),
  ]);
  flushSync();
  expect(target.textContent).toContain('Completed 2 operations');
  expect(target.textContent).toContain('1 failed');
  expect(target.querySelector('.activity-toggle')?.getAttribute('aria-expanded')).toBe('true');
  expect(target.querySelector('.tool-summary')?.getAttribute('aria-expanded')).toBe('false');
  expect(target.textContent).not.toContain('huge error details');
});
it('keeps a stable turn identity as notices and final text arrive; the next user starts a new turn', () => {
  const user = message('user', { role: 'user', content: 'start' });
  const thinking = message('think', { thinking: 'detail', isPartial: true });
  expect(timelineItems([user, thinking])[1]).toMatchObject({ id: 'run:user' });
  const items = timelineItems([
    user,
    thinking,
    message('notice', { role: 'system' }),
    message('final', { content: 'Done' }),
    message('user2', { role: 'user', content: 'next' }),
    message('next'),
  ]);
  expect(items.map((i) => (i.kind === 'run' ? i.id : i.message.id))).toEqual([
    'user',
    'run:user',
    'user2',
    'run:user2',
  ]);
  expect(responseParts([message('empty', { isPartial: true })]).visible).toHaveLength(1);
  expect(responseSummary([thinking])).toMatchObject({ status: 'running', thinking: true });
  expect(
    responseSummary([message('redacted', { isPartial: true, thinkingRedacted: true })]),
  ).toMatchObject({ status: 'running', thinking: true });
});

it('keeps image-only system results reachable through their closed child row', () => {
  render([
    message('image', {
      role: 'system',
      images: [{ url: 'data:image/png;base64,AA==', mimeType: 'image/png' }],
    }),
  ]);
  expect(target.querySelector('img')).toBeNull();
  click('.activity-toggle');
  const child = target.querySelector<HTMLButtonElement>('.system-line')!;
  expect(child.disabled).toBe(false);
  expect(child.textContent).toContain('System message');
  expect(target.querySelector('img')).toBeNull();
  click('.system-line');
  expect(target.querySelector('img')).not.toBeNull();
});
