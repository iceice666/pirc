import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateDescriptor } from '../src/environment/descriptor.js';
import { builtinTools } from '../src/agent/tools/index.js';
import { projectTrustHash, projectTrustFields, readProjectConfig } from '../src/agent/config.js';
import { ExecutionBudget } from '../src/environment/budget.js';
import { validateBroker, finalArgumentsDigest } from '../src/environment/broker.js';
import { intentDigest, type ExecutionIntent } from '../src/environment/protocol.js';
import { ExecutionJournal } from '../src/environment/journal.js';
import { EnvironmentArtifacts } from '../src/environment/artifacts.js';
import {
  ArtifactTransfer,
  modelArtifactImage,
  uiArtifact,
} from '../src/environment/artifact-transfer.js';
import { SharedNodeLink } from '../src/shared-node-link.js';
import { GatewayOperations } from '../src/environment/gateway-operation.js';
import { EnvironmentAdmission } from '../src/environment/admission.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn();
});
function root() {
  const value = mkdtempSync(path.join(os.tmpdir(), 'pirc-m2-'));
  cleanups.push(() => rmSync(value, { recursive: true, force: true }));
  return value;
}
function intent(): ExecutionIntent {
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
    capability: 'bash',
    arguments: { command: 'echo ok' },
    descriptorRevision: 'a'.repeat(64),
    policyRevision: 'b'.repeat(64),
    budgetMs: 1000,
  };
  return { ...value, argumentDigest: intentDigest(value) };
}

test('descriptors use trusted config and explicit ownership without serializing hook/env secrets', () => {
  const cwd = root(),
    configDir = path.join(cwd, 'config');
  mkdirSync(configDir);
  mkdirSync(path.join(cwd, '.pirc'));
  writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify({ env: { GLOBAL_SECRET: 'secret-value' } }),
  );
  writeFileSync(
    path.join(cwd, '.pirc/config.json'),
    JSON.stringify({
      env: { PROJECT_SECRET: 'project-value' },
      hooks: { beforeTool: [{ command: 'secret-hook-command' }] },
    }),
  );
  writeFileSync(path.join(cwd, 'AGENTS.md'), 'untrusted project instructions');
  const options = {
    binding: intent().binding,
    cwd,
    tools: builtinTools(),
    env: { PIRC_CONFIG_DIR: configDir },
    sandboxStatus: { active: true },
  };
  const untrusted = generateDescriptor(options);
  const trusted = generateDescriptor({
    ...options,
    env: {
      ...options.env,
      PIRC_PROJECT_TRUST: projectTrustHash(projectTrustFields(readProjectConfig(cwd))),
    },
  });
  expect(trusted.policyRevision).not.toBe(untrusted.policyRevision);
  expect(trusted.instructions).toContain('untrusted project instructions');
  expect(JSON.stringify(trusted)).not.toContain('secret-value');
  expect(JSON.stringify(trusted)).not.toContain('project-value');
  expect(JSON.stringify(trusted)).not.toContain('secret-hook-command');
  expect(
    generateDescriptor({ ...options, allowedTools: ['read'] }).capabilityCatalog.map(
      (entry) => entry.name,
    ),
  ).toEqual(['read']);
  expect(() =>
    generateDescriptor({ ...options, tools: [{ ...builtinTools()[0]!, name: 'unclassified' }] }),
  ).toThrow('Missing capability ownership');
});

test('broker validates final hook arguments and rejects spoofed digest/schema', () => {
  const value = intent(),
    action = { tool: 'bash', kind: 'command', text: 'echo ok', cwd: '/workspace' };
  const payload = {
    action,
    reason: 'test',
    arguments: value.arguments,
    finalArgumentDigest: finalArgumentsDigest(
      value,
      value.arguments as Record<string, unknown>,
      action,
    ),
  };
  const schema = builtinTools().find((tool) => tool.name === 'bash')!.parameters;
  expect(validateBroker('approval', payload, value, schema).action.text).toBe('echo ok');
  expect(() =>
    validateBroker('approval', { ...payload, arguments: { command: 'changed' } }, value, schema),
  ).toThrow('digest');
  expect(() => validateBroker('approval', { ...payload, fake: true }, value, schema)).toThrow();
});

test('human waits pause active budget but do not extend absolute lifetime', async () => {
  const budget = new ExecutionBudget(40, 50);
  cleanups.push(() => budget.close());
  budget.beginHumanWait();
  await Bun.sleep(55);
  expect(budget.controller.signal.aborted).toBe(false);
  await Bun.sleep(45);
  expect(budget.controller.signal.aborted).toBe(true);
});

