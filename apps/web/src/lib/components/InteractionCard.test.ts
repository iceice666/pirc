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

it('names the delegated session a relayed confirm comes from, with an Open link', () => {
  target = document.createElement('div');
  document.body.append(target);
  const onanswer = vi.fn();
  const onopen = vi.fn();
  component = mount(InteractionCard, {
    target,
    props: {
      interaction: {
        id: 'relay.d1.interaction_1',
        runnerEpoch: '0',
        kind: 'confirm',
        status: 'pending',
        title: 'Allow network access?',
        relayed: {
          sessionId: 'worker',
          sessionName: 'Fix the tests',
          workspace: 'repo on node',
          delegationId: 'd1',
        },
      },
      onanswer,
      onopen,
    },
  });
  flushSync();
  expect(target.querySelector('.relayed')?.textContent).toContain(
    'From Fix the tests (repo on node)',
  );
  const button = (label: string) =>
    [...target.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)!;
  button('Open').click();
  expect(onopen).toHaveBeenCalledWith('worker');
  button('Yes, continue').click();
  expect(onanswer).toHaveBeenCalledWith({ action: 'answer', value: true });
});
