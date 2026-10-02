// @vitest-environment jsdom
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { app } from '../../app.svelte';
import type { SessionSummary } from '../../types';
import DeleteChatDialog from './DeleteChatDialog.svelte';

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
  target?.remove();
  vi.restoreAllMocks();
});
function show() {
  component = mount(DeleteChatDialog, {
    target,
    props: {
      session: {
        id: 'source-chat',
        name: 'Travel plans',
        workspaceId: 'chat:chats',
        lastActivityAt: '',
        runnerStatus: 'stopped',
      } satisfies SessionSummary,
    },
  });
  flushSync();
}
const button = (label: string) =>
  [...target.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)!;
it('warns about source memories in the same confirmation and Cancel deletes nothing', () => {
  const remove = vi.spyOn(app, 'deleteSession').mockResolvedValue();
  show();
  expect(target.querySelector('dialog')!.open).toBe(true);
  expect(target.textContent).toContain('USER memories and MEMORY notes created by this chat');
  expect(target.textContent).toContain('Memories created by other chats are kept');
  button('Cancel').click();
  flushSync();
  expect(remove).not.toHaveBeenCalled();
  expect(target.querySelector('dialog')!.open).toBe(false);
});
it('shows a failed deletion in the same dialog and allows a single retry', async () => {
  const remove = vi
    .spyOn(app, 'deleteSession')
    .mockRejectedValueOnce(new Error('Chat node is offline'))
    .mockResolvedValue();
  show();
  button('Delete chat and memories').click();
  flushSync();
  await vi.waitFor(() => {
    flushSync();
    expect(target.querySelector('[role="alert"]')?.textContent).toContain('Chat node is offline');
  });
  button('Delete chat and memories').click();
  button('Delete chat and memories').click();
  await vi.waitFor(() => {
    flushSync();
    expect(target.querySelector('dialog')!.open).toBe(false);
  });
  expect(remove).toHaveBeenCalledTimes(2);
  expect(remove).toHaveBeenLastCalledWith('source-chat');
});
