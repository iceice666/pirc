// @vitest-environment jsdom
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import InteractionCard from './InteractionCard.svelte';

let component: ReturnType<typeof mount> | undefined;
let target: HTMLDivElement;

beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  target?.remove();
  vi.useRealTimers();
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
