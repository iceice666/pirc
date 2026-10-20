// @vitest-environment jsdom
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../app.svelte';
import { demoModes } from '../mock';
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
  app.modeCatalog = [];
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
    expect(row.querySelector('.unread-count')?.textContent).toBe('2');
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

  it('answers sessions under "Needs you"', () => {
    app.sessions = [session('w', 'Waiter', { runStatus: 'waiting_input' })];
    render();
    const buttons = Array.from(
      target.querySelectorAll<HTMLButtonElement>('[data-kind="session"] .pill-button'),
    );
    expect(buttons.map((b) => b.textContent)).toEqual(['Reply']);
    buttons[0]!.click();
    expect(handlers.onselect).toHaveBeenCalledWith('w');
  });

  it('allows or denies a delegated session\'s relayed confirm from "Needs you"', () => {
    const answerApproval = vi.spyOn(app, 'answerApproval').mockResolvedValue();
    const approval = {
      sessionId: 'chat',
      interactionId: 'relay.d1.interaction_1',
      title: 'Allow network access?',
      message: 'curl example.com',
    };
    app.sessions = [
      session('w', 'Worker', {
        runStatus: 'waiting_input',
        origin: {
          kind: 'delegation',
          delegationId: 'd1',
          title: 'Fix the tests',
          fromSessionId: 'chat',
          status: 'waiting_input',
          approval,
        },
      }),
    ];
    render();
    const row = target.querySelector('[data-kind="session"]')!;
    expect(row.textContent).toContain('Allow network access?');
    const buttons = Array.from(row.querySelectorAll<HTMLButtonElement>('.pill-button'));
    expect(buttons.map((b) => b.textContent)).toEqual(['Allow', 'Deny', 'Reply']);
    buttons[0]!.click();
    expect(answerApproval).toHaveBeenCalledWith(approval, true);
    buttons[1]!.click();
    expect(answerApproval).toHaveBeenCalledWith(approval, false);
    buttons[2]!.click();
    expect(handlers.onselect).toHaveBeenCalledWith('w');
  });

  it('searches every session, whatever its workspace', () => {
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

  it('opens settings from the footer', () => {
    render();
    target.querySelector<HTMLButtonElement>('.settings-entry')!.click();
    expect(handlers.onsettings).toHaveBeenCalled();
  });

  it('starts new sessions from a dialog outside a workspace page', () => {
    render();
    const button = target.querySelector<HTMLButtonElement>('.new-session')!;
    expect(button.textContent).toContain('New session');
    button.click();
    expect(handlers.onnew).toHaveBeenCalledWith();
  });

  describe('with the mode catalog', () => {
    beforeEach(() => {
      app.modeCatalog = demoModes;
      app.nodes = [
        { id: 'node', modes: ['directory', 'scratch'] } as never,
        // Accepts no mode the catalog knows: no workspaces there.
        { id: 'lab', modes: ['unknown'] } as never,
      ];
      app.workspaces = [
        { id: 'node:ws', hostId: 'node', displayName: 'Project', mode: 'directory' },
        { id: 'node:gpu', hostId: 'node', displayName: 'GPU jobs', mode: 'scratch' },
        // Its mode left the catalog.
        { id: 'node:old', hostId: 'node', displayName: 'Old', mode: 'review', available: false },
      ].map((workspace) => ({ defaults: {}, ...workspace })) as never;
      app.sessions = [
        session('g', 'Render image', { workspaceId: 'node:gpu', unread: true }),
        session('o', 'Old review', { workspaceId: 'node:old', unread: true }),
      ];
    });

    it('lists every workspace under its node', () => {
      render();
      const node = text('[aria-label="node"]');
      expect(node).toContain('Project');
      expect(node).toContain('GPU jobs');
      expect(node).toContain('Old');
      expect(node).toContain('read-only');
      // Nodes accepting no known mode host no workspaces.
      expect(target.querySelector('[aria-label="lab"]')).toBeNull();
      const gpu = target.querySelector<HTMLButtonElement>(
        '[aria-label="New session in GPU jobs"]',
      )!;
      expect(gpu.disabled).toBe(false);
      gpu.click();
      expect(handlers.onnew).toHaveBeenCalledWith('node:gpu');
      // An unavailable mode takes no new sessions.
      expect(
        target.querySelector<HTMLButtonElement>('[aria-label="New session in Old"]')!.disabled,
      ).toBe(true);
      // Sessions are settled, not deleted.
      expect(namesIn('node')).toContain('Render image');
      expect(target.querySelector('[aria-label="Delete Render image"]')).toBeNull();
    });

    it('searches the sessions of every workspace', () => {
      render();
      const input = target.querySelector<HTMLInputElement>('.search input')!;
      // Every name has a space.
      input.value = ' ';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      flushSync();
      expect(namesIn('Search results')).toEqual(['Render image', 'Old review']);
    });
  });
});
