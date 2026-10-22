// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import { app } from '../../app.svelte';
import CheckpointsTab from './CheckpointsTab.svelte';
import CheckpointsTabHarness from './CheckpointsTabHarness.svelte';

let component: ReturnType<typeof mount> | undefined;
let target: HTMLDivElement;

const capture = {
  id: 'capture-1',
  state: 'observational',
  coverage: 'observational copy; review before continuing',
  gaps: false,
  pinned: true,
  created: 1_800_000_000_000,
  run: 'run-1',
  operations: [
    {
      id: 'operation-1',
      path: 'src/file.ts',
      state: 'observed',
      before: { kind: 'file', hash: 'a', size: 12, executable: false },
      after: { kind: 'file', hash: 'b', size: 11, executable: false },
    },
    {
      id: 'operation-2',
      path: 'src/file.ts',
      state: 'observed',
      before: { kind: 'file', hash: 'b', size: 11, executable: false },
      after: { kind: 'file', hash: 'c', size: 11, executable: false },
    },
  ],
};

const readyJob = {
  id: 'job-1',
  state: 'ready',
  revision: 4,
  reservedBytes: 4096,
  captureId: capture.id,
  operations: ['operation-2'],
  manifest: {
    paths: [
      {
        path: 'src/file.ts',
        status: 'conflict',
        before: capture.operations[1]!.before,
        after: capture.operations[1]!.after,
        current: { kind: 'file', hash: 'c', size: 10, executable: false },
        candidate: { kind: 'file', hash: 'c', size: 10, executable: false },
      },
    ],
    exclusions: {},
    copiedBytes: 2048,
    coverage: 'observational copy; review conflicts',
  },
};

async function flush() {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
    await tick();
  }
}

function json(value: unknown) {
  return new Response(JSON.stringify(value), { status: 200 });
}

function updateHarness(values: {
  sessionId?: string;
  scope?: string;
  online?: boolean;
  hasControl?: boolean;
  generation?: number;
}) {
  window.dispatchEvent(new CustomEvent('checkpoints-harness-update', { detail: values }));
}

afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  target?.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  app.sessionState = undefined;
});

