// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost/"}
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Engine from './Engine.svelte';
import { engine } from './lib/engine.svelte';
import { panelApi } from './lib/panel-api';
import { demoWorkspaces } from './lib/mock';
import { seedApp, stubMatchMedia } from './lib/testing/engine-state';

/** ResizeObserver for jsdom (the viewport and the terminal observe sizes). */
class FakeResizeObserver {
  observe() {}
  disconnect() {}
}

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, String(value)),
  };
}

let component: ReturnType<typeof mount> | undefined;
let target: HTMLDivElement;

async function start(width = 1400) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  vi.spyOn(engine, 'bootstrap').mockImplementation(async () => {
    seedApp({ run: null });
    engine.loading = false;
  });
  component = mount(Engine, { target });
  await tick();
  flushSync();
}

beforeEach(() => {
  stubMatchMedia(false, true);
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.stubGlobal('localStorage', memoryStorage());
  vi.spyOn(engine, 'refreshControl').mockResolvedValue();
  vi.spyOn(engine, 'refreshNodes').mockResolvedValue();
  vi.spyOn(panelApi, 'state').mockResolvedValue({
    agentRunning: false,
    memory: null,
    memoryRuntime: null,
    backgroundTasks: [],
    team: { agents: [] },
  });
  localStorage.clear();
  target = document.createElement('div');
  document.body.append(target);
});
afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  target.remove();
  engine.view = 'session';
  history.replaceState(null, '', '/');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Engine header', () => {
  it('keeps a badge up while the agent runs unsandboxed', async () => {
    await start();
    expect(target.querySelector('.unsandboxed')).toBeNull();
    engine.sessionState = {
      ...engine.sessionState!,
      sandbox: { active: false, reason: 'srt is not installed' },
    };
    flushSync();
    const badge = target.querySelector<HTMLElement>('.unsandboxed')!;
    expect(badge.textContent).toContain('Not sandboxed');
    expect(badge.title).toContain('srt is not installed');
    engine.sessionState = { ...engine.sessionState!, sandbox: { active: true } };
    flushSync();
    expect(target.querySelector('.unsandboxed')).toBeNull();
  });
});

