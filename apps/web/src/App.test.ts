// @vitest-environment jsdom
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App.svelte';
import { app, MESSAGE_PAGE } from './lib/app.svelte';
import { panelApi } from './lib/panel-api';
import { seedApp, stubMatchMedia } from './lib/testing/app-state';
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
  vi.spyOn(app, 'bootstrap').mockImplementation(async () => {
    seedApp({ messages: messages(count), run: null });
    app.hiddenMessages = Math.max(0, count - MESSAGE_PAGE);
    app.loading = false;
  });
  component = mount(App, { target });
  await tick();
  flushSync();
}

beforeEach(() => {
  stubMatchMedia(false, true);
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.spyOn(app, 'refreshControl').mockResolvedValue();
  vi.spyOn(app, 'refreshNodes').mockResolvedValue();
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('App transcript', () => {
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
    app.sessionState = { ...app.sessionState!, messages: messages(11) };
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

describe('App header', () => {
  it('keeps a badge up while the agent runs unsandboxed', async () => {
    await start(2);
    expect(target.querySelector('.unsandboxed')).toBeNull();
    app.sessionState = {
      ...app.sessionState!,
      sandbox: { active: false, reason: 'srt is not installed' },
    };
    flushSync();
    const badge = target.querySelector<HTMLElement>('.unsandboxed')!;
    expect(badge.textContent).toContain('Not sandboxed');
    expect(badge.title).toContain('srt is not installed');
    app.sessionState = { ...app.sessionState!, sandbox: { active: true } };
    flushSync();
    expect(target.querySelector('.unsandboxed')).toBeNull();
  });
});

describe('App side panel on a narrow screen', () => {
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
