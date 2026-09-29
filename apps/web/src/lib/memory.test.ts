// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { app } from './app.svelte';
import MemorySettings from './components/MemorySettings.svelte';
import { describeOrigins, describeVersion, type MemoryEntry, type MemoryView } from './memory';

describe('memory labels', () => {
  it('says where an entry came from', () => {
    expect(describeOrigins(['user'])).toBe('From your words');
    expect(describeOrigins(['assistant', 'custom:agent-team', 'tool:bash', 'tool:read'])).toBe(
      'From the assistant, tool output (bash, read), agent-team messages',
    );
    expect(describeOrigins([])).toBe('');
  });

  it('says who changed a version', () => {
    const version = {
      revision: 2,
      content: 'x',
      origins: [],
      sources: {},
      at: 0,
    };
    expect(
      describeVersion({ ...version, op: 'replace', actor: 'session:s1' }, { s1: 'Trip' }),
    ).toBe('Changed by the assistant (Trip)');
    expect(describeVersion({ ...version, op: 'restore', actor: 'user:me' }, {})).toBe(
      'Restored by you',
    );
  });
});

describe('MemorySettings', () => {
  let target: HTMLDivElement;
  let component: ReturnType<typeof mount> | undefined;
  let calls: Array<{ url: string; method: string; body: unknown }>;
  let view: MemoryView;

  const entry = (id: string, content: string, extra: Partial<MemoryEntry> = {}): MemoryEntry => ({
    id,
    kind: 'note',
    content,
    status: 'active',
    revision: 1,
    origins: ['assistant'],
    sources: { sessionId: 's1' },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...extra,
  });

  async function flush() {
    for (let i = 0; i < 12; i++) {
      await Promise.resolve();
      await tick();
    }
  }
  const button = (text: string, within: ParentNode = target) =>
    Array.from(within.querySelectorAll<HTMLButtonElement>('button')).find(
      (item) => item.textContent?.trim() === text,
    )!;
  /** The list item holding `text`, optionally within a list labelled `list`. */
  const row = (text: string, list?: string) =>
    Array.from(
      (list ? target.querySelector(`[aria-label="${list}"]`)! : target).querySelectorAll('li'),
    ).find((item) => item.textContent?.includes(text))!;
  const lastChange = () => {
    const changes = calls.filter((call) => call.method === 'POST');
    return changes[changes.length - 1];
  };

  beforeEach(() => {
    calls = [];
    view = {
      usage: { user: { used: 20, max: 2000 }, note: { used: 30, max: 8000 } },
      user: [
        entry('u1', 'Prefers short answers.', {
          kind: 'user',
          origins: ['user'],
          sources: { sessionId: 's1', quote: 'keep it short' },
        }),
      ],
      notes: [entry('n1', 'm5pro holds the pirc repo.', { revision: 2 })],
      removed: [entry('n2', 'Old note.', { status: 'removed' })],
      proposals: [
        {
          id: 'p1',
          action: 'replace',
          targetId: 'u1',
          targetRevision: 1,
          content: 'Prefers very short answers.',
          quote: 'even shorter please',
          sources: { sessionId: 's1' },
          sessionId: 's1',
          status: 'pending',
          createdAt: Date.now(),
          decidedAt: null,
          target: { id: 'u1', content: 'Prefers short answers.', revision: 1 },
        },
      ],
      sessions: { s1: 'Trip planning' },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit = {}) => {
        const method = init.method ?? 'GET';
        calls.push({ url, method, body: init.body ? JSON.parse(String(init.body)) : undefined });
        if (url.endsWith('/history'))
          return new Response(
            JSON.stringify({
              versions: [
                {
                  revision: 2,
                  op: 'replace',
                  content: 'm5pro holds the pirc repo.',
                  origins: [],
                  sources: {},
                  actor: 'session:s1',
                  at: Date.now(),
                },
                {
                  revision: 1,
                  op: 'add',
                  content: 'lumo holds the pirc repo.',
                  origins: [],
                  sources: {},
                  actor: 'session:s1',
                  at: Date.now(),
                },
              ],
            }),
          );
        if (method === 'POST') {
          if (url.includes('/approve') || url.includes('/reject'))
            view = { ...view, proposals: [] };
          if (url.includes('/forget')) view = { ...view, notes: [] };
        }
        return new Response(JSON.stringify(view), { status: 200 });
      }),
    );
    app.memoryPending = 0;
    target = document.createElement('div');
    document.body.append(target);
  });
  afterEach(() => {
    if (component) unmount(component);
    component = undefined;
    target.remove();
    vi.unstubAllGlobals();
  });

  it('shows what waits for approval and what is remembered, with its provenance', async () => {
    const onopenchat = vi.fn();
    component = mount(MemorySettings, { target, props: { onopenchat } });
    await flush();
    expect(calls[0]).toMatchObject({ url: '/api/memory', method: 'GET' });
    const waiting = target.querySelector('[aria-label="Waiting for you"]')!;
    expect(waiting.textContent).toContain('Change: Prefers very short answers.');
    expect(waiting.textContent).toContain('Now: Prefers short answers.');
    expect(waiting.textContent).toContain('You said “even shorter please”');
    expect(row('m5pro').textContent).toContain('From the assistant');
    expect(row('Prefers short answers.', 'About you').textContent).toContain(
      'you said “keep it short”',
    );
    expect(target.textContent).toContain('USER 20/2,000 characters');
    expect(app.memoryPending).toBe(1);
    button('Trip planning', waiting).click();
    expect(onopenchat).toHaveBeenCalledWith('s1');

    // Approving sends the version of the entry that was on screen.
    button('Approve').click();
    await flush();
    expect(lastChange()).toMatchObject({
      url: '/api/memory/proposals/p1/approve',
      method: 'POST',
      body: { targetRevision: 1 },
    });
    expect(target.querySelector('[aria-label="Waiting for you"]')).toBeNull();
    expect(app.memoryPending).toBe(0);
  });

  it('forgets only after a second click, and restores earlier versions', async () => {
    component = mount(MemorySettings, { target, props: {} });
    await flush();
    const note = row('m5pro');
    button('Forget', note).click();
    flushSync();
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
    button('Cancel', note).click();
    flushSync();
    expect(button('Forget for good', note)).toBeUndefined();

    button('History', note).click();
    await flush();
    const history = note.querySelector('[aria-label="History"]')!;
    expect(history.textContent).toContain('Changed by the assistant (Trip planning)');
    // The current text needs no restore button; the older one has one.
    button('Restore this', history).click();
    await flush();
    expect(lastChange()).toMatchObject({
      url: '/api/memory/entries/n1/restore',
      body: { revision: 1 },
    });

    button('Restore', row('Old note.')).click();
    await flush();
    expect(lastChange()).toMatchObject({ url: '/api/memory/entries/n2/restore', body: {} });

    button('Forget', row('m5pro')).click();
    flushSync();
    button('Forget for good', row('m5pro')).click();
    await flush();
    expect(lastChange()).toMatchObject({ url: '/api/memory/entries/n1/forget' });
    expect(target.textContent).not.toContain('m5pro');
  });

  it('reloads when the gateway says memory changed, and never calls it in demo mode', async () => {
    component = mount(MemorySettings, { target, props: {} });
    await flush();
    const before = calls.length;
    app.memoryRevision++;
    await flush();
    expect(calls.length).toBe(before + 1);
    unmount(component);
    component = undefined;
    calls = [];
    component = mount(MemorySettings, { target, props: { disabled: true } });
    await flush();
    expect(calls).toEqual([]);
    expect(target.textContent).toContain('demo mode');
  });
});
