// @vitest-environment jsdom
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, it } from 'vitest';
import { app } from '../../app.svelte';
import { demoModes } from '../../mock';
import type { ModeInfo } from '../../types';
import SidePanel from './SidePanel.svelte';

let component: ReturnType<typeof mount> | undefined;
let target: HTMLDivElement | undefined;
afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  target?.remove();
  app.sessionState = undefined;
  app.workspaces = [];
  app.modeCatalog = [];
});

function render(workspaceId: string) {
  app.workspaces = [
    { id: 'node:ws', hostId: 'node', displayName: 'Project' } as never,
    { id: 'node:gpu', hostId: 'node', displayName: 'GPU', mode: 'scratch' } as never,
    { id: 'node:checkout', hostId: 'node', displayName: 'Checkout', mode: 'plain' } as never,
  ];
  app.sessionState = { session: { id: 's', workspaceId } } as never;
  target = document.createElement('div');
  document.body.append(target);
  component = mount(SidePanel, { target, props: { open: false, tab: 'terminal' } });
  flushSync();
  const tabs = Array.from(target.querySelectorAll('[role="tab"]'));
  return {
    labels: tabs.map((tab) => tab.getAttribute('title')),
    active: tabs.find((tab) => tab.classList.contains('active'))?.getAttribute('title'),
  };
}

it('keeps every tab for directory workspaces', () => {
  const directory = render('node:ws');
  expect(directory.labels).toEqual([
    'Files',
    'Git',
    'Memory',
    'Context',
    'Tasks',
    'Terminal',
    'Browser',
  ]);
  expect(directory.active).toBe('Terminal');
});

it('shows Git only with a repository and the terminal only in a workspace directory', () => {
  const plain: ModeInfo = { ...demoModes[0]!, id: 'plain', repository: false };
  app.modeCatalog = [...demoModes, plain];
  // Scratch: one directory per session, no repository.
  const scratch = render('node:gpu');
  expect(scratch.labels).toEqual(['Files', 'Memory', 'Context', 'Tasks', 'Browser']);
  // A hidden tab that was selected falls back to Files.
  expect(scratch.active).toBe('Files');
  unmount(component!);
  target!.remove();
  // A workspace directory that is not a repository keeps its terminal.
  expect(render('node:checkout').labels).toEqual([
    'Files',
    'Memory',
    'Context',
    'Tasks',
    'Terminal',
    'Browser',
  ]);
});
