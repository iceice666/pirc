import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EnvironmentArtifacts } from '../src/environment/artifacts.js';
import { persistExecutorArtifacts } from '../src/node/environment-result-artifacts.js';
import type { Binding, Terminal } from '../src/environment/protocol.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
const binding = (): Binding => ({
  nodeId: 'test',
  workspaceId: 'test:test',
  sessionId: randomUUID(),
  writerEpoch: randomUUID(),
  executorEpoch: randomUUID(),
});
const terminal = (content: unknown[]): Terminal => ({
  state: 'completed',
  effect: 'completed',
  truncated: false,
  artifacts: [],
  output: { content } as Terminal['output'],
});
function store() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pirc-result-artifacts-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const storage = new EnvironmentArtifacts(root);
  cleanups.push(() => storage.close());
  return storage;
}

test('executor image bytes become durable owner-bound artifacts without host path ingestion', async () => {
  const storage = store();
  const owner = binding();
  const bytes = Buffer.from('real returned bytes');
  const input = terminal([
    { type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' },
  ]);
  const result = await persistExecutorArtifacts(input, owner, storage);
  expect(result.output).toEqual(input.output);
  expect(result.artifacts).toHaveLength(1);
  const artifact = result.artifacts[0]!;
  expect(Buffer.from(await storage.chunk(owner, artifact, 0)).equals(bytes)).toBe(true);
  await expect(storage.chunk({ ...owner, sessionId: randomUUID() }, artifact, 0)).rejects.toThrow(
    'owner',
  );
  storage.pin(owner, artifact);
  await expect(storage.removeUnreferenced(owner, artifact)).rejects.toThrow('referenced');
});

test('executor artifact ingestion rejects noncanonical base64, MIME, oversized and forged references', async () => {
  const storage = store();
  const owner = binding();
  for (const image of [
    { type: 'image', data: '', mimeType: 'image/png' },
    { type: 'image', data: 'aGVsbG8=\n', mimeType: 'image/png' },
    { type: 'image', data: 'Zh==', mimeType: 'image/png' },
    { type: 'image', data: 'aGVsbG8=', mimeType: 'text/html' },
    {
      type: 'image',
      data: Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64'),
      mimeType: 'image/png',
    },
  ])
    await expect(persistExecutorArtifacts(terminal([image]), owner, storage)).rejects.toThrow(
      'Invalid',
    );
  const artifact = await storage.put(owner, Buffer.from('fixture'), 'image/png');
  await expect(
    persistExecutorArtifacts({ ...terminal([]), artifacts: [artifact] }, owner, storage),
  ).rejects.toThrow('manufacture');
});

test('executor artifact ingestion validates the whole bounded set before storing and leaves text unchanged', async () => {
  const storage = store();
  const owner = binding();
  const image = { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' };
  await expect(
    persistExecutorArtifacts(terminal(Array(33).fill(image)), owner, storage),
  ).rejects.toThrow('quota');
  const input = terminal([
    { type: 'text', text: '/host/private/path is not an ingestion request' },
  ]);
  expect(await persistExecutorArtifacts(input, owner, storage)).toBe(input);
});

test('executor artifact ingestion rolls back earlier puts when later durable storage fails', async () => {
  const storage = store();
  const owner = binding();
  const pinned = await storage.put(owner, Buffer.from('existing pinned image'), 'image/png');
  storage.pin(owner, pinned);
  const put = storage.put.bind(storage);
  const created: Terminal['artifacts'] = [];
  let calls = 0;
  storage.put = async (...args) => {
    if (++calls === 2) throw new Error('Fixture ENOSPC during second image');
    const artifact = await put(...args);
    created.push(artifact);
    return artifact;
  };
  const image = { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' };
  await expect(persistExecutorArtifacts(terminal([image, image]), owner, storage)).rejects.toThrow(
    'ENOSPC',
  );
  expect(calls).toBe(2);
  expect(created).toHaveLength(1);
  await expect(storage.chunk(owner, created[0]!, 0)).rejects.toThrow('unavailable');
  expect(Buffer.from(await storage.chunk(owner, pinned, 0)).toString()).toBe(
    'existing pinned image',
  );
  await expect(storage.removeUnreferenced(owner, pinned)).rejects.toThrow('referenced');
});

test('executor artifact ingestion rolls back a completed put when cancelled during storage', async () => {
  const storage = store();
  const owner = binding();
  const controller = new AbortController();
  const put = storage.put.bind(storage);
  const created: Terminal['artifacts'] = [];
  storage.put = async (...args) => {
    const artifact = await put(...args);
    created.push(artifact);
    controller.abort(new Error('Fixture cancelled during image storage'));
    return artifact;
  };
  const image = { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' };
  await expect(
    persistExecutorArtifacts(terminal([image, image]), owner, storage, controller.signal),
  ).rejects.toThrow('cancelled');
  expect(created).toHaveLength(1);
  await expect(storage.chunk(owner, created[0]!, 0)).rejects.toThrow('unavailable');
});

test('executor artifact ingestion preserves cancelled text terminals without touching storage', async () => {
  const storage = store();
  const owner = binding();
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  storage.put = async () => {
    calls++;
    throw new Error('Text result must not create an artifact');
  };
  const input: Terminal = {
    ...terminal([
      { type: 'text', text: 'Foreground wait was cancelled; background job continues' },
    ]),
    state: 'cancelled',
    effect: 'unknown',
  };
  expect(await persistExecutorArtifacts(input, owner, storage, controller.signal)).toBe(input);
  expect(calls).toBe(0);
});
