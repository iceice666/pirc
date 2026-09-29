// @vitest-environment jsdom
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../app.svelte';
import { reactiveProps } from '../testing/props.svelte';
import type { SessionSummary } from '../types';
import Sidebar from './Sidebar.svelte';

const session = (id: string, name: string, extra: Partial<SessionSummary> = {}) => ({
  id,
  workspaceId: 'node:ws',
  name,
  lastActivityAt: new Date().toISOString(),
  runnerStatus: 'ready' as const,
  unreadCount: 0,
  ...extra,
});

let component: ReturnType<typeof mount> | undefined;
let target: HTMLDivElement;
const handlers = {
  oncollapse: vi.fn(),
  onselect: vi.fn(),
  onnew: vi.fn(),
  onaddworkspace: vi.fn(),
  onaddproject: vi.fn(),
  onclose: vi.fn(),
  onsettings: vi.fn(),
};

beforeEach(() => {
  app.nodes = [{ id: 'node' } as never];
  app.workspaces = [{ id: 'node:ws', hostId: 'node', displayName: 'Project' } as never];
  app.sessions = [
    session('a', 'Alpha'),
    session('b', 'Beta', { pinned: true }),
    session('c', 'Gamma', { settled: true }),
  ];
  app.activeSessionId = 'a';
  app.memoryPending = 0;
  target = document.createElement('div');
  document.body.append(target);
});
afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  target.remove();
  vi.restoreAllMocks();
  Object.values(handlers).forEach((handler) => handler.mockReset());
});

function render(props: { open?: boolean; showSettled?: boolean } = {}) {
  const reactive = reactiveProps({ open: false, showSettled: false, ...props, ...handlers });
  component = mount(Sidebar, { target, props: reactive });
  flushSync();
  return reactive;
}

const names = () =>
  Array.from(target.querySelectorAll('.session-card .session-name')).map(
    (item) => item.textContent,
  );

describe('Sidebar', () => {
  it('lists pinned sessions first and hides settled ones unless enabled', () => {
    render();
    expect(names()).toEqual(['Beta', 'Alpha']);
    expect(target.querySelector('.settled-toggle')).toBeNull();
  });

  it('shows settled sessions behind a toggle when enabled', () => {
    render({ showSettled: true });
    const toggle = target.querySelector<HTMLButtonElement>('.settled-toggle')!;
    expect(toggle.textContent).toContain('Settled · 1');
    toggle.click();
    flushSync();
    expect(names()).toEqual(['Beta', 'Alpha', 'Gamma']);
  });

  it('filters by the search query', () => {
    render();
    const search = target.querySelector<HTMLInputElement>('.search input')!;
    search.value = 'alp';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    expect(names()).toEqual(['Alpha']);
  });

  it('selects a session and marks the open one as current', () => {
    render();
    const cards = target.querySelectorAll<HTMLButtonElement>('.session-card');
    expect(cards[1]!.getAttribute('aria-current')).toBe('page');
    cards[0]!.click();
    expect(handlers.onselect).toHaveBeenCalledWith('b');
  });

  it('reveals row actions of another session through its "more" button', () => {
    const update = vi.spyOn(app, 'updateSession').mockResolvedValue();
    render();
    // The open session needs no "more" button; the other row has one.
    expect(target.querySelector('[aria-label="Actions for Alpha"]')).toBeNull();
    const more = target.querySelector<HTMLButtonElement>('[aria-label="Actions for Beta"]')!;
    more.click();
    flushSync();
    const row = target.querySelector('[aria-label="Unpin Beta"]')!.closest('.session-item')!;
    expect(row.classList.contains('revealed')).toBe(true);
    expect(target.querySelector('[aria-label="Actions for Beta"]')).toBeNull();
    target.querySelector<HTMLButtonElement>('[aria-label="Unpin Beta"]')!.click();
    expect(update).toHaveBeenCalledWith('b', { pinned: false });
  });

  it('renames with F2 and Enter', async () => {
    const update = vi.spyOn(app, 'updateSession').mockResolvedValue();
    render();
    const card = target.querySelectorAll<HTMLButtonElement>('.session-card')[1]!;
    card.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }));
    await Promise.resolve();
    flushSync();
    const input = target.querySelector<HTMLInputElement>('.session-rename input')!;
    expect(input.value).toBe('Alpha');
    input.value = 'Renamed';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    flushSync();
    expect(update).toHaveBeenCalledWith('a', { name: 'Renamed' });
    expect(target.querySelector('.session-rename')).toBeNull();
  });

  it('moves focus into the phone drawer and back to the menu button', async () => {
    const props = render();
    const menu = target.querySelector<HTMLButtonElement>('.mobile-menu')!;
    menu.focus();
    props.open = true;
    await tick();
    await tick();
    const close = target.querySelector<HTMLButtonElement>('.mobile-close')!;
    expect(document.activeElement).toBe(close);
    props.open = false;
    flushSync();
    expect(document.activeElement).toBe(menu);
  });

  it('shows on Settings how many memory changes wait for approval', () => {
    render();
    const settings = target.querySelector<HTMLButtonElement>('.settings-entry')!;
    expect(settings.querySelector('.pending-count')).toBeNull();
    app.memoryPending = 2;
    flushSync();
    expect(settings.querySelector('.pending-count')!.textContent).toContain('2');
    settings.click();
    expect(handlers.onsettings).toHaveBeenCalled();
  });

  it('starts new sessions from a dialog when no node hosts chats', () => {
    render();
    const button = target.querySelector<HTMLButtonElement>('.new-session')!;
    expect(button.textContent).toContain('New session');
    button.click();
    expect(handlers.onnew).toHaveBeenCalledWith();
    expect(target.querySelector('[aria-label="Chats"]')).toBeNull();
  });

  it('puts chats and projects first when a chat node is connected', () => {
    app.nodes = [{ id: 'node' } as never, { id: 'home' } as never];
    app.workspaces = [
      { id: 'node:ws', hostId: 'node', displayName: 'Project' } as never,
      { id: 'home:chats', hostId: 'home', displayName: 'Chats', kind: 'chat' } as never,
      { id: 'home:trip', hostId: 'home', displayName: 'Trip', kind: 'chat' } as never,
    ];
    app.sessions = [
      session('a', 'Alpha'),
      session('t', 'Top chat', { workspaceId: 'home:chats' }),
      session('p', 'Planning', { workspaceId: 'home:trip' }),
    ];
    render();
    const text = (selector: string) => target.querySelector(selector)?.textContent ?? '';
    // New chat opens a top-level chat right away, like ChatGPT's.
    const button = target.querySelector<HTMLButtonElement>('.new-session')!;
    expect(button.textContent).toContain('New chat');
    button.click();
    expect(handlers.onnew).toHaveBeenCalledWith('home:chats');
    expect(text('[aria-label="Chats"]')).toContain('Top chat');
    expect(text('[aria-label="Projects"]')).toContain('Trip');
    expect(text('[aria-label="Projects"]')).toContain('Planning');
    // Chat workspaces never appear among the directory workspaces.
    const workspaces = text('nav.workspace-list');
    expect(workspaces).toContain('Project');
    expect(workspaces).toContain('Alpha');
    expect(workspaces).not.toContain('Trip');
    expect(workspaces).not.toContain('Top chat');
    target.querySelector<HTMLButtonElement>('[aria-label="New project"]')!.click();
    expect(handlers.onaddproject).toHaveBeenCalledWith('home');
    target.querySelector<HTMLButtonElement>('[aria-label="New chat in Trip"]')!.click();
    expect(handlers.onnew).toHaveBeenLastCalledWith('home:trip');
  });
});
