// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost/"}
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Engine from './Engine.svelte';
import { engine, MESSAGE_PAGE } from './lib/engine.svelte';
import { panelApi } from './lib/panel-api';
import { demoWorkspaces } from './lib/mock';
import { seedApp, stubMatchMedia } from './lib/testing/engine-state';
import type { ConversationMessage } from './lib/types';

/** ResizeObserver for jsdom; `resizeAll()` plays a layout change. */
const observers = new Set<() => void>();
class FakeResizeObserver {
  constructor(private readonly callback: () => void) {}
  observe() {
    observers.add(this.callback);
  }
  disconnect() {
    observers.delete(this.callback);
  }
}
const resizeAll = () => observers.forEach((callback) => callback());

const messages = (count: number): ConversationMessage[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `m${index}`,
    role: index % 2 ? 'assistant' : 'user',
    content: `message ${index}`,
    createdAt: new Date(1_700_000_000_000 + index * 1000).toISOString(),
  }));

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

/** Fake scroll geometry for the timeline (jsdom does no layout). */
function scrollable(element: HTMLElement) {
  const box = { top: 0, height: 5000, client: 500 };
  Object.defineProperties(element, {
    scrollTop: { get: () => box.top, set: (value: number) => (box.top = value) },
    scrollHeight: { get: () => box.height },
    clientHeight: { get: () => box.client },
  });
  element.scrollTo = vi.fn((options?: ScrollToOptions | number) => {
    if (typeof options === 'object') box.top = options.top ?? box.top;
  }) as never;
  return {
    box,
    scrollBy(top: number) {
      box.top = top;
      element.dispatchEvent(new Event('scroll'));
      flushSync();
    },
  };
}

async function start(count = 100, width = 1400) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  vi.spyOn(engine, 'bootstrap').mockImplementation(async () => {
    seedApp({ messages: messages(count), run: null });
    engine.hiddenMessages = Math.max(0, count - MESSAGE_PAGE);
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
  observers.clear();
  engine.view = 'session';
  history.replaceState(null, '', '/');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Engine transcript', () => {
  it('mounts the newest page and reveals earlier messages on demand', async () => {
    await start(100);
    expect(target.querySelectorAll('article.message')).toHaveLength(MESSAGE_PAGE);
    const earlier = target.querySelector<HTMLButtonElement>('.earlier-messages')!;
    expect(earlier.textContent).toContain('40 more');
    earlier.click();
    await tick();
    flushSync();
    expect(target.querySelectorAll('article.message')).toHaveLength(100);
    expect(target.querySelector('.earlier-messages')).toBeNull();
  });

  it('follows new content at the bottom until the reader scrolls up', async () => {
    await start(10);
    const timeline = target.querySelector<HTMLElement>('.timeline')!;
    const { box, scrollBy } = scrollable(timeline);
    resizeAll();
    expect(box.top).toBe(5000);
    // A browser reports the programmatic scroll too.
    scrollBy(5000);

    // Scrolling up detaches: growth no longer moves the view, and a way back appears.
    scrollBy(1000);
    box.height = 6000;
    resizeAll();
    expect(box.top).toBe(1000);
    expect(target.querySelector('.jump-latest')).toBeNull();
    engine.sessionState = { ...engine.sessionState!, messages: messages(11) };
    flushSync();
    const jump = target.querySelector<HTMLButtonElement>('.jump-latest button')!;
    expect(jump.textContent).toContain('New messages');

    jump.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();
    expect(timeline.scrollTo).toHaveBeenCalledWith({ top: 6000, behavior: 'smooth' });
    expect(target.querySelector('.jump-latest')).toBeNull();
    // Following again: the next growth keeps the bottom in view.
    box.height = 7000;
    resizeAll();
    expect(box.top).toBe(7000);
  });

  it('re-pins the bottom when the timeline itself shrinks (soft keyboard)', async () => {
    await start(10);
    const timeline = target.querySelector<HTMLElement>('.timeline')!;
    const { box } = scrollable(timeline);
    box.top = 4500;
    box.client = 300;
    resizeAll();
    expect(box.top).toBe(5000);
  });
});

