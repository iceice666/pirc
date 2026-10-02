// @vitest-environment jsdom
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '../api';
import InteractionCard from './InteractionCard.svelte';

let component: ReturnType<typeof mount> | undefined;
let target: HTMLDivElement;

beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  target?.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('stops accepting answers once the interaction expires', () => {
  target = document.createElement('div');
  document.body.append(target);
  const onanswer = vi.fn();
  component = mount(InteractionCard, {
    target,
    props: {
      interaction: {
        id: 'i1',
        runnerEpoch: '1',
        kind: 'confirm',
        title: 'Continue?',
        status: 'pending',
        expiresAt: new Date(Date.now() + 5_000).toISOString(),
      },
      onanswer,
    },
  });
  flushSync();
  const buttons = () => Array.from(target.querySelectorAll('button'));
  expect(buttons().every((button) => !button.disabled)).toBe(true);
  vi.advanceTimersByTime(5_000);
  flushSync();
  expect(buttons().every((button) => button.disabled)).toBe(true);
  expect(target.textContent).toContain('Expired');
});

it('declines a confirm with No instead of cancelling it', () => {
  target = document.createElement('div');
  document.body.append(target);
  const onanswer = vi.fn();
  component = mount(InteractionCard, {
    target,
    props: {
      interaction: {
        id: 'i2',
        runnerEpoch: '1',
        kind: 'confirm',
        title: 'Continue?',
        status: 'pending',
      },
      onanswer,
    },
  });
  flushSync();
  const no = Array.from(target.querySelectorAll('button')).find((button) =>
    button.textContent?.includes('No'),
  );
  no!.click();
  expect(onanswer).toHaveBeenCalledWith({ action: 'answer', value: false });
});

it("lets the user pick a delegation's model and thinking level before approving", async () => {
  vi.spyOn(api, 'models').mockResolvedValue([
    { id: 'model-a', provider: 'gw', displayName: 'Model A', thinkingLevels: [], available: true },
    { id: 'model-b', provider: 'gw', displayName: 'Model B', thinkingLevels: [], available: true },
  ]);
  target = document.createElement('div');
  document.body.append(target);
  const onanswer = vi.fn();
  component = mount(InteractionCard, {
    target,
    props: {
      interaction: {
        id: 'd1',
        runnerEpoch: '0',
        kind: 'confirm',
        title: 'Delegate to Test on work?',
        status: 'pending',
        confirmLabel: 'Delegate',
        modelChoice: { model: { provider: 'gw', id: 'model-a' }, thinking: 'low' },
      },
      onanswer,
    },
  });
  // The default plus both offered models (the suggestion among them).
  await vi.waitFor(() => {
    flushSync();
    expect(target.querySelector('select')!.options.length).toBe(3);
  });
  const [model, thinking] = Array.from(target.querySelectorAll('select'));
  // The assistant's suggestion is preselected.
  expect([model!.value, thinking!.value]).toEqual([JSON.stringify(['gw', 'model-a']), 'low']);
  model!.value = JSON.stringify(['gw', 'model-b']);
  model!.dispatchEvent(new Event('change'));
  thinking!.value = '';
  thinking!.dispatchEvent(new Event('change'));
  flushSync();
  Array.from(target.querySelectorAll('button'))
    .find((button) => button.textContent?.includes('Delegate'))!
    .click();
  expect(onanswer).toHaveBeenCalledWith({
    action: 'answer',
    value: true,
    model: { provider: 'gw', id: 'model-b' },
    thinking: null,
  });
});

it('shows the memory proposal and exact quote with Approve / Reject, including control locking', () => {
  target = document.createElement('div');
  document.body.append(target);
  const onanswer = vi.fn();
  component = mount(InteractionCard, {
    target,
    props: {
      interaction: {
        id: 'memory:p1:0',
        runnerEpoch: '0',
        kind: 'confirm',
        status: 'pending',
        title: 'Add USER memory?',
        description:
          'Proposed memory:\nPrefers tea.\n\nYour words:\n“Please remember I prefer tea”',
        confirmLabel: 'Approve',
        cancelLabel: 'Reject',
      },
      disabled: true,
      onanswer,
    },
  });
  flushSync();
  expect(target.textContent).toContain('Please remember I prefer tea');
  expect(target.querySelector('.confirm-copy')).toBeNull();
  const buttons = [...target.querySelectorAll('button')];
  expect(buttons.map((b) => b.textContent?.trim())).toEqual(['Reject', 'Approve']);
  expect(buttons.every((b) => b.disabled)).toBe(true);
  buttons[1]!.click();
  expect(onanswer).not.toHaveBeenCalled();
});