describe('Engine session', () => {
  it('shows its panes, with no conversation or composer', async () => {
    await start();
    const panes = target.querySelector<HTMLElement>('.session-panes')!;
    expect(panes.getAttribute('aria-label')).toBe('Session');
    expect(panes.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain(
      'Files',
    );
    expect(target.querySelector('.conversation, .timeline, textarea')).toBeNull();
    // No toggle: the panes are the page, on a phone too.
    expect(target.querySelector('.details-toggle')).toBeNull();
  });

  it('keeps the panes in the main column on a phone', async () => {
    await start(400);
    // Behind the phone's session list (inert while it shows), not in an overlay.
    expect(target.querySelector('main .session-panes')).not.toBeNull();
    expect(target.querySelector('.panel-scrim')).toBeNull();
  });
});

describe('Engine front page', () => {
  it('shows the overview in place of the session, and goes back to a session', async () => {
    await start();
    engine.nodes = [];
    engine.showOverview('nodes');
    flushSync();
    expect(target.querySelector('.overview h1')?.textContent).toBe('Engine');
    expect(target.textContent).toContain('No node is connected');
    expect(target.querySelector('.session-panes')).toBeNull();
    expect(location.search).toBe('?open=nodes');
    expect(document.title).toBe('Engine · pirc');
    engine.view = 'session';
    flushSync();
    expect(target.querySelector('.overview')).toBeNull();
    expect(target.querySelector('.session-panes')).not.toBeNull();
  });
});

describe('Engine phone tabs', () => {
  it('lead back to the rooms, and show what waits in the engine', async () => {
    await start(400);
    const tabs = target.querySelector('nav[aria-label="Sections"]')!;
    expect(tabs.querySelector('a[href="/"]')?.textContent).toContain('Rooms');
    const labels = [...tabs.querySelectorAll('button.tab')].map((item) => item.textContent);
    expect(labels).toEqual(['Engine', 'Settings']);
    expect(tabs.querySelector('[aria-current="page"]')?.textContent).toContain('Engine');
  });
});

describe('Engine workspace page', () => {
  it('opens from the breadcrumb, lists the sessions and goes back to one', async () => {
    await start();
    engine.workspaces = demoWorkspaces;
    flushSync();
    const session = engine.sessionState!.session;
    target.querySelector<HTMLButtonElement>('.breadcrumb .crumb')!.click();
    flushSync();
    expect(engine.view).toBe('workspace');
    expect(location.search).toBe(`?workspace=${session.workspaceId}`);
    expect(target.querySelector('.workspace-page h1')!.textContent).toBe('pirc');
    expect(target.querySelector('.session-panes')).toBeNull();
    expect(document.title).toBe('pirc · pirc');

    const open = vi.spyOn(engine, 'openSession').mockImplementation(async () => {
      engine.view = 'session';
    });
    target.querySelector<HTMLButtonElement>('.workspace-page .row-main')!.click();
    flushSync();
    expect(open).toHaveBeenCalledWith(session.id);
    expect(target.querySelector('.workspace-page')).toBeNull();
    expect(target.querySelector('.session-panes')).not.toBeNull();
  });
});

describe('Engine unread sessions', () => {
  it('marks the session on screen read, but not one behind a page', async () => {
    await start();
    const id = engine.sessionState!.session.id;
    const fetch = vi.fn(async () => new Response(JSON.stringify({ session: { id } })));
    vi.stubGlobal('fetch', fetch);
    engine.view = 'workspace';
    engine.sessions = engine.sessions.map((item) => ({ ...item, unread: true }));
    engine.markActiveRead();
    expect(fetch).not.toHaveBeenCalled();
    engine.view = 'session';
    engine.markActiveRead();
    expect(engine.sessions.find((item) => item.id === id)!.unread).toBe(false);
    expect(fetch).toHaveBeenCalledWith(
      `/api/sessions/${encodeURIComponent(id)}/read`,
      expect.objectContaining({ method: 'POST' }),
    );
    // Already read: nothing more to tell the gateway.
    engine.markActiveRead();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('Engine native management link', () => {
  it('keeps normal bootstrap and the other query parameters while showing consent without approving', async () => {
    HTMLDialogElement.prototype.showModal = function () {
      this.open = true;
    };
    HTMLDialogElement.prototype.close = function () {
      this.open = false;
      this.dispatchEvent(new Event('close'));
    };
    history.replaceState(null, '', '/?nativeManagement=req%2Fone&session=existing-session');
    const consent = '/api/native-management/requests/req%2Fone';
    const fetch = vi.fn(async (url: string, _init: RequestInit) =>
      url.startsWith(consent)
        ? new Response(
            JSON.stringify({
              id: 'req/one',
              status: 'pending',
              deviceName: 'Test phone',
              capabilities: ['providers'],
              expiresAt: Date.now() + 300_000,
              serverNow: Date.now(),
            }),
          )
        : // The session's panes load too; they are not what this checks.
          new Response(JSON.stringify({ error: { code: 'not_found', message: 'Not found' } }), {
            status: 404,
          }),
    );
    vi.stubGlobal('fetch', fetch);

    await start();
    await tick();
    flushSync();
    await vi.waitFor(() => {
      flushSync();
      expect(target.textContent).toContain('Test phone');
    });

    expect(engine.bootstrap).toHaveBeenCalledTimes(1);
    expect(location.search).toBe('?nativeManagement=req%2Fone&session=existing-session');
    const asked = fetch.mock.calls.filter(([url]) => url.startsWith(consent));
    expect(asked.map(([, init]) => init?.method ?? 'GET')).toEqual(['GET']);
  });
});
