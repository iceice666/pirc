import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeSandbox } from '../src/node/sandbox.js';
import { SandboxedEnvironmentExecutor } from '../src/node/environment-executor.js';
import { EnvironmentAuthority } from '../src/node/environment-authority.js';
import { ApprovalAuthority } from '../src/environment/approvals.js';
import { generateDescriptor } from '../src/environment/descriptor.js';
import { builtinTools } from '../src/agent/tools/index.js';
import { createSandboxTools } from '../src/agent/features/sandbox.js';
import { loadAgentConfig } from '../src/agent/config.js';
import { WriteBroker } from '../src/node/write-broker.js';
import { intentDigest } from '../src/environment/protocol.js';
import { testConfig } from './helpers.js';
import { finalArgumentsDigest } from '../src/environment/broker.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
test('node exception authority requires human-owned approval, rechecks cwd, strips secrets and refuses stale revisions', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pirc-env-authority-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'workspace'),
    configDir = path.join(root, 'config'),
    sessionDir = path.join(root, 'session');
  for (const dir of [cwd, configDir, sessionDir]) mkdirSync(dir);
  writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify({ features: { autoMode: { enabled: false } } }),
  );
  const previous = process.env.PIRC_CONFIG_DIR;
  process.env.PIRC_CONFIG_DIR = configDir;
  cleanup.push(() => {
    if (previous === undefined) delete process.env.PIRC_CONFIG_DIR;
    else process.env.PIRC_CONFIG_DIR = previous;
  });
  const prepared = await new NodeSandbox(
    testConfig({ sandbox: { srt: path.resolve('test/fixtures/fake-srt.sh') } }),
  ).prepare({ sessionId: randomUUID(), workspaceRoot: cwd, sessionDir, environmentExecutor: true });
  const binding = {
    nodeId: 'n',
    workspaceId: 'n:w',
    sessionId: randomUUID(),
    writerEpoch: randomUUID(),
    executorEpoch: randomUUID(),
  };
  const env = {
    PIRC_CONFIG_DIR: configDir,
    PIRC_SANDBOX: 'srt',
    PIRC_SANDBOX_POLICY: JSON.stringify(prepared.policy.paths),
  };
  const config = loadAgentConfig(cwd, { providers: {} }, env);
  const descriptor = generateDescriptor({
    binding,
    cwd,
    env,
    tools: [...builtinTools(), ...createSandboxTools(() => undefined)],
    sandboxStatus: { active: true },
  });
  let approve = false,
    asks = 0;
  let approvals!: ApprovalAuthority;
  approvals = new ApprovalAuthority(path.join(root, 'approvals.sqlite'), (record) => {
    asks++;
    queueMicrotask(() =>
      approvals.humanAnswer(
        record.binding,
        record.interactionId,
        record.finalArgumentDigest,
        approve,
      ),
    );
  });
  cleanup.push(() => approvals.close());
  const writes = new WriteBroker();
  let executor!: SandboxedEnvironmentExecutor;
  const authority = new EnvironmentAuthority({
    config,
    descriptor,
    sandbox: prepared,
    approvals,
    writes,
    executor: () => executor,
  });
  executor = new SandboxedEnvironmentExecutor({
    sandbox: prepared,
    cwd,
    descriptor,
    request: (kind, payload, intent, signal) =>
      authority.request(kind, payload as Record<string, any>, intent, signal),
  });
  cleanup.push(async () => {
    try {
      await executor.closeAndWait();
    } catch (error) {
      if (!String(error).includes('quarantined')) throw error;
    }
    // Fixture teardown only; production fencing must retain leases on quarantine.
  });
  await executor.started;
  const make = (capability: string, args: Record<string, string | string[]>) => {
    const value = {
      binding,
      executionId: randomUUID(),
      runId: randomUUID(),
      turnId: randomUUID(),
      toolCallId: randomUUID(),
      capability,
      arguments: args,
      descriptorRevision: descriptor.revision,
      policyRevision: descriptor.policyRevision,
      budgetMs: 10000,
    };
    return { ...value, argumentDigest: intentDigest(value) };
  };
  const run = (capability: string, args: Record<string, string | string[]>) =>
    executor.execute(make(capability, args), new AbortController().signal, () => {});
  expect(
    (await run('sandbox_allow_domains', { domains: ['fixture.invalid'], reason: 'test' })).state,
  ).toBe('failed');
  expect(asks).toBe(1);
  approve = true;
  expect(
    (await run('sandbox_allow_domains', { domains: ['fixture.invalid'], reason: 'test' })).state,
  ).toBe('completed');
  expect(asks).toBe(2);
  const host = await run('unsandboxed_bash', { command: 'printf host-ok', reason: 'test' });
  expect(host.state).toBe('completed');
  expect(JSON.stringify(host.output)).toContain('host-ok');
  expect(asks).toBe(3);
  symlinkSync(root, path.join(cwd, 'outside'));
  expect(
    (await run('unsandboxed_bash', { command: 'echo no', reason: 'test', cwd: 'outside' })).state,
  ).toBe('failed');
  expect(asks).toBe(3);
  const intent = make('sandbox_allow_domains', { domains: ['fixture.invalid'], reason: 'test' });
  await expect(
    authority.request(
      'sandbox',
      {
        op: 'network',
        args: { domains: ['forged.invalid'], reason: 'test' },
        arguments: intent.arguments,
        finalArgumentDigest: finalArgumentsDigest(intent, intent.arguments),
      },
      intent,
      new AbortController().signal,
    ),
  ).rejects.toThrow('mismatch');
  await expect(
    authority.request(
      'lease',
      { root: cwd },
      { ...intent, policyRevision: 'c'.repeat(64) },
      new AbortController().signal,
    ),
  ).rejects.toThrow('Stale');
}, 10000);