it('requires observational review, prepares an isolated job, reviews files and confirms keep-current conflicts', async () => {
  app.sessionState = {
    session: { id: 'source' },
    control: { heldByCurrentClient: true, generation: 7 },
  } as never;
  const opened: string[] = [];
  vi.spyOn(app, 'openSession').mockImplementation(async (id) => {
    opened.push(id);
  });
  const calls: Array<{ path: string; method: string; body?: any }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const path = String(input);
      const method = init.method ?? 'GET';
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ path, method, body });
      if (path.endsWith('/checkpoints') && method === 'GET')
        return json({ version: 1, enabled: true, captures: [capture], jobs: [], more: false });
      if (path.endsWith('/preview') && method === 'POST')
        return json({
          version: 1,
          revision: 'preview-rev',
          copiedBytes: 2048,
          exclusions: {},
          coverage: 'observational',
        });
      if (path.endsWith('/recoveries') && method === 'POST') return json(readyJob);
      if (path.endsWith('/recoveries/job-1') && method === 'GET') return json(readyJob);
      if (path.endsWith('/continue') && method === 'POST')
        return json({
          session: { id: 'fresh-session' },
          workspaceId: 'recovery-workspace',
          job: {
            ...readyJob,
            state: 'opened',
            continuation: { sessionId: 'fresh-session', workspaceId: 'recovery-workspace' },
          },
        });
      if (path.includes('/file?')) {
        const url = new URL(path, 'http://localhost');
        const side = url.searchParams.get('side');
        const operation = url.searchParams.get('operation');
        const text =
          operation === 'operation-2'
            ? side === 'before'
              ? 'const value = 2;\n'
              : 'const value = 3;\n'
            : side === 'before'
              ? 'const value = 1;\n'
              : 'const value = 2;\n';
        return json({
          path: 'src/file.ts',
          side,
          text,
          binary: false,
          absent: false,
          excluded: false,
          truncated: false,
        });
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    }),
  );
  target = document.createElement('div');
  document.body.append(target);
  component = mount(CheckpointsTab, {
    target,
    props: {
      sessionId: 'source',
      scope: 'source:workspace:node',
      online: true,
      hasControl: true,
      generation: 7,
    },
  });
  await flush();

  const captureButton = [...target.querySelectorAll('button')].find(
    (button) =>
      button.textContent?.includes('observational') && button.textContent.includes('operations'),
  );
  expect(captureButton).toBeTruthy();
  captureButton!.click();
  await flush();

  const operation = target.querySelectorAll<HTMLInputElement>(
    '.operation-list input[type="checkbox"]',
  )[1]!;
  operation.click();
  await flush();
  const previewButton = [...target.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('Preview recovery'),
  )!;
  expect(previewButton.disabled).toBe(true);
  target.querySelector<HTMLInputElement>('.consent-row input')!.click();
  await flush();
  expect(previewButton.disabled).toBe(false);
  previewButton.click();
  await flush();
  expect(target.textContent).toContain('Recovery preview');
  expect(calls.find((call) => call.path.endsWith('/preview'))?.body).toMatchObject({
    operations: ['operation-2'],
    reviewObservational: true,
  });

  [...target.querySelectorAll('button')]
    .find((button) => button.textContent?.includes('Prepare independent workspace'))!
    .click();
  await flush();
  expect(target.textContent).toContain('Recovery workspace');
  expect(target.textContent).toContain('Conflict · keep current');
  expect(target.textContent).toContain('opens a new conversation');

  [...target.querySelectorAll('button')]
    .find((button) => button.textContent?.includes('Inspect before and after'))!
    .click();
  await flush();
  expect(target.querySelector('.diff-line.del code')?.textContent).toBe('const value = 2;');
  expect(target.querySelector('.diff-line.add code')?.textContent).toBe('const value = 3;');
  expect(
    calls
      .filter((call) => call.path.includes('/file?'))
      .map((call) => new URL(call.path, 'http://localhost').searchParams.get('operation')),
  ).toEqual(['operation-2', 'operation-2']);

  const continueButton = [...target.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('Continue in recovery workspace'),
  )!;
  expect(continueButton.disabled).toBe(true);
  target.querySelector<HTMLInputElement>('.unresolved-confirm input')!.click();
  await flush();
  expect(continueButton.disabled).toBe(false);
  continueButton.click();
  await flush();

  expect(calls.find((call) => call.path.endsWith('/continue'))?.body).toMatchObject({
    revision: 4,
    acceptUnresolved: true,
    generation: 7,
  });
  expect(opened).toEqual(['fresh-session']);
});

it('does not allow selecting a capture without control', async () => {
  app.sessionState = {
    session: { id: 'source' },
    control: { heldByCurrentClient: false },
  } as never;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      json({ version: 1, enabled: true, captures: [capture], jobs: [], more: false }),
    ),
  );
  target = document.createElement('div');
  document.body.append(target);
  component = mount(CheckpointsTab, {
    target,
    props: {
      sessionId: 'source',
      scope: 'source:workspace:node',
      online: true,
      hasControl: false,
      generation: undefined,
    },
  });
  await flush();
  const captureButton = target.querySelector<HTMLButtonElement>('.checkpoint-row');
  expect(captureButton?.disabled).toBe(true);
  expect(target.textContent).toContain('Take control of this session');
});

it('discards a late list response after switching sessions', async () => {
  let resolveSource!: (response: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      if (String(input).includes('/sessions/source/checkpoints'))
        return new Promise<Response>((resolve) => (resolveSource = resolve));
      if (String(input).includes('/sessions/other/checkpoints'))
        return json({ version: 1, enabled: false, captures: [], jobs: [], more: false });
      throw new Error(`Unexpected request: ${input}`);
    }),
  );
  target = document.createElement('div');
  document.body.append(target);
  component = mount(CheckpointsTabHarness, { target });
  await flush();

  updateHarness({ sessionId: 'other', scope: 'other:workspace:node' });
  await flush();
  resolveSource!(
    json({
      version: 1,
      enabled: true,
      captures: [{ ...capture, id: 'private-old-session-capture' }],
      jobs: [],
      more: false,
    }),
  );
  await flush();

  expect(target.textContent).toContain('PIRC_CHECKPOINT_WORKSPACES');
  expect(target.textContent).not.toContain('private-old-session-capture');
  expect(target.querySelector('.checkpoint-row')).toBeNull();
});

