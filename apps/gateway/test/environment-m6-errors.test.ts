import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  EnvironmentCodeError,
  EnvironmentProtocolError,
  LocalEnvironment,
  dispatchEnvironment,
  environmentError,
  type EnvironmentExecutor,
} from '../src/environment/service.js';
import { EnvironmentRequestError, RemoteEnvironment } from '../src/environment/remote.js';
import { ExecutionJournal } from '../src/environment/journal.js';
import { nodeEnvironmentReceiver } from '../src/environment/node-channel.js';
import type { CentralLink } from '../src/environment/central-link.js';
import {
  decodeMessage,
  descriptorDigest,
  encodeMessage,
  intentDigest,
  type Binding,
  type Descriptor,
  type EnvironmentMessage,
  type ExecutionIntent,
} from '../src/environment/protocol.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
const binding = (): Binding => ({
  nodeId: 'n',
  workspaceId: 'n:w',
  sessionId: randomUUID(),
  writerEpoch: randomUUID(),
  executorEpoch: randomUUID(),
});
function descriptorFor(bound: Binding): Descriptor {
  const content: Omit<Descriptor, 'revision'> = {
    binding: bound,
    version: 1,
    policyRevision: 'a'.repeat(64),
    capabilityCatalog: [
      {
        name: 'read',
        argumentSchema: {},
        resultSchema: {},
        placement: 'node',
        effects: 'read',
        concurrency: 'read',
        approval: 'policy',
        hookRevision: 'b'.repeat(64),
      },
    ],
    instructions: '',
    skills: [],
    role: 'coding',
    platform: 'linux',
    cwdDisplay: '/fixture',
    sandboxStatus: { active: true },
    limits: { maxActive: 1, maxBudgetMs: 1000 },
  };
  return { ...content, revision: descriptorDigest(content) };
}
function intentFor(
  descriptor: Descriptor,
  overrides: Partial<ExecutionIntent> = {},
): ExecutionIntent {
  const value = {
    binding: descriptor.binding,
    executionId: randomUUID(),
    runId: randomUUID(),
    turnId: randomUUID(),
    toolCallId: randomUUID(),
    capability: 'read',
    arguments: {},
    descriptorRevision: descriptor.revision,
    policyRevision: descriptor.policyRevision,
    budgetMs: 1000,
    ...overrides,
  };
  return { ...value, argumentDigest: intentDigest(value) } as ExecutionIntent;
}
const executor = (healthy = true): EnvironmentExecutor & { runs: number } => {
  const value = {
    healthy,
    runs: 0,
    async execute() {
      value.runs++;
      return {
        state: 'completed' as const,
        effect: 'completed' as const,
        artifacts: [],
        truncated: false,
      };
    },
  };
  return value;
};

/** Node receiver wired straight back into a RemoteEnvironment, with a link-failure probe. */
function link() {
  const bound = binding();
  const node = new ExecutionJournal(':memory:');
  const gateway = new ExecutionJournal(':memory:');
  cleanups.push(
    () => node.close(),
    () => gateway.close(),
  );
  const descriptor = descriptorFor(bound);
  const run = executor();
  const local = new LocalEnvironment({
    nodeId: 'n',
    journal: node,
    authorize: () => {},
    unfencedHarness: true,
  });
  local.provision(descriptor, run);
  gateway.provision(bound, descriptor.revision, descriptor.policyRevision);
  const failures: Error[] = [];
  let remote!: RemoteEnvironment;
  const receive = nodeEnvironmentReceiver({
    environment: local,
    central: { receive: async () => false } as unknown as CentralLink,
    send: async (message) => remote.receive(decodeMessage(encodeMessage(message))),
  });
  remote = new RemoteEnvironment({
    nodeId: 'n',
    journal: gateway,
    authorize: () => {},
    timeoutMs: 2000,
    send: async (message) => {
      // As flow.ts does: a receiver rejection closes the link for every run.
      void receive(decodeMessage(encodeMessage(message))).catch((error) => {
        failures.push(error);
        remote.disconnect();
        local.disconnect();
      });
    },
  });
  return { bound, node, gateway, descriptor, local, remote, run, failures };
}

const code = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(EnvironmentRequestError);
    return (error as EnvironmentRequestError).code;
  }
  throw new Error('expected rejection');
};

