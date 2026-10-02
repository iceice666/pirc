// @vitest-environment jsdom
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../app.svelte';
import { reactiveProps } from '../testing/props.svelte';
import type { SessionSummary, Workspace } from '../types';
import WorkspacePage from './WorkspacePage.svelte';

const session = (id: string, name: string, extra: Partial<SessionSummary> = {}) => ({
  id,
  workspaceId: 'node:ws',
  name,
  lastActivityAt: new Date().toISOString(),
  runnerStatus: 'ready' as const,
  ...extra,
});
const directory: Workspace = {
  id: 'node:ws',
  hostId: 'node',
  displayName: 'Code',
  defaults: { modelId: 'gpt-x' },
};
const project: Workspace = {
  id: 'home:trip',
  hostId: 'home',
  displayName: 'Trip',
  kind: 'chat',
  defaults: {},
};

let component: ReturnType<typeof mount> | undefined;
let target: HTMLDivElement;
const onselect = vi.fn();
const onnew = vi.fn();

beforeEach(() => {
  app.demo = undefined;
  app.nodes = [{ id: 'node' } as never, { id: 'home' } as never];
  app.workspaces = [directory, project];
  app.sessions = [
    session('a', 'Alpha', { unread: true }),
    session('b', 'Beta', { pinned: true, writeLease: true }),
    session('c', 'Gamma', { settled: true }),
    session('o', 'Elsewhere', { workspaceId: 'home:trip' }),
  ];
  target = document.createElement('div');
  document.body.append(target);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      String(url).endsWith('/instructions')
        ? new Response(JSON.stringify({ instructions: { text: 'Be brief', maxChars: 8000 } }))
        : new Response(
            JSON.stringify({
              capabilities: {
                version: 1,
                delegation: true,
                memory_search: true,
                remote_recall: true,
                schedules: true,
                web_search: true,
              },
            }),
          ),
    ),
  );
});
afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  target.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  onselect.mockReset();
  onnew.mockReset();
});

function render(workspace: Workspace, showSettled = false) {
  const props = reactiveProps({ workspace, showSettled, onselect, onnew });
  component = mount(WorkspacePage, { target, props });
  flushSync();
  return props;
}
const names = () =>
  Array.from(target.querySelectorAll('.row-name')).map((item) => item.textContent);
const tab = (label: string) =>
  Array.from(target.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find((item) =>
    item.textContent?.startsWith(label),
  )!;
async function flush() {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
    await tick();
  }
}

describe('WorkspacePage', () => {
  it('lists every session of the workspace, pinned first, with done ones behind a toggle', () => {
    render(directory);
    expect(target.querySelector('h1')!.textContent).toBe('Code');
    expect(names()).toEqual(['Beta', 'Alpha']);
    expect(tab('Sessions').querySelector('.tab-count')!.textContent).toBe('1');
    const toggle = target.querySelector<HTMLButtonElement>('.done-toggle')!;
    expect(toggle.textContent).toContain('Show done · 1');
    toggle.click();
    flushSync();
    expect(names()).toEqual(['Beta', 'Alpha', 'Gamma']);
    target.querySelectorAll<HTMLButtonElement>('.row-main')[1]!.click();
    expect(onselect).toHaveBeenCalledWith('a');
    target.querySelector<HTMLButtonElement>('.new-in')!.click();
    expect(onnew).toHaveBeenCalledWith('node:ws');
  });

  it('starts with done sessions shown when Settings says so, and searches', () => {
    render(directory, true);
    expect(names()).toEqual(['Beta', 'Alpha', 'Gamma']);
    const search = target.querySelector<HTMLInputElement>('.search input')!;
    search.value = 'gam';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    expect(names()).toEqual(['Gamma']);
  });

  it('folds the runs of one schedule into a row that expands', () => {
    const origin = { kind: 'schedule' as const, scheduleId: 's1', title: 'Digest', dueAt: 0 };
    app.sessions = [
      session('x', 'Digest #2', { origin, unread: true }),
      session('a', 'Alpha'),
      session('y', 'Digest #1', { origin }),
    ];
    render(directory);
    expect(names()).toEqual(['Digest', 'Alpha']);
    const fold = target.querySelector<HTMLButtonElement>('.fold .row-main')!;
    expect(fold.textContent).toContain('2 runs');
    fold.click();
    flushSync();
    expect(names()).toEqual(['Digest', 'Digest #2', 'Digest #1', 'Alpha']);
  });

  it('pins, settles and renames from the list', async () => {
    const update = vi.spyOn(app, 'updateSession').mockResolvedValue();
    render(directory);
    target.querySelector<HTMLButtonElement>('[aria-label="Settle Alpha"]')!.click();
    expect(update).toHaveBeenCalledWith('a', { settled: true });
    target.querySelector<HTMLButtonElement>('[aria-label="Rename Alpha"]')!.click();
    await tick();
    flushSync();
    const input = target.querySelector<HTMLInputElement>('.row-rename input')!;
    input.value = 'Renamed';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    flushSync();
    expect(update).toHaveBeenCalledWith('a', { name: 'Renamed' });
  });

  it("shows a directory workspace's facts under Settings", () => {
    render(directory);
    tab('Settings').click();
    flushSync();
    const facts = target.querySelector('.facts')!.textContent!;
    expect(facts).toContain('node · online');
    expect(facts).toContain('Held by “Beta”');
    expect(facts).toContain('gpt-x');
    expect(target.querySelector('textarea')).toBeNull();
  });

  it("edits a chat project's instructions and capabilities under Settings", async () => {
    const props = render(project);
    expect(tab('Chats')).toBeDefined();
    expect(names()).toEqual(['Elsewhere']);
    tab('Settings').click();
    flushSync();
    await flush();
    expect(fetch).toHaveBeenCalledWith(
      '/api/workspaces/home%3Atrip/instructions',
      expect.anything(),
    );
    expect(fetch).toHaveBeenCalledWith(
      '/api/workspaces/home%3Atrip/capabilities',
      expect.anything(),
    );
    expect(target.querySelector('textarea')!.value).toBe('Be brief');
    expect(target.querySelectorAll('[role="switch"]')).toHaveLength(5);
    // Another page starts on its list again.
    props.workspace = directory;
    flushSync();
    expect(tab('Sessions').getAttribute('aria-selected')).toBe('true');
  });
});
