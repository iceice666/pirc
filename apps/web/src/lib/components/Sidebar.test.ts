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
  app.memoryProposals = [];
  app.missedRuns = [];
  app.schedules = [];
  app.mode = 'chat';
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
  it('lists pinned sessions first and hides done ones behind a toggle', () => {
    const props = render();
    expect(names()).toEqual(['Beta', 'Alpha']);
    const toggle = target.querySelector<HTMLButtonElement>('.heading-toggle')!;
    expect(toggle.textContent).toContain('Show done · 1');
    toggle.click();
    flushSync();
    expect(props.showSettled).toBe(true);
    expect(names()).toEqual(['Beta', 'Alpha', 'Gamma']);
  });

  it('groups work by state: needs you, running, then recent', () => {
    app.sessions = [
      session('a', 'Alpha'),
      session('r', 'Runner', { runStatus: 'running', writeLease: true }),
      session('w', 'Waiter', { runStatus: 'waiting_input' }),
    ];
    render();
    const section = (label: string) =>
      Array.from(
        target.querySelectorAll(
          `[aria-label="${label}"] .session-name, [aria-label="${label}"] .inbox-text strong`,
        ),
      ).map((item) => item.textContent);
    expect(section('Needs you')).toEqual(['Waiter']);
    expect(section('Running')).toEqual(['Runner']);
    expect(section('Recent')).toEqual(['Alpha']);
    // Only the session holding the write lease shows the lock.
    expect(target.querySelectorAll('[aria-label="Holds the write lease"]')).toHaveLength(1);
    target.querySelector<HTMLButtonElement>('.inbox-item .pill-button')!.click();
    expect(handlers.onselect).toHaveBeenCalledWith('w');
  });

  it('folds the runs of one schedule into a row that expands', () => {
    const origin = { kind: 'schedule' as const, scheduleId: 's1', title: 'Digest', dueAt: 0 };
    app.sessions = [
      session('x', 'Digest #2', { origin }),
      session('a', 'Alpha'),
      session('y', 'Digest #1', { origin }),
    ];
    app.activeSessionId = 'a';
    render();
    expect(names()).toEqual(['Digest', 'Alpha']);
    expect(target.querySelector('.fold-card')!.textContent).toContain('2 runs');
    target.querySelector<HTMLButtonElement>('.fold-card')!.click();
    flushSync();
    expect(names()).toEqual(['Digest', 'Digest #2', 'Digest #1', 'Alpha']);
  });

  it('answers missed runs and memory proposals under "Needs you"', () => {
    const decideMissed = vi.spyOn(app, 'decideMissed').mockResolvedValue();
    const decideProposal = vi.spyOn(app, 'decideProposal').mockResolvedValue();
    const schedule = { id: 's1', title: 'Backup', timezone: 'UTC' } as never;
    app.missedRuns = [{ schedule, run: { id: 'run1', dueAt: 0 } as never }];
    const proposal = { id: 'p1', action: 'add', content: 'Likes tea', target: null } as never;
    app.memoryProposals = [proposal];
    render();
    const buttons = (kind: string) =>
      Array.from(target.querySelectorAll<HTMLButtonElement>(`[data-kind="${kind}"] .pill-button`));
    expect(buttons('missed').map((b) => b.textContent)).toEqual(['Allow & run', 'Dismiss']);
    buttons('missed')[0]!.click();
    expect(decideMissed).toHaveBeenCalledWith('s1', 'run1', true);
    buttons('memory')[1]!.click();
    expect(decideProposal).toHaveBeenCalledWith(proposal, false);
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

  it('opens the schedules page and settings from the footer', () => {
    const onschedules = vi.fn();
    const reactive = reactiveProps({ open: false, showSettled: false, ...handlers, onschedules });
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
    // Chat mode shows no work sessions.
    expect(names()).not.toContain('Alpha');
    target.querySelector<HTMLButtonElement>('[aria-label="New project"]')!.click();
    expect(handlers.onaddproject).toHaveBeenCalledWith('home');
    target.querySelector<HTMLButtonElement>('[aria-label="New chat in Trip"]')!.click();
    expect(handlers.onnew).toHaveBeenLastCalledWith('home:trip');
    // Work lists the directory workspaces' sessions, never chats.
    Array.from(target.querySelectorAll<HTMLButtonElement>('.mode-switch button'))
      .find((button) => button.textContent?.includes('Work'))!
      .click();
    flushSync();
    expect(app.mode).toBe('work');
    expect(names()).toEqual(['Alpha']);
  });
});
