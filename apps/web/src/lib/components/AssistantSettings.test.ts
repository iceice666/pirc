// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import AssistantSettings from './AssistantSettings.svelte';
let component: ReturnType<typeof mount> | undefined;
let target: HTMLDivElement;
const response = (body: unknown) => new Response(JSON.stringify(body));
const prompt = { text: 'Persona', writable: true, path: '/config/SOUL.md', maxChars: 8000 };
async function flush() {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
    await tick();
  }
}
async function setup(writable = true) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/node')) return response({ nodeId: 'chat', online: true });
      if (url.endsWith('/release')) return response({ nodeId: null, online: false });
      if (init?.method === 'PUT')
        return response({
          prompt: { ...prompt, text: JSON.parse(init.body as string).text.trim() },
        });
      return response({
        nodeId: 'chat',
        soul: { ...prompt, writable, reason: writable ? undefined : 'nix-store' },
        chat: { ...prompt, text: 'Rules', path: '/config/CHAT.md' },
      });
    }),
  );
  target = document.createElement('div');
  document.body.append(target);
  component = mount(AssistantSettings, { target });
  await flush();
}
afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  target?.remove();
  vi.unstubAllGlobals();
});
it('loads, counts, saves and reverts drafts', async () => {
  await setup();
  const textarea = target.querySelector('textarea')!;
  expect(textarea.value).toBe('Persona');
  expect(target.textContent).toContain('7 / 8000');
  textarea.value = 'Updated';
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  await flush();
  const form = target.querySelector('form')!;
  form.dispatchEvent(new Event('submit', { cancelable: true }));
  await flush();
  expect(fetch).toHaveBeenCalledWith(
    '/api/assistant/prompts/soul',
    expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ text: 'Updated', nodeId: 'chat' }),
    }),
  );
  expect(target.textContent).toContain('Saved. Applies at the next chat agent start.');
  textarea.value = 'Unsaved';
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  await flush();
  form.querySelector<HTMLButtonElement>('button[type="button"]')!.click();
  await flush();
  expect(textarea.value).toBe('Updated');
});
it('shows Nix-managed files read-only and requires confirmation before unbinding', async () => {
  await setup(false);
  expect(target.querySelector('textarea')!.readOnly).toBe(true);
  expect(target.textContent).toContain('services.pirc.soulPrompt');
  const click = (text: string) =>
    [...target.querySelectorAll('button')].find((b) => b.textContent?.includes(text))!.click();
  click('Release chat node binding');
  await flush();
  expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/release'))).toBe(false);
  click('Confirm release');
  await flush();
  expect(fetch).toHaveBeenCalledWith(
    '/api/assistant/node/release',
    expect.objectContaining({ method: 'POST', body: JSON.stringify({ nodeId: 'chat' }) }),
  );
  expect(target.querySelector('textarea')).toBeNull();
});
