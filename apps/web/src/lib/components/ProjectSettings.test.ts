// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import ProjectSettings from './ProjectSettings.svelte';
import { app } from '../app.svelte';
import type { ProjectCapabilities } from '../capabilities';

let component: ReturnType<typeof mount> | undefined;
let target: HTMLDivElement;
let policy: ProjectCapabilities;
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const switches = () => Array.from(target.querySelectorAll<HTMLInputElement>('[role="switch"]'));
async function flush() {
  for (let i = 0; i < 12; i++) {
    await Promise.resolve();
    await tick();
  }
}
async function setup(disabled = false) {
  target = document.createElement('div');
  document.body.append(target);
  component = mount(ProjectSettings, { target, props: { disabled } });
  await flush();
}

beforeEach(() => {
  app.workspaces = [
    { id: 'home:chat/project', hostId: 'home', displayName: 'Project', kind: 'chat', defaults: {} },
    { id: 'work:code', hostId: 'work', displayName: 'Code', kind: 'directory', defaults: {} },
    { id: 'home:chats', hostId: 'home', displayName: 'Chats', kind: 'chat', defaults: {} },
  ];
  policy = {
    version: 1,
    delegation: true,
    memory_search: true,
    remote_recall: true,
    schedules: true,
    web_search: true,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response({ capabilities: policy })),
  );
});
afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  target?.remove();
  vi.unstubAllGlobals();
});

it('loads gateway policy with accessible switches for chat workspaces only', async () => {
  policy.memory_search = false;
  await setup();
  expect(fetch).toHaveBeenCalledWith(
    '/api/workspaces/home%3Achat%2Fproject/capabilities',
    expect.objectContaining({ credentials: 'include' }),
  );
  expect(switches()).toHaveLength(5);
  expect(switches().map((input) => input.checked)).toEqual([true, false, true, true, true]);
  expect(target.querySelectorAll('option')).toHaveLength(2);
  expect(target.textContent).toContain('not a sandbox');
  expect(target.textContent).toContain('enforced by the gateway');
});

it('saves only the changed flag and waits for gateway confirmation', async () => {
  await setup();
  let finish!: (response: Response) => void;
  vi.mocked(fetch).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  switches()[0]!.click();
  await flush();
  expect(fetch).toHaveBeenLastCalledWith(
    '/api/workspaces/home%3Achat%2Fproject/capabilities',
    expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ capabilities: { delegation: false } }),
    }),
  );
  expect(switches()[0]!.checked).toBe(true);
  expect(target.querySelector('fieldset')!.disabled).toBe(true);
  finish(response({ capabilities: { ...policy, delegation: false } }));
  await flush();
  expect(switches()[0]!.checked).toBe(false);
  expect(target.textContent).toContain('Project capabilities saved.');
});

it('keeps the saved policy and shows gateway errors when saving fails', async () => {
  await setup();
  vi.mocked(fetch).mockResolvedValueOnce(response({ error: { message: 'Not authorized' } }, 403));
  switches()[4]!.click();
  await flush();
  expect(switches()[4]!.checked).toBe(true);
  expect(target.querySelector('[role="alert"]')?.textContent).toBe('Not authorized');
  expect(target.querySelector('fieldset')!.disabled).toBe(false);
});

it('does not show default-allowed switches on load failure and permits retry', async () => {
  vi.mocked(fetch).mockRejectedValueOnce(new Error('offline'));
  await setup();
  expect(switches()).toHaveLength(0);
  expect(target.querySelector('[role="alert"]')?.textContent).toContain('Unable to reach');
  target.querySelector('button')!.click();
  await flush();
  expect(switches()).toHaveLength(5);
});

it('ignores stale policy responses when changing projects', async () => {
  let finish!: (response: Response) => void;
  vi.mocked(fetch).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await setup();
  expect(target.textContent).toContain('Loading project capabilities');
  const select = target.querySelector('select')!;
  select.value = 'home:chats';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await flush();
  expect(switches()[0]!.checked).toBe(true);
  finish(response({ capabilities: { ...policy, delegation: false } }));
  await flush();
  expect(switches()[0]!.checked).toBe(true);
});

it('does not request or edit policies in demo mode', async () => {
  await setup(true);
  expect(fetch).not.toHaveBeenCalled();
  expect(switches()).toHaveLength(0);
  expect(target.textContent).toContain('unavailable in demo mode');
});
