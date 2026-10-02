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
  onopenworkspace: vi.fn(),
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
  app.memoryProposals = [];
  app.missedRuns = [];
  app.schedules = [];
  app.mode = 'chat';
  app.view = 'session';
  app.workspaceViewId = undefined;
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

function render(props: { open?: boolean } = {}) {
  const reactive = reactiveProps({ open: false, ...props, ...handlers });
  component = mount(Sidebar, { target, props: reactive });
  flushSync();
  return reactive;
}

const names = () =>
  Array.from(target.querySelectorAll('.session-card .session-name')).map(
    (item) => item.textContent,
  );

describe('Sidebar', () => {
  const chatWorkspaces = () => {
    app.nodes = [{ id: 'node' } as never, { id: 'home' } as never];
    app.workspaces = [
      { id: 'node:ws', hostId: 'node', displayName: 'Project' } as never,
      { id: 'home:chats', hostId: 'home', displayName: 'Chats', kind: 'chat' } as never,
      { id: 'home:trip', hostId: 'home', displayName: 'Trip', kind: 'chat' } as never,
    ];
  };
  const text = (selector: string) => target.querySelector(selector)?.textContent ?? '';
  const namesIn = (label: string) =>
    Array.from(target.querySelectorAll(`[aria-label="${label}"] .session-name`)).map(
      (item) => item.textContent,
    );

  it('shows workspaces as rows that open their page, with only unread and open sessions under them', () => {
    app.sessions = [
      session('a', 'Alpha'),
      session('n', 'Newer', { unread: true }),
      session('r', 'Runner', { runStatus: 'running', writeLease: true }),
      session('w', 'Waiter', { runStatus: 'waiting_input', unread: true }),
    ];
    render();
    // Waiting sessions are under "Needs you", not again under their workspace.
    expect(namesIn('node')).toEqual(['Alpha', 'Newer']);
    const row = target.querySelector('[aria-label="node"] .workspace-heading')!;
    expect(row.textContent).toContain('Project');
    expect(row.querySelector('.running-count')?.textContent).toContain('1');
    expect(row.querySelector('.unread')?.textContent).toBe('2');
    expect(row.querySelector('[aria-label="A session holds the write lease"]')).not.toBeNull();
    row.querySelector<HTMLButtonElement>('button')!.click();
    expect(handlers.onopenworkspace).toHaveBeenCalledWith('node:ws');
    target.querySelector<HTMLButtonElement>('[aria-label="New session in Project"]')!.click();
    expect(handlers.onnew).toHaveBeenCalledWith('node:ws');
    target.querySelector<HTMLButtonElement>('[aria-label="Add workspace on node"]')!.click();
    expect(handlers.onaddworkspace).toHaveBeenCalledWith('node');
  });

  it('marks the page that is showing instead of the session behind it', () => {
    app.view = 'workspace';
    app.workspaceViewId = 'node:ws';
    render();
    const heading = target.querySelector('.workspace-heading')!;
    expect(heading.classList.contains('current')).toBe(true);
    expect(heading.querySelector('[aria-current="page"]')).not.toBeNull();
    // The open session is behind the page: nothing unread to list.
    expect(names()).toEqual([]);
    // New session goes straight into the workspace on screen.
    target.querySelector<HTMLButtonElement>('.new-session')!.click();
    expect(handlers.onnew).toHaveBeenCalledWith('node:ws');
  });

  it('answers sessions, missed runs and memory proposals under "Needs you"', () => {
    const decideMissed = vi.spyOn(app, 'decideMissed').mockResolvedValue();
    const decideProposal = vi.spyOn(app, 'decideProposal').mockResolvedValue();
    app.sessions = [session('w', 'Waiter', { runStatus: 'waiting_input' })];
    const schedule = { id: 's1', title: 'Backup', timezone: 'UTC' } as never;
    app.missedRuns = [{ schedule, run: { id: 'run1', dueAt: 0 } as never }];
    const proposal = { id: 'p1', action: 'add', content: 'Likes tea', target: null } as never;
    app.memoryProposals = [proposal];
    render();
    const buttons = (kind: string) =>
      Array.from(target.querySelectorAll<HTMLButtonElement>(`[data-kind="${kind}"] .pill-button`));
    buttons('session')[0]!.click();
    expect(handlers.onselect).toHaveBeenCalledWith('w');
    expect(buttons('missed').map((b) => b.textContent)).toEqual(['Allow & run', 'Dismiss']);
    buttons('missed')[0]!.click();
    expect(decideMissed).toHaveBeenCalledWith('s1', 'run1', true);
    buttons('memory')[1]!.click();
    expect(decideProposal).toHaveBeenCalledWith(proposal, false);
  });

  it('searches every session of the mode, whatever its workspace', () => {
    render();
    const search = target.querySelector<HTMLInputElement>('.search input')!;
    search.value = 'a';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    expect(namesIn('Search results')).toEqual(['Alpha', 'Beta', 'Gamma']);
    expect(target.querySelector('.workspace-heading')).toBeNull();
    search.value = 'alp';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    expect(namesIn('Search results')).toEqual(['Alpha']);
  });

  it('selects a session and marks the open one as current', () => {
    app.sessions = [session('a', 'Alpha'), session('b', 'Beta', { unread: true, pinned: true })];
    render();
    expect(names()).toEqual(['Beta', 'Alpha']);
    const cards = target.querySelectorAll<HTMLButtonElement>('.session-card');
    expect(cards[1]!.getAttribute('aria-current')).toBe('page');
    expect(cards[0]!.querySelector('[aria-label="Unread"]')).not.toBeNull();
    cards[0]!.click();
    expect(handlers.onselect).toHaveBeenCalledWith('b');
  });

  it('reveals row actions of another session through its "more" button', () => {
    const update = vi.spyOn(app, 'updateSession').mockResolvedValue();
    app.sessions = [session('a', 'Alpha'), session('b', 'Beta', { unread: true, pinned: true })];
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
    const card = target.querySelector<HTMLButtonElement>('.session-card')!;
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

  it('opens the schedules page and settings from the footer', () => {
    const onschedules = vi.fn();
    const reactive = reactiveProps({ open: false, ...handlers, onschedules });
    component = mount(Sidebar, { target, props: reactive });
    flushSync();
    target.querySelector<HTMLButtonElement>('.schedules-entry')!.click();
    expect(onschedules).toHaveBeenCalled();
    target.querySelector<HTMLButtonElement>('.settings-entry:not(.schedules-entry)')!.click();
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

  it('lists projects as rows and top-level chats when a chat node is connected', () => {
    chatWorkspaces();
    app.sessions = [
      session('a', 'Alpha', { unread: true }),
      session('t', 'Top chat', { workspaceId: 'home:chats' }),
      session('d', 'Done chat', { workspaceId: 'home:chats', settled: true }),
      session('p', 'Planning', { workspaceId: 'home:trip' }),
      session('u', 'Packing', { workspaceId: 'home:trip', unread: true }),
    ];
    render();
    // New chat opens a top-level chat right away, like ChatGPT's.
    const button = target.querySelector<HTMLButtonElement>('.new-session')!;
    expect(button.textContent).toContain('New chat');
    button.click();
    expect(handlers.onnew).toHaveBeenCalledWith('home:chats');
    expect(namesIn('Chats')).toEqual(['Top chat']);
    // A project is one row; only its unread chat shows under it.
    expect(text('[aria-label="Projects"]')).toContain('Trip');
    expect(namesIn('Projects')).toEqual(['Packing']);
    // Chat mode shows no work sessions.
    expect(names()).not.toContain('Alpha');
    target
      .querySelector<HTMLButtonElement>('[aria-label="Projects"] .workspace-heading button')!
      .click();
    expect(handlers.onopenworkspace).toHaveBeenCalledWith('home:trip');
    target.querySelector<HTMLButtonElement>('[aria-label="All chats and their settings"]')!.click();
    expect(handlers.onopenworkspace).toHaveBeenLastCalledWith('home:chats');
    target.querySelector<HTMLButtonElement>('[aria-label="New project"]')!.click();
    expect(handlers.onaddproject).toHaveBeenCalledWith('home');
    target.querySelector<HTMLButtonElement>('[aria-label="New chat in Trip"]')!.click();
    expect(handlers.onnew).toHaveBeenLastCalledWith('home:trip');
    // Work lists the directory workspaces, never chats.
    Array.from(target.querySelectorAll<HTMLButtonElement>('.mode-switch button'))
      .find((button) => button.textContent?.includes('Work'))!
      .click();
    flushSync();
    expect(app.mode).toBe('work');
    expect(target.querySelector('[aria-label="home"]')).toBeNull();
    expect(names()).toEqual(['Alpha']);
  });
});
