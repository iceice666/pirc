// @vitest-environment jsdom
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { engine } from '../engine.svelte';
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
  onaddworkspace: vi.fn(),
  onopenworkspace: vi.fn(),
  onclose: vi.fn(),
  onsettings: vi.fn(),
  onoverview: vi.fn(),
};

beforeEach(() => {
  engine.nodes = [{ id: 'node' } as never];
  engine.workspaces = [{ id: 'node:ws', hostId: 'node', displayName: 'Project' } as never];
  engine.sessions = [session('a', 'Alpha'), session('b', 'Beta'), session('c', 'Gamma')];
  engine.activeSessionId = 'a';
  engine.view = 'session';
  engine.workspaceViewId = undefined;
  target = document.createElement('div');
  document.body.append(target);
});
afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  target.remove();
  vi.restoreAllMocks();
  engine.modeCatalog = [];
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
    engine.sessions = [
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
    // Sessions start when pirc hands work over, never from here.
    expect(target.querySelector('[aria-label="New session in Project"]')).toBeNull();
    target.querySelector<HTMLButtonElement>('[aria-label="Add workspace on node"]')!.click();
    expect(handlers.onaddworkspace).toHaveBeenCalledWith('node');
  });

  it('marks the page that is showing instead of the session behind it', () => {
    engine.view = 'workspace';
    engine.workspaceViewId = 'node:ws';
    render();
    const heading = target.querySelector('.workspace-heading')!;
    expect(heading.classList.contains('current')).toBe(true);
    expect(heading.querySelector('[aria-current="page"]')).not.toBeNull();
    // The open session is behind the page: nothing unread to list.
    expect(names()).toEqual([]);
  });

  it('answers sessions under "Needs you"', () => {
    engine.sessions = [session('w', 'Waiter', { runStatus: 'waiting_input' })];
    render();
    const buttons = Array.from(
      target.querySelectorAll<HTMLButtonElement>('[data-kind="session"] .pill-button'),
    );
    expect(buttons.map((b) => b.textContent)).toEqual(['Reply']);
    buttons[0]!.click();
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
    engine.sessions = [session('a', 'Alpha'), session('b', 'Beta', { unread: true })];
    render();
    expect(names()).toEqual(['Alpha', 'Beta']);
    const cards = target.querySelectorAll<HTMLButtonElement>('.session-card');
    expect(cards[0]!.getAttribute('aria-current')).toBe('page');
    expect(cards[1]!.querySelector('[aria-label="Unread"]')).not.toBeNull();
    cards[1]!.click();
    expect(handlers.onselect).toHaveBeenCalledWith('b');
  });

  it('reveals the rename of another session through its "more" button', async () => {
    const update = vi.spyOn(engine, 'renameSession').mockResolvedValue();
    engine.sessions = [session('a', 'Alpha'), session('b', 'Beta', { unread: true })];
    render();
    // The open session needs no "more" button; the other row has one.
    expect(target.querySelector('[aria-label="Actions for Alpha"]')).toBeNull();
    const more = target.querySelector<HTMLButtonElement>('[aria-label="Actions for Beta"]')!;
    more.click();
    flushSync();
    const row = target.querySelector('[aria-label="Rename Beta"]')!.closest('.session-item')!;
    expect(row.classList.contains('revealed')).toBe(true);
    expect(target.querySelector('[aria-label="Actions for Beta"]')).toBeNull();
    // Nothing to pin or settle.
    expect(target.querySelector('[aria-label="Pin Beta"], [aria-label="Settle Beta"]')).toBeNull();
    target.querySelector<HTMLButtonElement>('[aria-label="Rename Beta"]')!.click();
    await tick();
    flushSync();
    expect(target.querySelector('.session-rename input')).not.toBeNull();
    expect(update).not.toHaveBeenCalled();
  });

  it('renames with F2 and Enter', async () => {
    const update = vi.spyOn(engine, 'renameSession').mockResolvedValue();
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
    expect(update).toHaveBeenCalledWith('a', 'Renamed');
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
    target.querySelector<HTMLButtonElement>('button.settings-entry')!.click();
    expect(handlers.onsettings).toHaveBeenCalled();
  });

  it('leads to the engine’s front page, marked while it shows', () => {
    render();
    const button = target.querySelector<HTMLButtonElement>('.overview-entry')!;
    expect(button.textContent).toContain('Overview');
    expect(button.getAttribute('aria-current')).toBeNull();
    button.click();
    expect(handlers.onoverview).toHaveBeenCalled();
    unmount(component!);
    engine.view = 'overview';
    render();
    expect(target.querySelector('.overview-entry')!.getAttribute('aria-current')).toBe('page');
  });

  describe('with the mode catalog', () => {
    beforeEach(() => {
      engine.modeCatalog = demoModes;
      engine.nodes = [
        { id: 'node', modes: ['directory', 'scratch'] } as never,
        // Accepts no mode the catalog knows: no workspaces there.
        { id: 'lab', modes: ['unknown'] } as never,
      ];
      engine.workspaces = [
        { id: 'node:ws', hostId: 'node', displayName: 'Project', mode: 'directory' },
        { id: 'node:gpu', hostId: 'node', displayName: 'GPU jobs', mode: 'scratch' },
        // Its mode left the catalog.
        { id: 'node:old', hostId: 'node', displayName: 'Old', mode: 'review', available: false },
      ].map((workspace) => ({ defaults: {}, ...workspace })) as never;
      engine.sessions = [
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
      // Sessions are kept, never deleted.
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
