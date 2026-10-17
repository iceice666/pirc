// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import ProjectFiles from './ProjectFiles.svelte';

let component: ReturnType<typeof mount> | undefined;
let target: HTMLDivElement;
const response = (value: unknown, status = 200) =>
  status === 204 ? new Response(null, { status }) : new Response(JSON.stringify(value), { status });
const listing = (names: string[]) => ({
  files: names.map((name) => ({ name, byteSize: 2048, modifiedAt: 1 })),
  maxFiles: 50,
  maxBytes: 10,
});
async function flush() {
  for (let i = 0; i < 12; i++) {
    await Promise.resolve();
    await tick();
  }
}
async function setup() {
  target = document.createElement('div');
  document.body.append(target);
  component = mount(ProjectFiles, { target, props: { workspaceId: 'home:p1' } });
  await flush();
}
const buttons = (label: string) =>
  [...target.querySelectorAll('button')].filter((button) => button.textContent?.trim() === label);
async function choose(files: File[]) {
  const input = target.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await flush();
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response(listing(['notes.md']))),
  );
});
afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  target?.remove();
  vi.unstubAllGlobals();
});

it('lists the project files with their sizes and the limits', async () => {
  await setup();
  expect(fetch).toHaveBeenCalledWith(
    '/api/workspaces/home%3Ap1/files',
    expect.objectContaining({ credentials: 'include' }),
  );
  expect(target.textContent).toContain('notes.md');
  expect(target.textContent).toContain('2.0 KB');
  expect(target.textContent).toContain('1 / 50 files, up to 10 B each');
  expect(target.textContent?.replace(/\s+/g, ' ')).toContain('The assistant cannot change them');
});

it('uploads raw bytes, refuses files over the limit, and refreshes the list', async () => {
  await setup();
  vi.mocked(fetch)
    .mockResolvedValueOnce(response({ file: { name: 'a.json', byteSize: 2, modifiedAt: 2 } }, 201))
    .mockResolvedValueOnce(response(listing(['a.json', 'notes.md'])));
  await choose([
    new File(['{}'], 'a.json', { type: 'application/json' }),
    new File(['x'.repeat(11)], 'big.txt'),
  ]);
  const [url, init] = vi.mocked(fetch).mock.calls[1]!;
  expect(url).toBe('/api/workspaces/home%3Ap1/files?filename=a.json');
  expect(init?.method).toBe('POST');
  expect(new Headers(init?.headers).get('content-type')).toBe('application/octet-stream');
  // big.txt was never sent.
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(target.querySelector('[role="alert"]')?.textContent).toContain('big.txt is larger');
  expect(target.textContent).toContain('1 file uploaded');
  expect(target.textContent).toContain('a.json');
});

it('removes a file only after confirming', async () => {
  await setup();
  buttons('Remove…')[0]!.click();
  await flush();
  expect(fetch).toHaveBeenCalledTimes(1);
  vi.mocked(fetch)
    .mockResolvedValueOnce(response(null, 204))
    .mockResolvedValueOnce(response(listing([])));
  buttons('Remove')[0]!.click();
  await flush();
  expect(fetch).toHaveBeenCalledWith(
    '/api/workspaces/home%3Ap1/files?name=notes.md',
    expect.objectContaining({ method: 'DELETE' }),
  );
  expect(target.textContent).toContain('No files yet.');
  expect(target.textContent).toContain('notes.md removed.');
});

it('shows gateway errors and lets the user retry loading', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(response({ error: { message: 'test is offline' } }, 503));
  await setup();
  expect(target.querySelector('[role="alert"]')?.textContent).toBe('test is offline');
  buttons('Retry')[0]!.click();
  await flush();
  expect(target.textContent).toContain('notes.md');
});
