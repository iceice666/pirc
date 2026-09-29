// @vitest-environment jsdom
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, it } from 'vitest';
import { app } from '../../app.svelte';
import SidePanel from './SidePanel.svelte';

let component: ReturnType<typeof mount> | undefined;
let target: HTMLDivElement | undefined;
afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  target?.remove();
  app.sessionState = undefined;
  app.workspaces = [];
});

function render(workspaceId: string) {
  app.workspaces = [
    { id: 'home:chats', hostId: 'home', displayName: 'Chats', kind: 'chat' } as never,
    { id: 'node:ws', hostId: 'node', displayName: 'Project' } as never,
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

it('shows chats their files, memory, tasks and browser but no Git or terminal', () => {
  const chat = render('home:chats');
  expect(chat.labels).toEqual(['Files', 'Memory', 'Tasks', 'Browser']);
  // A hidden tab that was selected falls back to Files.
  expect(chat.active).toBe('Files');
});

it('keeps every tab for directory workspaces', () => {
  const directory = render('node:ws');
  expect(directory.labels).toEqual(['Files', 'Git', 'Memory', 'Tasks', 'Terminal', 'Browser']);
  expect(directory.active).toBe('Terminal');
});