test('R2: ordinary node refusals become typed environment.error replies; the link survives', async () => {
  const f = link();
  const completed = intentFor(f.descriptor);
  await f.remote.start(completed);
  // Unknown binding, retired-free unknown ID, capability, budget, ID conflict.
  expect(await code(f.remote.describe(binding()))).toBe('invalid_binding');
  expect(await code(f.remote.start(intentFor(f.descriptor, { capability: 'bash' })))).toBe(
    'stale_revision',
  );
  expect(await code(f.remote.start(intentFor(f.descriptor, { budgetMs: 5000 })))).toBe(
    'quota_exceeded',
  );
  const conflict = intentFor(f.descriptor, {
    executionId: completed.executionId,
    arguments: { path: 'x' },
  });
  // The gateway journal refuses the conflicting intent first; ask the node directly.
  const reply = await dispatchEnvironment(f.local, {
    version: 1,
    requestId: randomUUID(),
    type: 'execution.start',
    intent: conflict,
  });
  expect(reply.type === 'environment.error' && reply.error.code).toBe('conflict');
  // The existing message format is preserved for callers matching on text.
  await expect(f.remote.describe(binding())).rejects.toThrow('invalid_binding: Invalid');
  expect(f.failures).toEqual([]);
  // The same link still serves ordinary traffic.
  expect((await f.remote.status(f.bound, completed.executionId)).executionId).toBe(
    completed.executionId,
  );
});

test('R2: sandbox unavailable and retired generations reply typed errors without interrupting other work', async () => {
  const f = link();
  const sick = binding();
  const sickDescriptor = descriptorFor(sick);
  f.local.provision(sickDescriptor, executor(false));
  f.gateway.provision(sick, sickDescriptor.revision, sickDescriptor.policyRevision);
  expect(await code(f.remote.start(intentFor(sickDescriptor)))).toBe('unavailable_sandbox');
  const retired = binding();
  const retiredDescriptor = descriptorFor(retired);
  f.local.provision(retiredDescriptor, executor());
  f.gateway.provision(retired, retiredDescriptor.revision, retiredDescriptor.policyRevision);
  f.node.retire(retired);
  expect(await code(f.remote.start(intentFor(retiredDescriptor)))).toBe('stale_epoch');
  expect(f.failures).toEqual([]);
  const ok = intentFor(f.descriptor);
  expect((await f.remote.start(ok)).executionId).toBe(ok.executionId);
});

test('R2: only protocol violations throw from dispatch and close the link', async () => {
  const f = link();
  await expect(
    dispatchEnvironment(f.local, {
      version: 1,
      requestId: randomUUID(),
      type: 'execution.acknowledged',
    }),
  ).rejects.toBeInstanceOf(EnvironmentProtocolError);
  const sent: EnvironmentMessage[] = [];
  const receive = nodeEnvironmentReceiver({
    environment: f.local,
    central: { receive: async () => false } as unknown as CentralLink,
    send: async (message) => void sent.push(message),
  });
  await expect(
    receive({ version: 1, requestId: randomUUID(), type: 'execution.acknowledged' }),
  ).rejects.toThrow('direction');
  // Workspace service refusals are correlated replies too.
  const requestId = randomUUID();
  await receive({ version: 1, requestId, type: 'workspace.snapshot', binding: f.bound });
  expect(sent).toEqual([
    {
      version: 1,
      requestId,
      type: 'environment.error',
      error: { code: 'unavailable_sandbox', message: 'Workspace memory service unavailable' },
    },
  ]);
});

test('R2: error messages are bounded and never carry filesystem paths', () => {
  const leaked = environmentError(
    new Error(
      `ENOENT: no such file or directory, open '/home/user/.secret/token.json' ${'x'.repeat(4000)}`,
    ),
  );
  // Untyped errors never carry their raw text to the wire: a fixed message per code.
  expect(leaked).toEqual({ code: 'failed', message: 'Environment request failed' });
  expect(environmentError(new Error('Sandbox unavailable: /run/user/1000/secret'))).toEqual({
    code: 'unavailable_sandbox',
    message: 'Environment unavailable',
  });
  expect(environmentError(new EnvironmentCodeError('expired', 'gone'))).toEqual({
    code: 'expired',
    message: 'gone',
  });
  // Typed origin text is still path-redacted and bounded.
  const typed = environmentError(
    new EnvironmentCodeError('conflict', `Clash at /home/user/.secret/x ${'y'.repeat(4000)}`),
  );
  expect(typed.code).toBe('conflict');
  expect(typed.message).not.toContain('/home');
  expect(typed.message).toContain('<path>');
  expect(typed.message.length).toBeLessThanOrEqual(512);
  // Plain "Unknown execution" (no durable fence) is NOT the unknown_execution contract.
  expect(environmentError(new Error('Unknown execution')).code).toBe('unknown');
});
