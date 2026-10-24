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
const project: Workspace = {
  id: 'home:trip',
  hostId: 'home',
  displayName: 'Trip',
  kind: 'chat',
  defaults: {},
};

/** Scratch: one directory per session, no repository; legacy `kind` says chat. */
const scratch: Workspace = {
  id: 'node:gpu',
  hostId: 'node',
  displayName: 'GPU jobs',
  kind: 'chat',
  mode: 'scratch',
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
        : String(url).endsWith('/links')
          ? new Response(JSON.stringify({ links: [] }))
          : String(url).endsWith('/files')
            ? new Response(JSON.stringify({ files: [], maxFiles: 50, maxBytes: 1024 }))
            : String(url).endsWith('/project-config')
              ? new Response(
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
                )
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

  it("shows a directory workspace's facts and project config under Settings", async () => {
    render(directory);
    tab('Settings').click();
    flushSync();
    const facts = target.querySelector('.facts')!.textContent!;
    expect(facts).toContain('node · online');
    expect(facts).toContain('Held by “Beta”');
    expect(facts).toContain('gpt-x');
    expect(target.querySelector('textarea')).toBeNull();
    await flush();
    expect(fetch).toHaveBeenCalledWith(
      '/api/workspaces/node%3Aws/project-config',
      expect.anything(),
    );
    expect(target.textContent).toContain('make setup');
    expect(target.textContent).toContain('Not trusted');
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
    expect(fetch).toHaveBeenCalledWith('/api/workspaces/home%3Atrip/links', expect.anything());
    expect(fetch).toHaveBeenCalledWith('/api/workspaces/home%3Atrip/files', expect.anything());
    expect(target.textContent).toContain('Project files');
    expect(target.querySelector('textarea')!.value).toBe('Be brief');
    expect(target.querySelectorAll('[role="switch"]')).toHaveLength(5);
    // The directory workspaces it can be linked to.
    const choices = [...target.querySelectorAll('.link-choice')].map((item) => item.textContent);
    expect(choices).toHaveLength(1);
    expect(choices[0]).toContain(directory.displayName);
    // Another page starts on its list again.
    props.workspace = directory;
    flushSync();
    expect(tab('Sessions').getAttribute('aria-selected')).toBe('true');
  });

  it('offers to finish a deletion that did not finish, and nothing else', () => {
    render({ ...project, deleting: true });
    const buttons = [...target.querySelectorAll('button')];
    expect(buttons.find((item) => item.textContent?.includes('Finish deleting'))?.disabled).toBe(
      false,
    );
    expect(buttons.find((item) => item.textContent?.includes('New chat'))?.disabled).toBe(true);
    tab('Settings').click();
    flushSync();
    expect(target.textContent).toContain('Settings are gone');
    expect(target.querySelector('textarea')).toBeNull();
  });

  it('offers to delete a chat project, not the top-level chats or a directory', async () => {
    const deleteButton = () =>
      [...target.querySelectorAll('button')].find((item) =>
        item.textContent?.includes('Delete project…'),
      );
    const props = render(project);
    tab('Settings').click();
    flushSync();
    await flush();
    expect(deleteButton()?.disabled).toBe(false);
    props.workspace = { ...project, id: 'home:chats', displayName: 'Chats' };
    flushSync();
    tab('Settings').click();
    flushSync();
    expect(deleteButton()).toBeUndefined();
    props.workspace = directory;
    flushSync();
    tab('Settings').click();
    flushSync();
    expect(deleteButton()).toBeUndefined();
  });

  it('offers non-destructive removal for Work workspaces, requires an online device, and excludes chat projects', async () => {
    const props = render(directory);
    const removeButton = () =>
      [...target.querySelectorAll('button')].find((item) =>
        item.textContent?.includes('Remove workspace…'),
      );
    tab('Settings').click();
    flushSync();
    expect(removeButton()?.disabled).toBe(false);
    app.nodes = [];
    flushSync();
    expect(removeButton()?.disabled).toBe(true);
    expect(target.textContent).toContain('Connect the device to verify');
    app.nodes = [{ id: 'node' } as never];
    props.workspace = { ...directory, available: false };
    flushSync();
    tab('Settings').click();
    flushSync();
    expect(removeButton()?.disabled).toBe(false);
    props.workspace = { ...project, mode: 'chat', available: false };
    flushSync();
    tab('Settings').click();
    flushSync();
    expect(removeButton()).toBeUndefined();
    props.workspace = project;
    flushSync();
    tab('Settings').click();
    flushSync();
    expect(removeButton()).toBeUndefined();
    props.workspace = { ...project, id: 'home:chats', available: false };
    flushSync();
    tab('Settings').click();
    flushSync();
    expect(removeButton()).toBeUndefined();
    await flush();
  });

  it('opens a named removal confirmation from workspace Settings and Cancel makes no request', () => {
    HTMLDialogElement.prototype.showModal = function () {
      this.open = true;
    };
    HTMLDialogElement.prototype.close = function () {
      this.open = false;
      this.dispatchEvent(new Event('close'));
    };
    const remove = vi.spyOn(app, 'removeWorkspace').mockResolvedValue();
    render(directory);
    tab('Settings').click();
    flushSync();
    [...target.querySelectorAll('button')]
      .find((b) => b.textContent?.includes('Remove workspace…'))!
      .click();
    flushSync();
    const dialog = target.querySelector<HTMLDialogElement>(
      '[aria-labelledby="remove-workspace-title"]',
    )!;
    expect(dialog.open).toBe(true);
    expect(dialog.textContent).toContain('Remove “Code” from pirc?');
    [...dialog.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Cancel')!.click();
    flushSync();
    expect(dialog.open).toBe(false);
    expect(remove).not.toHaveBeenCalled();
  });

  it("shows a scratch workspace's capabilities only, whatever its legacy kind", async () => {
    app.modeCatalog = demoModes;
    app.workspaces = [directory, project, scratch];
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
    expect(target.querySelector('textarea')).toBeNull();
    expect(target.textContent).not.toContain('Delete project');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('links a project to every workspace that takes delegated work', async () => {
    app.modeCatalog = demoModes;
    app.workspaces = [{ ...directory, mode: 'directory' }, { ...project, mode: 'chat' }, scratch];
    render({ ...project, mode: 'chat' });
    tab('Settings').click();
    flushSync();
    await flush();
    const choices = [...target.querySelectorAll('.link-choice')].map((item) => item.textContent);
    expect(choices).toHaveLength(2);
    expect(choices.join()).toContain('GPU jobs');
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