describe('Engine header', () => {
  it('keeps a badge up while the agent runs unsandboxed', async () => {
    await start(2);
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
  it('is read-only: no composer, a way to where conversations happen', async () => {
    await start(2);
    expect(target.querySelector('.conversation textarea')).toBeNull();
    const footer = target.querySelector('.read-only')!;
    expect(footer.textContent).toContain('read-only');
    expect(footer.querySelector('a')!.getAttribute('href')).toBe('/');
  });
});

describe('Engine front page', () => {
  it('shows the overview in place of the session, and goes back to a session', async () => {
    await start(2);
    engine.nodes = [];
    engine.showOverview('nodes');
    flushSync();
    expect(target.querySelector('.overview h1')?.textContent).toBe('Engine');
    expect(target.textContent).toContain('No node is connected');
    expect(target.querySelector('.conversation')).toBeNull();
    expect(location.search).toBe('?open=nodes');
    expect(document.title).toBe('Engine · pirc');
    engine.view = 'session';
    flushSync();
    expect(target.querySelector('.overview')).toBeNull();
    expect(target.querySelector('.conversation')).not.toBeNull();
  });
});

describe('Engine phone tabs', () => {
  it('lead back to the rooms, and show what waits in the engine', async () => {
    await start(2, 400);
    const tabs = target.querySelector('nav[aria-label="Sections"]')!;
    expect(tabs.querySelector('a[href="/"]')?.textContent).toContain('Rooms');
    const labels = [...tabs.querySelectorAll('button.tab')].map((item) => item.textContent);
    expect(labels).toEqual(['Engine', 'Settings']);
    expect(tabs.querySelector('[aria-current="page"]')?.textContent).toContain('Engine');
  });
});

describe('Engine workspace page', () => {
  it('opens from the breadcrumb, lists the sessions and goes back to one', async () => {
    await start(2);
    engine.workspaces = demoWorkspaces;
    flushSync();
    const session = engine.sessionState!.session;
    target.querySelector<HTMLButtonElement>('.breadcrumb .crumb')!.click();
    flushSync();
    expect(engine.view).toBe('workspace');
    expect(location.search).toBe(`?workspace=${session.workspaceId}`);
    expect(target.querySelector('.workspace-page h1')!.textContent).toBe('pirc');
    expect(target.querySelector('.conversation')).toBeNull();
    expect(document.title).toBe('pirc · pirc');

    const open = vi.spyOn(engine, 'openSession').mockImplementation(async () => {
      engine.view = 'session';
    });
    target.querySelector<HTMLButtonElement>('.workspace-page .row-main')!.click();
    flushSync();
    expect(open).toHaveBeenCalledWith(session.id);
    expect(target.querySelector('.workspace-page')).toBeNull();
    expect(target.querySelector('.conversation')).not.toBeNull();
  });
});

describe('Engine unread sessions', () => {
  it('marks the session on screen read, but not one behind a page', async () => {
    await start(2);
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

describe('Engine side panel on a narrow screen', () => {
  it('ignores a remembered open panel and overlays it with a scrim when opened', async () => {
    localStorage.setItem('relay.layout.detailsOpen', 'true');
    await start(4, 700);
    const toggle = target.querySelector<HTMLButtonElement>('.details-toggle')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(target.querySelector('.panel-scrim')).toBeNull();

    toggle.click();
    flushSync();
    const conversation = target.querySelector<HTMLElement>('.conversation')!;
    expect(target.querySelector('.panel-scrim')).not.toBeNull();
    expect(conversation.inert).toBe(true);
    // The phone's choice does not overwrite the desktop preference.
    expect(localStorage.getItem('relay.layout.detailsOpen')).toBe('true');

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    flushSync();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(conversation.inert).toBe(false);
  });

  it('restores the remembered panel on a wide screen', async () => {
    localStorage.setItem('relay.layout.detailsOpen', 'true');
    await start(4, 1400);
    const toggle = target.querySelector<HTMLButtonElement>('.details-toggle')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(target.querySelector('.panel-scrim')).toBeNull();
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
    const fetch = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(
          JSON.stringify({
            id: 'req/one',
            status: 'pending',
            deviceName: 'Test phone',
            capabilities: ['providers'],
            expiresAt: Date.now() + 300_000,
            serverNow: Date.now(),
          }),
        ),
    );
    vi.stubGlobal('fetch', fetch);

    await start(2);
    await tick();
    flushSync();
    await vi.waitFor(() => {
      flushSync();
      expect(target.textContent).toContain('Test phone');
    });

    expect(engine.bootstrap).toHaveBeenCalledTimes(1);
    expect(location.search).toBe('?nativeManagement=req%2Fone&session=existing-session');
    expect(fetch.mock.calls.map(([, init]) => init?.method ?? 'GET')).toEqual(['GET']);
  });
});
