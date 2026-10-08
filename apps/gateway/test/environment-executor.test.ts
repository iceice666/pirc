import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { NodeSandbox } from '../src/node/sandbox.js';
import { SandboxedEnvironmentExecutor } from '../src/node/environment-executor.js';
import { intentDigest } from '../src/environment/protocol.js';
import { testConfig } from './helpers.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

test('shipped executor plumbing runs shared tools under fake-srt without a model loop', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pirc-env-executor-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const configDir = path.join(root, 'config');
  mkdirSync(configDir);
  writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify({ features: { autoMode: { useModel: false, deny: ['FORBIDDEN'] } } }),
  );
  const previous = process.env.PIRC_CONFIG_DIR;
  process.env.PIRC_CONFIG_DIR = configDir;
  cleanups.push(() => {
    if (previous === undefined) delete process.env.PIRC_CONFIG_DIR;
    else process.env.PIRC_CONFIG_DIR = previous;
  });
  const cwd = path.join(root, 'workspace');
  mkdirSync(cwd);
  writeFileSync(path.join(cwd, 'hello.txt'), 'hello executor');
  const state = path.join(root, 'session');
  mkdirSync(state);
  const config = testConfig({ sandbox: { srt: path.resolve('test/fixtures/fake-srt.sh') } });
  const sandbox = new NodeSandbox(config);
  const prepared = await sandbox.prepare({
    sessionId: randomUUID(),
    workspaceRoot: cwd,
    sessionDir: state,
    environmentExecutor: true,
  });
  let requests = 0;
  let approvalPayload: any;
  const executor = new SandboxedEnvironmentExecutor({
    sandbox: prepared,
    cwd,
    request: async (kind, payload) => {
      requests++;
      if (kind === 'approval') {
        approvalPayload = payload;
        return false;
      }
      if (kind === 'lease') return null;
      throw new Error('unexpected broker request');
    },
  });
  cleanups.push(() => executor.close());
  await executor.started;
  const value = {
    binding: {
      nodeId: 'n',
      workspaceId: 'n:w',
      sessionId: randomUUID(),
      writerEpoch: randomUUID(),
      executorEpoch: randomUUID(),
    },
    executionId: randomUUID(),
    runId: randomUUID(),
    turnId: randomUUID(),
    toolCallId: randomUUID(),
    capability: 'read',
    arguments: { path: 'hello.txt' },
    descriptorRevision: 'a'.repeat(64),
    policyRevision: 'b'.repeat(64),
    budgetMs: 1000,
  };
  const result = await executor.execute(
    { ...value, argumentDigest: intentDigest(value) },
    new AbortController().signal,
    () => {},
  );
  expect(result.state).toBe('completed');
  expect(JSON.stringify(result.output)).toContain('hello executor');
  expect(requests).toBe(0);
  const shell = {
    ...value,
    executionId: randomUUID(),
    capability: 'bash',
    arguments: { command: "printf '%100000s' x" },
  };
  let maxProgress = 0;
  const large = await executor.execute(
    { ...shell, argumentDigest: intentDigest(shell) },
    new AbortController().signal,
    (_kind, payload) => {
      maxProgress = Math.max(maxProgress, Buffer.byteLength(JSON.stringify(payload)));
    },
  );
  expect(large.state).toBe('completed');
  expect(large.truncated).toBe(true);
  expect(maxProgress).toBeLessThan(32_768);
  const command = 'echo FORBIDDEN' + ' '.repeat(5000) + 'final-suffix';
  const dangerous = {
    ...value,
    executionId: randomUUID(),
    capability: 'bash',
    arguments: { command },
  };
  const denied = await executor.execute(
    { ...dangerous, argumentDigest: intentDigest(dangerous) },
    new AbortController().signal,
    () => {},
  );
  expect(denied.state).toBe('failed');
  expect(approvalPayload.action.text).toBe(command);
  expect(approvalPayload.arguments.command).toBe(command);
  expect(approvalPayload.finalArgumentDigest).toMatch(/^[a-f0-9]{64}$/);
}, 10_000);
