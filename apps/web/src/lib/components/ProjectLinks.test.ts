// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import ProjectLinks from './ProjectLinks.svelte';
import type { Workspace } from '../types';

let component: ReturnType<typeof mount> | undefined;
let target: HTMLDivElement;
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const workspaces: Workspace[] = [
  { id: 'work:pirc', hostId: 'work', displayName: 'pirc', kind: 'directory', defaults: {} },
  { id: 'lab:site', hostId: 'lab', displayName: 'site', kind: 'directory', defaults: {} },
];
const link = (workspaceId: string, extra: Record<string, unknown> = {}) => ({
  workspaceId,
  name: workspaceId.split(':')[1],
  node: workspaceId.split(':')[0],
  online: true,
  removed: false,
  createdAt: 1,
  ...extra,
});
const boxes = () => [...target.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
const button = () => target.querySelector<HTMLButtonElement>('button[type="submit"]')!;
const text = () => target.textContent?.replace(/\s+/g, ' ') ?? '';
async function flush() {
  for (let i = 0; i < 12; i++) {
    await Promise.resolve();
    await tick();
  }
}
async function setup() {
  target = document.createElement('div');
  document.body.append(target);
  component = mount(ProjectLinks, {
    target,
    props: { workspaceId: 'home:trip', workspaces, online: (item) => item.hostId !== 'lab' },
  });
  await flush();
}
const click = async (box: HTMLInputElement) => {
  box.click();
  await flush();
};

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response({ links: [link('work:pirc', { repo: 'github.com/me/pirc' })] })),
  );
});
afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  target?.remove();
  vi.unstubAllGlobals();
});

it('shows the linked workspaces among the directory workspaces', async () => {
  await setup();
  expect(fetch).toHaveBeenCalledWith(
    '/api/workspaces/home%3Atrip/links',
    expect.objectContaining({ credentials: 'include' }),
  );
  expect(boxes().map((box) => box.checked)).toEqual([true, false]);
  expect(text()).toContain('work · github.com/me/pirc');
  expect(text()).toContain('lab · offline');
  expect(text()).toContain('A link is not a permission');
  expect(button().disabled).toBe(true);
});

it('saves the chosen set, keeping the order links were made in', async () => {
  await setup();
  await click(boxes()[1]!);
  expect(button().disabled).toBe(false);
  await click(boxes()[1]!);
  expect(button().disabled).toBe(true);
  await click(boxes()[1]!);
  vi.mocked(fetch).mockResolvedValueOnce(
    response({ links: [link('work:pirc'), link('lab:site', { online: false })] }),
  );
  target.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
  await flush();
  expect(fetch).toHaveBeenLastCalledWith(
    '/api/workspaces/home%3Atrip/links',
    expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ workspaceIds: ['work:pirc', 'lab:site'] }),
    }),
  );
  expect(text()).toContain('Linked workspaces saved.');
  expect(text()).toContain('2 linked');
  expect(button().disabled).toBe(true);
});

it('keeps a link to a workspace that went away until it is unchecked', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(
    response({
      links: [
        link('work:pirc', { removed: true, online: false }),
        { workspaceId: 'old:gone', online: false, removed: true, createdAt: 2 },
      ],
    }),
  );
  await setup();
  expect(text()).toContain('work · removed from its device');
  expect(text()).toContain('old:gone');
  expect(text()).toContain('no longer available');
  expect(boxes().map((box) => box.checked)).toEqual([true, false, true]);
  await click(boxes()[2]!);
  vi.mocked(fetch).mockResolvedValueOnce(response({ links: [link('work:pirc')] }));
  target.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
  await flush();
  expect(fetch).toHaveBeenLastCalledWith(
    '/api/workspaces/home%3Atrip/links',
    expect.objectContaining({ body: JSON.stringify({ workspaceIds: ['work:pirc'] }) }),
  );
  expect(text()).not.toContain('old:gone');
});

it('shows gateway errors and lets the user retry loading', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(
    response({ error: { message: 'Only chat projects can be linked to workspaces' } }, 400),
  );
  await setup();
  expect(target.querySelector('[role="alert"]')?.textContent).toBe(
    'Only chat projects can be linked to workspaces',
  );
  expect(boxes()).toHaveLength(0);
  target.querySelector<HTMLButtonElement>('button')!.click();
  await flush();
  expect(boxes()).toHaveLength(2);
});
