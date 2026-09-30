// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import ProjectInstructions from './ProjectInstructions.svelte';

let component: ReturnType<typeof mount> | undefined;
let target: HTMLDivElement;
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const textarea = () => target.querySelector('textarea')!;
const button = () => target.querySelector<HTMLButtonElement>('button[type="submit"]')!;
async function flush() {
  for (let i = 0; i < 12; i++) {
    await Promise.resolve();
    await tick();
  }
}
async function setup() {
  target = document.createElement('div');
  document.body.append(target);
  component = mount(ProjectInstructions, { target, props: { workspaceId: 'home:p1' } });
  await flush();
}
const type = async (value: string) => {
  textarea().value = value;
  textarea().dispatchEvent(new Event('input', { bubbles: true }));
  await flush();
};

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response({ instructions: { text: 'Be brief.', maxChars: 20 } })),
  );
});
afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  target?.remove();
  vi.unstubAllGlobals();
});

it('loads the instructions and shows the size limit', async () => {
  await setup();
  expect(fetch).toHaveBeenCalledWith(
    '/api/workspaces/home%3Ap1/instructions',
    expect.objectContaining({ credentials: 'include' }),
  );
  expect(textarea().value).toBe('Be brief.');
  expect(target.textContent).toContain('9 / 20 characters');
  expect(target.textContent?.replace(/\s+/g, ' ')).toContain('the assistant cannot edit them');
  expect(button().disabled).toBe(true);
});

it('saves the edit and refuses text over the limit', async () => {
  await setup();
  await type('x'.repeat(21));
  expect(button().disabled).toBe(true);
  expect(textarea().getAttribute('aria-invalid')).toBe('true');
  await type('Answer in French.');
  expect(button().disabled).toBe(false);
  vi.mocked(fetch).mockResolvedValueOnce(
    response({ instructions: { text: 'Answer in French.', maxChars: 20 } }),
  );
  target.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
  await flush();
  expect(fetch).toHaveBeenLastCalledWith(
    '/api/workspaces/home%3Ap1/instructions',
    expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ text: 'Answer in French.' }),
    }),
  );
  expect(target.textContent).toContain('New chats in this project will use them.');
});

it('shows gateway errors and lets the user retry loading', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(response({ error: { message: 'test is offline' } }, 503));
  await setup();
  expect(target.querySelector('[role="alert"]')?.textContent).toBe('test is offline');
  expect(target.querySelector('textarea')).toBeNull();
  target.querySelector<HTMLButtonElement>('button')!.click();
  await flush();
  expect(textarea().value).toBe('Be brief.');
});
