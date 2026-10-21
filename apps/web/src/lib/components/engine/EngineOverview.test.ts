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

let target: HTMLDivElement;
let component: ReturnType<typeof mount> | undefined;
let urls: string[];

beforeEach(() => {
  urls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const url = new URL(input, 'http://localhost');
      urls.push(url.pathname + url.search);
      const reply = (value: unknown) => new Response(JSON.stringify(value));
      if (url.pathname === '/api/rooms')
        return reply({
          user: 'me',
          rooms: [
            { id: 'general', name: 'general', archivedAt: null },
            { id: 'room_slime', name: 'SlimeOS', archivedAt: null },
          ],
        });
      if (url.pathname === '/api/brain/turns')
        return reply({
          turns: [
            {
              id: 't2',
              roomId: url.searchParams.get('room'),
              kind: 'wake',
              messageIds: [],
              startedAt: 1_700_000_000_000,
              endedAt: 1_700_000_004_000,
              outcome: 'done',
              error: null,
              usage: { totalTokens: 1500 },
            },
            {
              id: 't1',
              roomId: url.searchParams.get('room'),
              kind: 'user',
              messageIds: ['m1', 'm2'],
              startedAt: 1_699_999_000_000,
              endedAt: 1_699_999_001_000,
              outcome: 'failed',
              error: 'the model refused',
              usage: null,
            },
          ],
        });
      if (url.pathname === '/api/sources')
        return reply({
          kinds: [],
          webSearch: { available: false },
          sources: [
            {
              id: 'src_1',
              kind: 'email',
              name: 'School mail',
              user: 'me',
              config: {},
              pausedAt: null,
              lastPolledAt: Date.now() - 300_000,
              lastError: 'login failed',
              failures: 3,
              createdAt: 1,
              updatedAt: 1,
              rooms: ['room_slime'],
              cadenceMs: 300_000,
            },
          ],
        });
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
  for (let index = 0; index < 5; index++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await tick();
  }
  flushSync();
};

function show(section: string) {
  const props = reactiveProps({
    section: section as never,
    onsection: vi.fn((next: string) => (props.section = next as never)),
    nodes: [node],
  });
  component = mount(EngineOverview, { target, props });
  return props;
}

describe('the engine’s front page', () => {
  it('shows what each node can do and how busy it is, and switches tabs', async () => {
    const props = show('nodes');
    await flush();
    const card = target.querySelector('[aria-label="Node work"]')!;
    expect(card.textContent).toContain('linux · x86_64');
    expect(card.textContent).toContain('2× nvidia RTX 4090 24 GB');
    expect(card.textContent).toContain('browse, open terminals');
    expect(card.textContent).toContain('1 running of 4');
    expect(card.textContent).toContain('slimeos');
    const tab = [...target.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
      (item) => item.textContent === 'Sources',
    )!;
    tab.click();
    expect(props.onsection).toHaveBeenCalledWith('sources');
  });

  it('lists a room’s brain turns: why, how they ended, what they used', async () => {
    show('brain');
    await flush();
    expect(urls).toContain('/api/brain/turns?room=general&limit=20');
    const rows = [...target.querySelectorAll('tbody tr')].map((row) => row.textContent);
    expect(rows[0]).toContain('Came back on its own');
    expect(rows[0]).toContain('4s');
    expect(rows[0]).toContain('1.5k tokens');
    expect(rows[1]).toContain('2 messages');
    expect(rows[1]).toContain('the model refused');
    const select = target.querySelector('select')!;
    expect([...select.options].map((option) => option.textContent)).toEqual([
      '#general',
      '#SlimeOS',
    ]);
    select.value = 'room_slime';
    select.dispatchEvent(new Event('change'));
    await flush();
    expect(urls).toContain('/api/brain/turns?room=room_slime&limit=20');
  });

  it('says how the sources are doing and which rooms follow them', async () => {
    show('sources');
    await flush();
    const text = target.textContent ?? '';
    expect(text).toContain('School mail');
    expect(text).toContain('Failing (3 in a row)');
    expect(text).toContain('Read 5m ago');
    expect(text).toContain('followed in #SlimeOS');
    expect(text).toContain('login failed');
  });
});
