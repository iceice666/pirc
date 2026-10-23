// @vitest-environment jsdom
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NodeSummary } from '../../types';
import { reactiveProps } from '../../testing/props.svelte';
import EngineOverview from './EngineOverview.svelte';

const node: NodeSummary = {
  id: 'work',
  connectedAt: Date.now() - 120_000,
  lastSeenAt: Date.now(),
  workspaces: [{ id: 'work:slimeos', displayName: 'slimeos' }],
  capabilities: {
    os: 'linux',
    arch: 'x86_64',
    gpus: [{ vendor: 'nvidia', count: 2, model: 'RTX 4090', vramMb: 24_576 }],
    browser: true,
    terminals: true,
    sandbox: { backend: 'bwrap', status: 'ready', gpu: true },
    maxRunning: 4,
  },
  load: { running: 1, max: 4 },
};

const turn = (
  id: string,
  roomId: string,
  startedAt: number,
  extra: Record<string, unknown> = {},
) => ({
  id,
  roomId,
  kind: 'user',
  messageIds: ['m1'],
  startedAt,
  endedAt: startedAt + 4_000,
  outcome: 'done',
  error: null,
  usage: { totalTokens: 1_500 },
  ...extra,
});

const openLoop = (id: string, what: string, origin: string) => ({
  id,
  user: 'me',
  roomId: 'room_slime',
  faceId: null,
  what,
  why: '',
  origin,
  anchor: null,
  nextCheck: null,
  status: 'open',
  closedReason: null,
  closedAt: null,
  createdAt: 1,
  lastTouchedAt: 1,
  dueAt: null,
});

const wake = (id: string, over: Record<string, unknown>) => ({
  id,
  kind: 'source',
  trigger: { name: 'Moodle' },
  roomId: 'room_slime',
  faceId: null,
  user: null,
  scheduledAt: Date.now() + 3_600_000,
  startedAt: null,
  endedAt: null,
  outcome: null,
  note: null,
  attempt: 0,
  turnId: null,
  createdAt: 1,
  ...over,
});

const source = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id,
  kind: 'email',
  name,
  user: 'me',
  config: {},
  pausedAt: null,
  lastPolledAt: Date.now() - 300_000,
  lastError: null,
  failures: 0,
  createdAt: 1,
  updatedAt: 1,
  rooms: ['room_slime'],
  cadenceMs: 300_000,
  ...over,
});

let target: HTMLDivElement;
let component: ReturnType<typeof mount> | undefined;
let calls: Array<{ url: string; method: string }>;

const now = Date.now();

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://localhost');
      calls.push({ url: url.pathname + url.search, method: init?.method ?? 'GET' });
      const reply = (value: unknown) => new Response(JSON.stringify(value));
      if (url.pathname === '/api/rooms')
        return reply({
          user: 'me',
          rooms: [
            { id: 'general', name: 'general', archivedAt: null },
            { id: 'room_slime', name: 'SlimeOS', archivedAt: null },
          ],
        });
      if (url.pathname === '/api/brain/turns') {
        const room = url.searchParams.get('room');
        return reply({
          turns: [
            turn(
              room === 'general' ? 'g1' : 's1',
              room ?? '',
              now - (room === 'general' ? 60_000 : 5_000),
            ),
          ],
        });
      }
      if (url.pathname === '/api/loops')
        return reply({
          limit: 40,
          loops:
            url.searchParams.get('status') === 'open'
              ? [
                  openLoop('l1', 'HW3 deadline', 'tool:moodle'),
                  openLoop('l2', '檢查 boot 時間', 'user'),
                  openLoop('l3', 'SlimeOS 例會', 'user'),
                  openLoop('l4', '換掉 TLP', 'user'),
                  openLoop('l5', 'one more', 'user'),
                ]
              : [],
        });
      if (url.pathname === '/api/wakes')
        return reply({
          today: { used: 9, limit: 24 },
          wakes: [
            wake('w1', { trigger: { name: 'Moodle', reason: 'followed' } }),
            wake('w2', { scheduledAt: now + 7_200_000 }),
            wake('w3', {
              outcome: 'silent',
              endedAt: now - 600_000,
              scheduledAt: now - 700_000,
            }),
          ],
        });
      if (url.pathname.startsWith('/api/wakes/')) return reply({ wake: {} });
      if (url.pathname === '/api/sources')
        return reply({
          kinds: [],
          webSearch: { available: false },
          sources: [
            source('src_1', 'Personal mail'),
            source('src_2', 'School mail', { failures: 3, lastError: 'login failed' }),
            source('src_3', 'Timetable', { pausedAt: 5 }),
          ],
        });
      if (url.pathname === '/api/memory/preferences')
        return reply({ usage: { used: 0, max: 40 }, preferences: [], removed: [], rooms: {} });
      if (url.pathname === '/api/memory/records') return reply({ records: [] });
      return reply({});
    }),
  );
  target = document.createElement('div');
  document.body.append(target);
});
afterEach(() => {
  if (component) unmount(component);
  component = undefined;
  target.remove();
  vi.unstubAllGlobals();
});

const flush = async () => {
  for (let index = 0; index < 6; index++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await tick();
  }
  flushSync();
};

function show(section = 'overview') {
  const props = reactiveProps({
    section: section as never,
    onsection: vi.fn((next: string) => (props.section = next as never)),
    nodes: [node],
    onsettings: vi.fn(),
  });
  component = mount(EngineOverview, { target, props });
  return props;
}

const link = (label: string) =>
  [...target.querySelectorAll<HTMLAnchorElement>('a')].find(
    (item) => item.textContent?.trim() === label,
  )!;

