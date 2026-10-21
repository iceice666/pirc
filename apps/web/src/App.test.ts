// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost/"}
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App.svelte';
import { engine } from './lib/engine.svelte';
import { stubMatchMedia } from './lib/testing/engine-state';

/** The two pages, room-first (plans/rewrite/11-web.md). */
let target: HTMLDivElement;
let component: ReturnType<typeof mount> | undefined;

class FakeSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  close() {}
}

beforeEach(() => {
  stubMatchMedia(false, true);
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  // No gateway: dev builds (and tests) show the demo.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }),
  );
  localStorage.clear();
  target = document.createElement('div');
  document.body.append(target);
});
afterEach(() => {
  if (component) unmount(component);
  component = undefined;
  target.remove();
  history.replaceState(null, '', '/');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('the app', () => {
  it('opens on the rooms, #general first, with the engine a link away', async () => {
    component = mount(App, { target });
    await vi.waitFor(() => expect(target.querySelector('nav[aria-label="Rooms"]')).not.toBeNull());
    await vi.waitFor(() => expect(target.textContent).toContain('明天早上提醒我繳電費'));
    expect(target.querySelector('h1')?.textContent).toContain('general');
    expect(target.querySelector('a[href="/engine"]')).not.toBeNull();
    // The engine's state is not started on the rooms.
    expect(target.querySelector('.app-shell')).toBeNull();
  });

  it('opens the room the address names', async () => {
    history.replaceState(null, '', '/?room=room_slime');
    component = mount(App, { target });
    await vi.waitFor(() => expect(target.textContent).toContain('CI 怎麼又紅了'));
    expect(target.querySelector('h1')?.textContent).toContain('SlimeOS');
  });

  it('shows the engine at /engine, on its front page', async () => {
    history.replaceState(null, '', '/engine?open=wakes');
    vi.spyOn(engine, 'bootstrap').mockImplementation(async () => {
      engine.overviewSection = 'wakes';
      engine.view = 'overview';
      engine.loading = false;
    });
    component = mount(App, { target });
    flushSync();
    await vi.waitFor(() =>
      expect(target.querySelector('.overview h1')?.textContent).toBe('Engine'),
    );
    expect(target.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Wakes');
    expect(target.querySelector('nav[aria-label="Rooms"]')).toBeNull();
    engine.view = 'session';
  });
});