it('discards a late preview response after going offline', async () => {
  let resolvePreview!: (response: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const path = String(input);
      if (path.endsWith('/checkpoints'))
        return json({ version: 1, enabled: true, captures: [capture], jobs: [], more: false });
      if (path.endsWith('/preview') && init.method === 'POST')
        return new Promise<Response>((resolve) => (resolvePreview = resolve));
      throw new Error(`Unexpected request: ${init.method ?? 'GET'} ${path}`);
    }),
  );
  target = document.createElement('div');
  document.body.append(target);
  component = mount(CheckpointsTabHarness, { target });
  await flush();

  [...target.querySelectorAll('button')]
    .find((button) => button.textContent?.includes('operations'))!
    .click();
  await flush();
  target.querySelector<HTMLInputElement>('.operation-list input[type="checkbox"]')!.click();
  await flush();
  target.querySelector<HTMLInputElement>('.consent-row input')!.click();
  await flush();
  [...target.querySelectorAll('button')]
    .find((button) => button.textContent?.includes('Preview recovery'))!
    .click();
  await flush();
  expect(resolvePreview).toBeTypeOf('function');

  updateHarness({ online: false });
  await flush();
  resolvePreview!(
    json({
      version: 1,
      revision: 'late-preview',
      copiedBytes: 12,
      exclusions: {},
      coverage: 'late response',
    }),
  );
  await flush();

  expect(target.textContent).toContain('Reconnect to inspect or prepare a recovery.');
  expect(target.textContent).not.toContain('Recovery preview');
});

it('discards a late preview response after losing the control lease', async () => {
  let resolvePreview!: (response: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const path = String(input);
      if (path.endsWith('/checkpoints'))
        return json({ version: 1, enabled: true, captures: [capture], jobs: [], more: false });
      if (path.endsWith('/preview') && init.method === 'POST')
        return new Promise<Response>((resolve) => (resolvePreview = resolve));
      throw new Error(`Unexpected request: ${init.method ?? 'GET'} ${path}`);
    }),
  );
  target = document.createElement('div');
  document.body.append(target);
  component = mount(CheckpointsTabHarness, { target });
  await flush();
  [...target.querySelectorAll('button')]
    .find((button) => button.textContent?.includes('operations'))!
    .click();
  await flush();
  target.querySelector<HTMLInputElement>('.operation-list input[type="checkbox"]')!.click();
  await flush();
  target.querySelector<HTMLInputElement>('.consent-row input')!.click();
  await flush();
  [...target.querySelectorAll('button')]
    .find((button) => button.textContent?.includes('Preview recovery'))!
    .click();
  await flush();
  expect(resolvePreview).toBeTypeOf('function');

  updateHarness({ hasControl: false });
  await flush();
  resolvePreview!(
    json({
      version: 1,
      revision: 'late-lease-preview',
      copiedBytes: 12,
      exclusions: {},
      coverage: 'late response',
    }),
  );
  await flush();

  expect(target.textContent).toContain('Take control of this session');
  expect(target.textContent).not.toContain('Recovery preview');
  expect(target.querySelector<HTMLButtonElement>('.checkpoint-row')?.disabled).toBe(true);
});

it('reuses the existing continuation for an already opened recovery job', async () => {
  const openedJob = {
    ...readyJob,
    state: 'opened',
    manifest: { ...readyJob.manifest, paths: [] },
    continuation: { sessionId: 'recovery-session', workspaceId: 'recovery-workspace' },
  };
  vi.spyOn(app, 'openSession').mockResolvedValue(undefined);
  const calls: Array<{ path: string; method: string }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const path = String(input);
      const method = init.method ?? 'GET';
      calls.push({ path, method });
      if (path.endsWith('/checkpoints'))
        return json({
          version: 1,
          enabled: true,
          captures: [capture],
          jobs: [openedJob],
          more: false,
        });
      if (path.endsWith('/recoveries/job-1')) return json(openedJob);
      throw new Error(`Unexpected request: ${method} ${path}`);
    }),
  );
  target = document.createElement('div');
  document.body.append(target);
  component = mount(CheckpointsTab, {
    target,
    props: {
      sessionId: 'source',
      scope: 'source:workspace:node',
      online: true,
      hasControl: true,
      generation: 7,
    },
  });
  await flush();
  [...target.querySelectorAll('button')]
    .find((button) => button.textContent?.includes('opened'))!
    .click();
  await flush();
  [...target.querySelectorAll('button')]
    .find((button) => button.textContent?.includes('Open recovery conversation'))!
    .click();
  await flush();

  expect(app.openSession).toHaveBeenCalledWith('recovery-session');
  expect(calls.some((call) => call.path.endsWith('/continue'))).toBe(false);
});