describe('the engine’s dashboard', () => {
  it('shows a node’s state, load, capabilities and workspaces, and links its section', async () => {
    const props = show();
    await flush();
    const card = target.querySelector('[aria-label="Node work"]')!;
    expect(card.textContent).toContain('linux · x86_64');
    expect(card.textContent).toContain('2× nvidia RTX 4090');
    expect(card.textContent).toContain('browse');
    expect(card.textContent).toContain('open terminals');
    expect(card.textContent).toContain('bwrap · ready');
    expect(card.textContent).toContain('1 of 4');
    expect(card.textContent).toContain('Busy');
    expect(card.textContent).toContain('slimeos');
    link('All nodes').click();
    expect(props.onsection).toHaveBeenCalledWith('nodes');
  });

  it('turns the tabs into anchors to the sections, and marks the one in view', async () => {
    const props = show('wakes');
    await flush();
    const nav = target.querySelector('nav[aria-label="Engine sections"]')!;
    expect([...nav.querySelectorAll('a')].map((item) => item.getAttribute('href'))).toEqual([
      '#overview',
      '#nodes',
      '#brain',
      '#loops',
      '#wakes',
      '#memory',
      '#sources',
    ]);
    expect(nav.querySelector('[aria-current="location"]')?.textContent).toBe('Wakes');
    for (const id of ['overview', 'nodes', 'brain', 'loops', 'wakes', 'memory', 'sources'])
      expect(target.querySelector(`#${id}`), id).not.toBeNull();
    const nodes = [...nav.querySelectorAll<HTMLAnchorElement>('a')].find(
      (item) => item.textContent === 'Nodes',
    )!;
    nodes.click();
    expect(props.onsection).toHaveBeenCalledWith('nodes');
  });

  it('lists the newest turns of every room, with the room each happened in', async () => {
    show();
    await flush();
    expect(calls.some((call) => call.url.startsWith('/api/brain/turns?room=general'))).toBe(true);
    expect(calls.some((call) => call.url.startsWith('/api/brain/turns?room=room_slime'))).toBe(
      true,
    );
    const rows = [...target.querySelectorAll('#overview ~ * tbody tr, .turns tbody tr')];
    expect(rows.length).toBeGreaterThan(0);
    const cells = [...rows[0]!.querySelectorAll('td')].map((cell) => cell.textContent);
    // Started, Room, Why, Outcome, Took, Used.
    expect(cells[1]).toBe('#SlimeOS');
    expect(cells[3]?.trim()).toBe('Done');
    expect(cells[5]).toBe('1.5k tokens');
    expect(target.textContent).toContain('one turn at a time, every room');
    link('All turns').click();
  });

  it('summarises open loops: how many are in the prompt and the first few', async () => {
    const props = show();
    await flush();
    expect(target.textContent).toContain('5 of 40 in prompt');
    const card = target.querySelector('[aria-labelledby="loops-card-title"]')!;
    expect(card.querySelectorAll('li')).toHaveLength(4);
    expect(card.textContent).toContain('HW3 deadline');
    expect(card.querySelector('code.origin')?.textContent).toBe('tool:moodle');
    expect(card.textContent).toContain('#SlimeOS');
    link('All loops').click();
    expect(props.onsection).toHaveBeenCalledWith('loops');
  });

  it('summarises wakes: today against the allowance, the coming ones and Cancel', async () => {
    show();
    await flush();
    expect(target.textContent).toContain('9 of 24 today');
    const bar = target.querySelector('[role="progressbar"]')!;
    expect(bar.getAttribute('aria-valuenow')).toBe('9');
    const card = target.querySelector('[aria-labelledby="wakes-card-title"]')!;
    expect(card.textContent).toContain('Coming');
    expect(card.textContent).toContain('Recent');
    const cancel = [...card.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Cancel',
    )!;
    cancel.click();
    await flush();
    expect(
      calls.some((call) => call.method === 'DELETE' && call.url.startsWith('/api/wakes/')),
    ).toBe(true);
  });

  it('shows the sources with the failing one tinted, and opens Settings for them', async () => {
    const props = show();
    await flush();
    const failing = target.querySelector('[aria-labelledby="sources-card-title"] li.failing')!;
    expect(failing.textContent).toContain('School mail');
    expect(failing.textContent).toContain('Failing (3 in a row)');
    expect(failing.textContent).toContain('login failed');
    const paused = target.querySelector('[aria-labelledby="sources-card-title"] li.paused')!;
    expect(paused.textContent).toContain('Paused');
    const manage = [...target.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Manage in Settings',
    )!;
    manage.click();
    expect(props.onsettings).toHaveBeenCalled();
  });

  it('keeps the full lists and the editors in the sections', async () => {
    show();
    await flush();
    // Nodes: the machine's own detail.
    const nodes = target.querySelector('#nodes')!;
    expect(nodes.textContent).toContain('Machine');
    expect(nodes.textContent).toContain('2× nvidia RTX 4090 24 GB');
    // Brain: one room at a time, in full.
    const brain = target.querySelector('#brain')!;
    expect([...brain.querySelectorAll('option')].map((option) => option.textContent)).toEqual([
      '#general',
      '#SlimeOS',
    ]);
    // Open loops: the editor, with what closes a loop.
    expect(target.querySelector('#loops')!.textContent).toContain('Not needed');
    // Wakes: the editor, with the day's allowance and the cancelled wake's list.
    expect(target.querySelector('#wakes')!.textContent).toContain('Today: 9 of 24');
    // Sources: the full list, with what follows each.
    expect(target.querySelector('#sources')!.textContent).toContain('followed in #SlimeOS');
  });
});
