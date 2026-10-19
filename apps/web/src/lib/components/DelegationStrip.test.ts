// @vitest-environment jsdom
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import type { ChatDelegation } from '../types';
import DelegationStrip from './DelegationStrip.svelte';

let component: ReturnType<typeof mount> | undefined;
let target: HTMLDivElement;

afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  target?.remove();
});

const delegation = (extra: Partial<ChatDelegation> = {}): ChatDelegation => ({
  id: 'd1',
  title: 'Fix the tests',
  workspace: 'repo on node',
  status: 'running',
  dispatch: 'approved',
  targetSessionId: 'worker',
  ...extra,
});

function render(
  delegations: ChatDelegation[],
  onstop = vi.fn(async (_id: string): Promise<string | undefined> => undefined),
) {
  target = document.createElement('div');
  document.body.append(target);
  const onopen = vi.fn();
  component = mount(DelegationStrip, { target, props: { delegations, onopen, onstop } });
  flushSync();
  return { onopen, onstop };
}

const button = (card: Element, label: string) =>
  [...card.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)!;

it('shows each active delegation with Open and Stop', async () => {
  const { onopen, onstop } = render([
    delegation(),
    delegation({ id: 'd2', status: 'waiting_input', dispatch: 'auto', targetSessionId: 'w2' }),
  ]);
  const cards = target.querySelectorAll('.delegation-card');
  expect(cards).toHaveLength(2);
  expect(cards[0]!.textContent).toContain('Delegated to repo on node — Fix the tests');
  expect(cards[0]!.querySelector('small')).toBeNull();
  expect(cards[1]!.textContent).toContain('Waiting for you · started automatically');
  button(cards[1]!, 'Open').click();
  expect(onopen).toHaveBeenCalledWith('w2');
  button(cards[0]!, 'Stop').click();
  await tick();
  expect(onstop).toHaveBeenCalledWith('d1');
});

it('shows why a stop failed', async () => {
  render(
    [delegation()],
    vi.fn(async () => 'Another device controls the delegated session.'),
  );
  button(target, 'Stop').click();
  await Promise.resolve();
  await tick();
  expect(target.querySelector('[role="alert"]')?.textContent).toBe(
    'Another device controls the delegated session.',
  );
  expect(button(target, 'Stop').disabled).toBe(false);
});

it('renders nothing without delegations', () => {
  render([]);
  expect(target.querySelector('.delegations')).toBeNull();
});
