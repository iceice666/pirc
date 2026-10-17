// @vitest-environment jsdom
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { app } from '../../app.svelte';
import { ApiError } from '../../http';
import type { MemoryEntry } from '../../memory';
import { projectDeletionApi, type ProjectDeletionPreview } from '../../project-deletion';
import type { Workspace } from '../../types';
import DeleteProjectDialog from './DeleteProjectDialog.svelte';

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

const entry = (id: string, content: string, revision = 2): MemoryEntry => ({
  id,
  kind: 'note',
  content,
  status: 'active',
  revision,
  origins: ['assistant'],
  sources: {},
  createdAt: 0,
  updatedAt: 0,
});

function preview(overrides: Partial<ProjectDeletionPreview> = {}): ProjectDeletionPreview {
  return {
    project: { id: 'chat:trip', displayName: 'Trip' },
    nodeOnline: true,
    deleting: false,
    chats: [{ id: 's1', name: 'Plan' }],
    schedules: [{ id: 'sc1', title: 'Daily fares' }],
    keptSchedules: [
      { id: 'sc2', title: 'Repo check', workspaceId: 'mac:repo', workspaceName: 'Repo' },
    ],
    delegations: 1,
    links: 2,
    memory: [
      { entry: entry('n1', 'Only here'), action: 'forget', restored: null, restoredRevision: null },
      { entry: entry('n2', 'Tea for X'), action: 'rollback', restored: 'Tea', restoredRevision: 1 },
      {
        entry: entry('n3', 'Mixed text', 4),
        action: 'review',
        restored: null,
        restoredRevision: null,
      },
    ],
    ...overrides,
  };
}

const workspace: Workspace = {
  id: 'chat:trip',
  hostId: 'chat',
  displayName: 'Trip',
  defaults: {},
  kind: 'chat',
} as Workspace;

async function show() {
  component = mount(DeleteProjectDialog, { target, props: { workspace } });
  flushSync();
  await vi.waitFor(() => expect(target.textContent).toContain('Not deleted'));
}
const button = (label: string) =>
  [...target.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)!;
const radio = (value: string) =>
  target.querySelector<HTMLInputElement>(`input[type="radio"][value="${value}"]`)!;

it('lists what goes and what stays, and waits for a decision on mixed entries', async () => {
  vi.spyOn(projectDeletionApi, 'preview').mockResolvedValue(preview());
  const remove = vi.spyOn(app, 'deleteProject').mockResolvedValue();
  await show();
  const text = target.textContent!;
  expect(text).toContain('1 chat, with their messages');
  expect(text).toContain('links to 2 workspaces');
  expect(text).toContain('“Daily fares”');
  expect(text).toContain('“Only here”');
  expect(text).toContain('“Tea for X” → “Tea”');
  expect(text).toContain('“Repo check” (Repo)');
  expect(text).toContain('other chats may write it again');
  expect(button('Delete project').disabled).toBe(true);
  radio('keep').click();
  flushSync();
  expect(button('Delete project').disabled).toBe(false);
  button('Delete project').click();
  await vi.waitFor(() => expect(remove).toHaveBeenCalled());
  expect(remove).toHaveBeenCalledWith('chat:trip', [
    { entryId: 'n3', revision: 4, action: 'keep' },
  ]);
});

it('sends edited text, and reloads when memory changed meanwhile', async () => {
  const load = vi
    .spyOn(projectDeletionApi, 'preview')
    .mockResolvedValueOnce(preview())
    .mockResolvedValueOnce(
      preview({
        memory: [
          {
            entry: entry('n3', 'Mixed text, changed', 5),
            action: 'review',
            restored: null,
            restoredRevision: null,
          },
        ],
      }),
    );
  const remove = vi
    .spyOn(app, 'deleteProject')
    .mockRejectedValueOnce(new ApiError('Memory changed', 409, 'conflict'))
    .mockResolvedValue();
  await show();
  radio('edit').click();
  flushSync();
  const area = target.querySelector('textarea')!;
  expect(area.value).toBe('Mixed text');
  area.value = '  Cleaned  ';
  area.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
  button('Delete project').click();
  await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  expect(remove).toHaveBeenCalledWith('chat:trip', [
    { entryId: 'n3', revision: 4, action: 'edit', content: 'Cleaned' },
  ]);
  await vi.waitFor(() => expect(target.textContent).toContain('Review it again'));
  await tick();
  // The new revision needs a new decision.
  expect(target.textContent).toContain('Mixed text, changed');
  expect(button('Delete project').disabled).toBe(true);
});

it('cannot delete while the chat node is offline', async () => {
  vi.spyOn(projectDeletionApi, 'preview').mockResolvedValue(
    preview({ nodeOnline: false, memory: [] }),
  );
  await show();
  expect(target.textContent).toContain('Connect the chat node');
  expect(button('Delete project').disabled).toBe(true);
});
