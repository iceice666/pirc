// @vitest-environment jsdom
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../../app.svelte';
import { demoModes } from '../../mock';
import type { Workspace } from '../../types';
import NewWorkspaceDialog from './NewWorkspaceDialog.svelte';

let component: ReturnType<typeof mount> | undefined;
let target: HTMLDivElement;
const oncreated = vi.fn();

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
  app.workspaces = [
    { id: 'home:chats', hostId: 'home', displayName: 'Chats', kind: 'chat', mode: 'chat' },
  ] as Workspace[];
  target = document.createElement('div');
  document.body.append(target);
});
afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  target.remove();
  app.modeCatalog = [];
  app.nodes = [];
  app.workspaces = [];
  oncreated.mockReset();
  vi.restoreAllMocks();
});

function show(nodeId: string) {
  component = mount(NewWorkspaceDialog, { target, props: { open: true, nodeId, oncreated } });
  flushSync();
}
const field = (label: string) =>
  [...target.querySelectorAll('label')]
    .find((item) => item.querySelector('span')?.textContent === label)
    ?.querySelector<HTMLInputElement & HTMLSelectElement>('input, select');
function type(label: string, value: string) {
  const input = field(label)!;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
}
const addButton = () =>
  [...target.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent === 'Add workspace',
  )!;
const options = (label: string) =>
  [...(field(label)?.querySelectorAll('option') ?? [])].map((item) => item.value);

describe('NewWorkspaceDialog', () => {
  it("offers the node's Work modes and asks for a path only for a workspace directory", async () => {
    app.modeCatalog = demoModes;
    app.nodes = [
      { id: 'home', modes: ['chat'] } as never,
      { id: 'gpu', modes: ['chat', 'directory', 'scratch'] } as never,
    ];
    const create = vi
      .spyOn(app, 'createWorkspace')
      .mockResolvedValue({ id: 'gpu:jobs' } as Workspace);
    show('gpu');
    // The chat-only node hosts no Work workspaces; the assistant's mode is not offered.
    expect(options('Device')).toEqual(['gpu']);
    expect(options('Mode')).toEqual(['directory', 'scratch']);
    // A repository mode first: it asks for an existing directory.
    expect(field('Mode')!.value).toBe('directory');
    expect(field('Existing directory on that device')).toBeDefined();

    const mode = field('Mode')!;
    mode.value = 'scratch';
    mode.dispatchEvent(new Event('change', { bubbles: true }));
    flushSync();
    expect(field('Existing directory on that device')).toBeUndefined();
    expect(target.textContent).toContain('Each session gets its own new directory');
    type('Workspace name', 'GPU jobs');
    expect(addButton().disabled).toBe(false);
    addButton().click();
    await tick();
    expect(create).toHaveBeenCalledWith({
      nodeId: 'gpu',
      mode: 'scratch',
      displayName: 'GPU jobs',
    });
    expect(oncreated).toHaveBeenCalledWith('gpu:jobs');
  });

  it('hides the mode choice with one Work mode and sends it with the path', async () => {
    app.modeCatalog = demoModes;
    app.nodes = [{ id: 'work', modes: ['directory'] } as never];
    const create = vi
      .spyOn(app, 'createWorkspace')
      .mockResolvedValue({ id: 'work:pirc' } as Workspace);
    show('work');
    expect(field('Mode')).toBeUndefined();
    type('Workspace name', 'pirc');
    expect(addButton().disabled).toBe(true);
    type('Existing directory on that device', '~/code/pirc');
    addButton().click();
    await tick();
    expect(create).toHaveBeenCalledWith({
      nodeId: 'work',
      mode: 'directory',
      displayName: 'pirc',
      path: '~/code/pirc',
    });
  });

  it('keeps the path-only request for an older gateway', async () => {
    app.nodes = [{ id: 'home' } as never, { id: 'work' } as never];
    const create = vi
      .spyOn(app, 'createWorkspace')
      .mockResolvedValue({ id: 'work:pirc' } as Workspace);
    show('work');
    // The chat node (hosting the top-level chats) is left out.
    expect(options('Device')).toEqual(['work']);
    expect(field('Mode')).toBeUndefined();
    type('Workspace name', 'pirc');
    type('Existing directory on that device', '~/code/pirc');
    addButton().click();
    await tick();
    expect(create).toHaveBeenCalledWith({
      nodeId: 'work',
      path: '~/code/pirc',
      displayName: 'pirc',
    });
  });
});
