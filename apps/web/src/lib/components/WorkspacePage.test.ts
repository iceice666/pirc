// @vitest-environment jsdom
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../app.svelte';
import { demoModes } from '../mock';
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
/** Scratch: one directory per session, no repository. */
const scratch: Workspace = {
  id: 'node:gpu',
  hostId: 'node',
  displayName: 'GPU jobs',
  mode: 'scratch',
  defaults: {},
};

let component: ReturnType<typeof mount> | undefined;
let target: HTMLDivElement;
const onselect = vi.fn();
const onnew = vi.fn();

beforeEach(() => {
  app.demo = undefined;
  app.nodes = [{ id: 'node' } as never];
  app.workspaces = [directory];
  app.sessions = [
    session('a', 'Alpha', { unread: true }),
    session('b', 'Beta', { pinned: true, writeLease: true }),
    session('c', 'Gamma', { settled: true }),
    session('o', 'Elsewhere', { workspaceId: 'node:gpu' }),
  ];
  target = document.createElement('div');
  document.body.append(target);
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            project: {
              hooks: { sessionStart: [{ command: 'make setup', timeoutMs: 10000 }] },
              env: {},
              allowedPaths: [],
              hash: 'a'.repeat(64),
              trustedHash: null,
              trusted: false,
              empty: false,
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
  app.modeCatalog = [];
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

  it("shows a directory workspace's facts and project config under Settings", async () => {
    const props = render(directory);
    tab('Settings').click();
    flushSync();
    const facts = target.querySelector('.facts')!.textContent!;
    expect(facts).toContain('node · online');
    expect(facts).toContain('Held by “Beta”');
    expect(facts).toContain('gpt-x');
    await flush();
    expect(fetch).toHaveBeenCalledWith(
      '/api/workspaces/node%3Aws/project-config',
      expect.anything(),
    );
    expect(target.textContent).toContain('make setup');
    expect(target.textContent).toContain('Not trusted');
    // Another page starts on its list again.
    props.workspace = scratch;
    flushSync();
    expect(tab('Sessions').getAttribute('aria-selected')).toBe('true');
  });

  it("shows a scratch workspace's capabilities only", async () => {
    app.modeCatalog = demoModes;
    app.workspaces = [directory, scratch];
    app.sessions = [session('g', 'Render', { workspaceId: scratch.id })];
    render(scratch);
    expect(target.querySelector('.page-title small')!.textContent).toBe('Scratch · node');
    expect(tab('Sessions')).toBeDefined();
    expect(
      [...target.querySelectorAll('button')].some((item) =>
        item.textContent?.includes('New session'),
      ),
    ).toBe(true);
    // Its sessions are not deleted from the list.
    expect(target.querySelector('[aria-label="Delete Render"]')).toBeNull();
    tab('Settings').click();
    flushSync();
    await flush();
    const facts = target.querySelector('.facts')!.textContent!;
    expect(facts).toContain('node · online');
    // No shared directory: no write lease.
    expect(facts).not.toContain('Write lease');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps a workspace whose mode is gone read-only', async () => {
    app.modeCatalog = demoModes;
    const gone: Workspace = { ...directory, mode: 'review', available: false };
    render(gone);
    expect(target.querySelector('.page-title small')!.textContent).toContain('read-only');
    expect(target.textContent).toContain('no longer available');
    const create = [...target.querySelectorAll('button')].find((item) =>
      item.textContent?.includes('New session'),
    );
    expect(create?.disabled).toBe(true);
    tab('Settings').click();
    flushSync();
    await flush();
    expect(target.querySelector('.facts')).not.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});
