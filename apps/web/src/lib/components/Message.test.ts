// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import { piHistory } from '../pi-messages';
import Message from './Message.svelte';

let component: ReturnType<typeof mount>;
let target: HTMLDivElement;

afterEach(async () => {
  if (component) await unmount(component);
  target?.remove();
});

describe('user message versions', () => {
  const message = {
    id: 'user:1',
    entryId: 'entry-2',
    role: 'user' as const,
    content: 'Second version',
    createdAt: new Date(1).toISOString(),
    branches: [
      { entryId: 'entry-1', text: 'First version', selected: false },
      { entryId: 'entry-2', text: 'Second version', selected: true },
    ],
  };
  const button = (label: string) =>
    target.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  async function render(
    branchDisabled = false,
    onedit = vi.fn(async () => true),
    onswitch = vi.fn(async () => true),
  ) {
    target = document.createElement('div');
    document.body.append(target);
    component = mount(Message, { target, props: { message, branchDisabled, onedit, onswitch } });
    await tick();
    return { onedit, onswitch };
  }
  it('navigates saved sibling versions by entry ID', async () => {
    const { onswitch } = await render();
    expect(target.textContent).toContain('2 / 2');
    expect(button('Next version').disabled).toBe(true);
    button('Previous version').click();
    expect(onswitch).toHaveBeenCalledWith('entry-1');
  });
  it('keeps the edit draft after rejection, supports retry and cancel', async () => {
    const onedit = vi.fn(async () => false);
    await render(false, onedit);
    button('Edit message').click();
    await tick();
    const textarea = target.querySelector('textarea')!;
    expect(textarea.value).toBe('Second version');
    textarea.value = 'Revised text';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    target
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await tick();
    await tick();
    expect(onedit).toHaveBeenCalledWith('entry-2', 'Revised text');
    expect(target.querySelector('textarea')?.value).toBe('Revised text');
    expect(target.querySelector('[role="alert"]')?.textContent).toContain('draft is still here');
    const cancel = [...target.querySelectorAll('button')].find(
      (item) => item.textContent === 'Cancel',
    )!;
    cancel.click();
    await tick();
    expect(target.querySelector('textarea')).toBeNull();
    expect(target.textContent).toContain('Second version');
  });
  it('disables mutations while busy or without control', async () => {
    const { onedit, onswitch } = await render(true);
    expect(button('Edit message').disabled).toBe(true);
    expect(button('Previous version').disabled).toBe(true);
    button('Edit message').click();
    button('Previous version').click();
    expect(onedit).not.toHaveBeenCalled();
    expect(onswitch).not.toHaveBeenCalled();
  });
  it('closes the editor only after an accepted edit', async () => {
    const { onedit } = await render();
    button('Edit message').click();
    await tick();
    target
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await tick();
    await tick();
    expect(onedit).toHaveBeenCalledWith('entry-2', 'Second version');
    expect(target.querySelector('textarea')).toBeNull();
  });
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
