// @vitest-environment jsdom
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { app } from '../../app.svelte';
import type { Workspace } from '../../types';
import RemoveWorkspaceDialog from './RemoveWorkspaceDialog.svelte';

let component: ReturnType<typeof mount> | undefined;
let target: HTMLDivElement;
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
  target = document.createElement('div');
  document.body.append(target);
});
afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  target.remove();
  vi.restoreAllMocks();
});
function show() {
  component = mount(RemoveWorkspaceDialog, {
    target,
    props: {
      workspace: {
        id: 'node:repo',
        hostId: 'node',
        displayName: 'My repo',
        defaults: {},
      } satisfies Workspace,
    },
  });
  flushSync();
}
const button = (label: string) =>
  [...target.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)!;
it('explains retention and schedule pausing; Cancel removes nothing', () => {
  const remove = vi.spyOn(app, 'removeWorkspace').mockResolvedValue();
  show();
  expect(target.querySelector('dialog')!.open).toBe(true);
  expect(target.textContent).toContain('Remove “My repo” from pirc?');
  expect(target.textContent).toContain('pauses its schedules');
  expect(target.textContent).toContain('uploads and memories are not deleted');
  expect(target.textContent).toContain('same directory on the same device');
  button('Cancel').click();
  flushSync();
  expect(remove).not.toHaveBeenCalled();
  expect(target.querySelector('dialog')!.open).toBe(false);
});
it('shows backend errors and allows retry without duplicate submission', async () => {
  const remove = vi
    .spyOn(app, 'removeWorkspace')
    .mockRejectedValueOnce(new Error('Stop running sessions before removing this workspace'))
    .mockResolvedValue();
  show();
  button('Remove workspace').click();
  await vi.waitFor(() => {
    flushSync();
    expect(target.querySelector('[role="alert"]')?.textContent).toContain('Stop running sessions');
  });
  button('Remove workspace').click();
  button('Remove workspace').click();
  await vi.waitFor(() => {
    flushSync();
    expect(target.querySelector('dialog')!.open).toBe(false);
  });
  expect(remove).toHaveBeenCalledTimes(2);
  expect(remove).toHaveBeenLastCalledWith('node:repo');
});