test('shared socket fragments legacy bulk while controls progress and credit is durable', async () => {
  let a!: SharedNodeLink, b!: SharedNodeLink;
  const received: string[] = [],
    sizes: number[] = [];
  const failures: Error[] = [];
  a = new SharedNodeLink({
    send: async (raw) => {
      sizes.push(Buffer.byteLength(raw));
      queueMicrotask(() => {
        void b.receive(raw).catch((error) => failures.push(error));
      });
    },
    receive: () => {},
    fail: (error) => failures.push(error),
  });
  b = new SharedNodeLink({
    send: async (raw) => {
      queueMicrotask(() => {
        void a.receive(raw).catch((error) => failures.push(error));
      });
    },
    receive: (raw) => received.push(JSON.parse(raw).type),
    fail: (error) => failures.push(error),
  });
  try {
    const large = a.send(
      JSON.stringify({ type: 'response', requestId: 'large', data: 'x'.repeat(5 * 1024 * 1024) }),
    );
    await a.send(
      JSON.stringify({
        type: 'environment.frame',
        kind: 'control',
        message: { type: 'execution.cancel' },
      }),
    );
    await large;
    for (let i = 0; i < 100 && received.length < 2; i++) await Bun.sleep(10);
    expect(received[0]).toBe('environment.frame');
    expect(received).toContain('response');
    expect(Math.max(...sizes)).toBeLessThanOrEqual(65536);
    expect(failures).toEqual([]);
  } finally {
    a.close();
    b.close();
  }
}, 10000);

test('artifact resolver verifies transfer and produces model image; offline UI remains unavailable', async () => {
  const storage = new EnvironmentArtifacts(root());
  cleanups.push(() => storage.close());
  const binding = intent().binding;
  const artifact = await storage.put(binding, Buffer.from('image fixture'), 'image/png');
  const transfer = new ArtifactTransfer({
    storage,
    online: () => true,
    authorize: (actual) => {
      if (actual.sessionId !== binding.sessionId) throw new Error('owner');
    },
  });
  expect(
    (await modelArtifactImage(binding, artifact, (request) => transfer.fetch(request))).data,
  ).toBe(Buffer.from('image fixture').toString('base64'));
  expect(uiArtifact(artifact, false).availability).toBe('unavailable');
  await expect(
    modelArtifactImage(binding, artifact, async (request) => ({
      offset: request.offset,
      data: Buffer.alloc(request.limit).toString('base64'),
    })),
  ).rejects.toThrow('digest');
});

test('central DB effects and results commit atomically and duplicates never rerun hooks/effects', async () => {
  const operations = new GatewayOperations(':memory:');
  cleanups.push(() => operations.close());
  operations.db.exec('CREATE TABLE mutations(value INTEGER)');
  let pre = 0,
    post = 0;
  const value = intent();
  const options = {
    schema: builtinTools().find((tool) => tool.name === 'bash')!.parameters,
    signal: new AbortController().signal,
    authorize: () => {},
    hooks: {
      preflight: async () => {
        pre++;
        return { arguments: value.arguments, receiptId: 'receipt', receiptDigest: 'digest' };
      },
      consume: async () => value.arguments,
      post: async () => {
        post++;
        throw new Error('post failed');
      },
    },
    mutate: (db: typeof operations.db) => {
      db.query('INSERT INTO mutations VALUES (1)').run();
      return {
        state: 'completed' as const,
        effect: 'completed' as const,
        artifacts: [],
        truncated: false,
      };
    },
  };
  expect((await operations.execute(value, options)).post).toBe('unknown');
  expect((await operations.execute(value, options)).terminal.state).toBe('completed');
  expect(pre).toBe(1);
  expect(post).toBe(1);
  expect(operations.db.query('SELECT count(*) AS n FROM mutations').get()).toEqual({ n: 1 });
});

test('journal soft cap rejects new work and retired compaction preserves a permanent fence', () => {
  const value = intent();
  let now = 0;
  const journal = new ExecutionJournal(':memory:', () => now, 20 * 1024 * 1024);
  cleanups.push(() => journal.close());
  journal.provision(value.binding, value.descriptorRevision, value.policyRevision);
  journal.accept(value);
  journal.claim(value.binding, value.executionId);
  const second = { ...value, executionId: randomUUID() };
  second.argumentDigest = intentDigest(second);
  expect(() => journal.accept(second)).toThrow('soft cap');
  const result = journal.finish(value.binding, value.executionId, {
    state: 'completed',
    effect: 'completed',
    artifacts: [],
    truncated: false,
  });
  journal.ack(value.binding, value.executionId, result.resultDigest!);
  now = 86400001;
  journal.retire(value.binding);
  expect(journal.compactRetired(value.binding)).toBe(1);
  expect(() =>
    journal.provision(value.binding, value.descriptorRevision, value.policyRevision),
  ).toThrow('Retired');
  expect(() => journal.accept(value)).toThrow('Retired');
});

test('fair admission skips busy sessions, cancels queued work and bounds bytes', async () => {
  const admission = new EnvironmentAdmission();
  const started: string[] = [];
  let release!: () => void;
  const item = (id: string, session: string, start: () => Promise<void>) => ({
    id,
    node: 'n',
    session,
    bytes: 100,
    deadline: performance.now() + 1000,
    ready: () => true,
    start,
    expire: () => {},
  });
  admission.reserve(
    item('a1', 'a', async () => {
      started.push('a1');
      await new Promise<void>((resolve) => (release = resolve));
    }),
  );
  admission.reserve(
    item('a2', 'a', async () => {
      started.push('a2');
    }),
  );
  admission.reserve(
    item('b1', 'b', async () => {
      started.push('b1');
    }),
  );
  admission.wake();
  await Bun.sleep(5);
  expect(started).toEqual(['a1', 'b1']);
  admission.remove('a2');
  release();
  await Bun.sleep(5);
  expect(started).toEqual(['a1', 'b1']);
});
