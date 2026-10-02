// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import ProjectTrust from './ProjectTrust.svelte';

let component: ReturnType<typeof mount> | undefined;
let target: HTMLDivElement;
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const HASH = 'a'.repeat(64);
const OLD = 'b'.repeat(64);
const summary = (extra: Record<string, unknown> = {}) => ({
  project: {
    hooks: {
      sessionStart: [{ command: 'make setup', timeoutMs: 10000 }],
      beforeTool: [{ command: './check.sh', matcher: 'bash', timeoutMs: 10000 }],
      afterTool: [],
    },
    env: { GIT_SSH_COMMAND: 'ssh -i deploy' },
    allowedPaths: ['../shared'],
    hash: HASH,
    trustedHash: null,
    trusted: false,
    empty: false,
    ...extra,
  },
});
const buttons = () =>
  Array.from(target.querySelectorAll<HTMLButtonElement>('button')).map((b) => b.textContent);
const button = (label: string) =>
  Array.from(target.querySelectorAll<HTMLButtonElement>('button')).find(
    (b) => b.textContent === label,
  )!;
async function flush() {
  for (let i = 0; i < 12; i++) {
    await Promise.resolve();
    await tick();
  }
}
async function setup() {
  target = document.createElement('div');
  document.body.append(target);
  component = mount(ProjectTrust, { target, props: { workspaceId: 'node:ws' } });
  await flush();
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response(summary())),
  );
});
afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  target?.remove();
  vi.unstubAllGlobals();
});

it('shows the hooks, environment and paths a project config would add, untrusted', async () => {
  await setup();
  expect(fetch).toHaveBeenCalledWith(
    '/api/workspaces/node%3Aws/project-config',
    expect.objectContaining({ credentials: 'include' }),
  );
  const blocks = Array.from(target.querySelectorAll('pre')).map((pre) => pre.textContent);
  expect(blocks).toEqual([
    'make setup',
    './check.sh',
    'GIT_SSH_COMMAND=ssh -i deploy',
    '../shared',
  ]);
  const text = target.textContent!.replace(/\s+/g, ' ');
  expect(text).toContain('When a session starts');
  expect(text).toContain('Only for tools matching bash');
  expect(text).not.toContain('After a tool runs');
  expect(text).toContain('Not trusted: ignored');
  expect(buttons()).toEqual(['Trust']);
});

it('trusts the reviewed hash and revokes trust', async () => {
  await setup();
  vi.mocked(fetch).mockResolvedValueOnce(response(summary({ trusted: true, trustedHash: HASH })));
  button('Trust').click();
  await flush();
  expect(fetch).toHaveBeenLastCalledWith(
    '/api/workspaces/node%3Aws/project-trust',
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ trusted: true, hash: HASH }),
    }),
  );
  expect(target.textContent).toContain('Trusted');
  expect(buttons()).toEqual(['Revoke trust']);

  vi.mocked(fetch).mockResolvedValueOnce(response(summary()));
  button('Revoke trust').click();
  await flush();
  expect(fetch).toHaveBeenLastCalledWith(
    '/api/workspaces/node%3Aws/project-trust',
    expect.objectContaining({ method: 'POST', body: JSON.stringify({ trusted: false }) }),
  );
  expect(buttons()).toEqual(['Trust']);
});

it('says when the config changed since it was trusted', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(response(summary({ trustedHash: OLD })));
  await setup();
  expect(target.textContent).toContain('Changed since trusted');
  expect(buttons()).toEqual(['Trust', 'Revoke trust']);
});

it('shows the current config when it changed before trusting', async () => {
  await setup();
  vi.mocked(fetch)
    .mockResolvedValueOnce(
      response({ error: { message: 'The project config changed since it was shown' } }, 409),
    )
    .mockResolvedValueOnce(response(summary({ env: { GIT_SSH_COMMAND: 'evil' }, hash: OLD })));
  button('Trust').click();
  await flush();
  expect(target.querySelector('[role="alert"]')?.textContent).toContain('changed since');
  expect(target.textContent).toContain('GIT_SSH_COMMAND=evil');
});

it('has nothing to trust for an empty or invalid config', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(
    response(summary({ hooks: {}, env: {}, allowedPaths: [], empty: true })),
  );
  await setup();
  expect(target.textContent).toContain('sets no hooks, environment or allowed paths');
  expect(buttons()).toEqual([]);
  await unmount(component!);
  target.remove();
  vi.mocked(fetch).mockResolvedValueOnce(
    response({
      project: {
        error: 'Invalid JSON',
        hash: null,
        trustedHash: null,
        trusted: false,
        empty: true,
      },
    }),
  );
  await setup();
  expect(target.textContent).toContain('The project config is invalid and is not used');
  expect(buttons()).toEqual([]);
});
