import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeSandbox } from '../src/node/sandbox.js';
import { SandboxedEnvironmentExecutor } from '../src/node/environment-executor.js';
import { generateDescriptor } from '../src/environment/descriptor.js';
import { ExecutionJournal } from '../src/environment/journal.js';
import { HookReceipts } from '../src/environment/hook-receipts.js';
import { JournaledNodeHooks } from '../src/environment/node-hooks.js';
import { GatewayOperations } from '../src/environment/gateway-operation.js';
import { intentDigest } from '../src/environment/protocol.js';
import { testConfig } from './helpers.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
test('gateway-native pre/post hooks run in shipped sandbox executor and duplicates do not replay', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pirc-env-hook-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'workspace'),
    configDir = path.join(root, 'config'),
    state = path.join(root, 'session');
  for (const dir of [cwd, configDir, state]) mkdirSync(dir);
  writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify({
      hooks: {
        beforeTool: [
          { command: `echo pre >> '${cwd}/hooks.txt'; echo '{"args":{"query":"rewritten"}}'` },
        ],
        afterTool: [{ command: `echo post >> '${cwd}/hooks.txt'` }],
      },
    }),
  );
  const previous = process.env.PIRC_CONFIG_DIR;
  process.env.PIRC_CONFIG_DIR = configDir;
  cleanup.push(() => {
    if (previous === undefined) delete process.env.PIRC_CONFIG_DIR;
    else process.env.PIRC_CONFIG_DIR = previous;
  });
  const prepared = await new NodeSandbox(
    testConfig({ sandbox: { srt: path.resolve('test/fixtures/fake-srt.sh') } }),
  ).prepare({
    sessionId: randomUUID(),
    workspaceRoot: cwd,
    sessionDir: state,
    environmentExecutor: true,
  });
  const binding = {
    nodeId: 'n',
    workspaceId: 'n:w',
    sessionId: randomUUID(),
    writerEpoch: randomUUID(),
    executorEpoch: randomUUID(),
  };
  const tool = {
    name: 'web_search',
    description: '',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false,
    },
    resultSchema: { type: 'object' },
    execute: async () => {
      throw new Error('not node execution');
    },
  };
  const descriptor = generateDescriptor({
    binding,
    cwd,
    tools: [tool],
    sandboxStatus: { active: true },
  });
  const executor = new SandboxedEnvironmentExecutor({
    sandbox: prepared,
    cwd,
    descriptor,
    request: async () => {
      throw new Error('unexpected');
    },
  });
  cleanup.push(async () => {
    try {
      await executor.closeAndWait();
    } catch (error) {
      if (!String(error).includes('quarantined')) throw error;
    }
  });
  await executor.started;
  const journal = new ExecutionJournal(path.join(root, 'journal.sqlite'));
  cleanup.push(() => journal.close());
  journal.provision(binding, descriptor.revision, descriptor.policyRevision);
  const receipts = new HookReceipts(path.join(root, 'receipts.sqlite'));
  cleanup.push(() => receipts.close());
  const hooks = new JournaledNodeHooks(path.join(root, 'phases.sqlite'), {
    journal,
    receipts,
    executor: () => executor,
    authorize: () => {},
  });
  cleanup.push(() => hooks.close());
  const central = new GatewayOperations(path.join(root, 'central.sqlite'));
  cleanup.push(() => central.close());
  const value = {
    binding,
    executionId: randomUUID(),
    runId: randomUUID(),
    turnId: randomUUID(),
    toolCallId: randomUUID(),
    capability: 'web_search',
    arguments: { query: 'original' },
    descriptorRevision: descriptor.revision,
    policyRevision: descriptor.policyRevision,
    budgetMs: 1000,
  };
  const intent = { ...value, argumentDigest: intentDigest(value) };
  let effects = 0;
  const options = {
    hooks,
    schema: tool.parameters,
    signal: new AbortController().signal,
    authorize: () => {},
    mutate: (_db: typeof central.db, args: unknown) => {
      effects++;
      expect(args).toEqual({ query: 'rewritten' });
      return {
        state: 'completed' as const,
        effect: 'completed' as const,
        artifacts: [],
        truncated: false,
      };
    },
  };
  expect((await central.execute(intent, options)).post).toBe('completed');
  await central.execute(intent, options);
  expect(effects).toBe(1);
  expect(await Bun.file(path.join(cwd, 'hooks.txt')).text()).toBe('pre\npost\n');
}, 10000);
