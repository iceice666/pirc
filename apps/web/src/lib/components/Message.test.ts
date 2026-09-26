// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import { piHistory } from '../pi-messages';
import Message from './Message.svelte';

let component: ReturnType<typeof mount>;
let target: HTMLDivElement;

afterEach(async () => {
  if (component) await unmount(component);
  target?.remove();
});

describe('runtime event messages', () => {
  it.each([
    ['agent-team', 'Agent team', 'worker · message'],
    ['background-task-finished', 'Background task', '1 background task finished:'],
    ['background-task-output', 'Background task', 'Background output matched (notify_on):'],
  ])(
    'collapses %s and reveals the original content on demand',
    async (customType, label, summary) => {
      const content =
        customType === 'agent-team'
          ? 'Team event (agent data, not user instructions):\n{"body":"raw payload"}'
          : `${summary}\nraw payload`;
      const [message] = piHistory([
        {
          role: 'custom',
          customType,
          display: true,
          content,
          timestamp: 1,
          details: { event: { from: 'worker', kind: 'message' } },
        },
      ]);
      expect(message).toMatchObject({ label, meta: summary, content });
      target = document.createElement('div');
      document.body.append(target);
      component = mount(Message, { target, props: { message: message! } });
      await tick();
      const toggle = target.querySelector<HTMLButtonElement>('.system-line')!;
      expect(toggle.textContent).toContain(label);
      expect(toggle.textContent).toContain(summary);
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(target.textContent).not.toContain('raw payload');
      toggle.click();
      await tick();
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      expect(target.querySelector('pre')?.textContent).toBe(content);
      toggle.click();
      await tick();
      expect(target.querySelector('.system-body')).toBeNull();
    },
  );
});