it('retries an opened job without a continuation link and opens the returned session', async () => {
  const openedJob = {
    ...readyJob,
    state: 'opened',
    manifest: { ...readyJob.manifest, paths: [] },
  };
  vi.spyOn(app, 'openSession').mockResolvedValue(undefined);
  const calls: Array<{ path: string; method: string; body?: any }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const path = String(input);
      const method = init.method ?? 'GET';
      calls.push({ path, method, body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (path.endsWith('/checkpoints'))
        return json({
          version: 1,
          enabled: true,
          captures: [capture],
          jobs: [openedJob],
          more: false,
        });
      if (path.endsWith('/recoveries/job-1') && method === 'GET') return json(openedJob);
      if (path.endsWith('/continue') && method === 'POST')
        return json({
          session: { id: 'recovered-existing-session' },
          workspaceId: 'recovery-workspace',
          job: {
            ...openedJob,
            continuation: {
              sessionId: 'recovered-existing-session',
              workspaceId: 'recovery-workspace',
            },
          },
        });
      throw new Error(`Unexpected request: ${method} ${path}`);
    }),
  );
  target = document.createElement('div');
  document.body.append(target);
  component = mount(CheckpointsTab, {
    target,
    props: {
      sessionId: 'source',
      scope: 'source:workspace:node',
      online: true,
      hasControl: true,
      generation: 7,
    },
  });
  await flush();
  [...target.querySelectorAll('button')]
    .find((button) => button.textContent?.includes('opened'))!
    .click();
  await flush();
  [...target.querySelectorAll('button')]
    .find((button) => button.textContent?.includes('Continue in recovery workspace'))!
    .click();
  await flush();

  expect(calls.filter((call) => call.path.endsWith('/continue'))).toHaveLength(1);
  expect(app.openSession).toHaveBeenCalledWith('recovered-existing-session');
});

it('keeps a durable link to the source session on a recovery workspace', async () => {
  vi.spyOn(app, 'openSession').mockResolvedValue(undefined);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      json({
        version: 1,
        enabled: true,
        origin: {
          sessionId: 'source-session',
          workspaceId: 'source-workspace',
          jobId: 'origin-job',
          captureId: 'origin-capture',
        },
        captures: [],
        jobs: [],
        more: false,
      }),
    ),
  );
  target = document.createElement('div');
  document.body.append(target);
  component = mount(CheckpointsTab, {
    target,
    props: {
      sessionId: 'recovery-session',
      scope: 'recovery-session:workspace:node',
      online: true,
      hasControl: false,
      generation: undefined,
    },
  });
  await flush();

  expect(target.textContent).toContain('Recovery origin');
  expect(target.textContent).toContain('origin-capture');
  expect(target.textContent).toContain('origin-job');
  target.querySelector<HTMLButtonElement>('.checkpoint-origin button')!.click();
  await flush();
  expect(app.openSession).toHaveBeenCalledWith('source-session');
});

it('keeps the source link visible when checkpoint capture is opted out', async () => {
  vi.spyOn(app, 'openSession').mockResolvedValue(undefined);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      json({
        version: 1,
        enabled: false,
        origin: {
          sessionId: 'source-session',
          workspaceId: 'source-workspace',
          jobId: 'origin-job',
          captureId: 'origin-capture',
        },
        captures: [],
        jobs: [],
        more: false,
      }),
    ),
  );
  target = document.createElement('div');
  document.body.append(target);
  component = mount(CheckpointsTab, {
    target,
    props: {
      sessionId: 'recovery-session',
      scope: 'recovery-session:workspace:node',
      online: true,
      hasControl: false,
      generation: undefined,
    },
  });
  await flush();

  expect(target.textContent).toContain('Checkpoint capture is opt-in');
  expect(target.textContent).toContain('origin-capture');
  target.querySelector<HTMLButtonElement>('.checkpoint-origin button')!.click();
  await flush();
  expect(app.openSession).toHaveBeenCalledWith('source-session');
});
