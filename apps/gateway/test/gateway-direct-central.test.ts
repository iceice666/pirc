import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { GatewaySessionAuthority } from '../src/gateway-runtime/authority.js';
import { GatewayCapabilities } from '../src/gateway-runtime/capabilities.js';
import { DirectCentral } from '../src/gateway-runtime/direct-central.js';
import { capabilityMetadata } from '../src/environment/catalog.js';
import {
  descriptorDigest,
  intentDigest,
  type Descriptor,
  type ExecutionIntent,
} from '../src/environment/protocol.js';
function fixture(
  handler: (signal: AbortSignal) => Promise<Record<string, unknown>>,
  budgetMs = 1000,
) {
  const authority = new GatewaySessionAuthority(':memory:');
  const lease = authority.activate({
    ...authority.prepare({ owner: 'alice', nodeId: 'n', workspaceId: 'n:w', legacySessionIds: [] }),
    fenced: true,
  });
  const descriptor: Descriptor = {
    binding: lease.binding,
    version: 1,
    revision: '',
    policyRevision: 'a'.repeat(64),
    capabilityCatalog: [
      {
        name: 'web_search',
        ...capabilityMetadata('web_search'),
        argumentSchema: { type: 'object' },
        resultSchema: { type: 'object' },
        hookRevision: 'b'.repeat(64),
      },
    ],
    instructions: '',
    skills: [],
    role: 'general',
    platform: 'linux',
    cwdDisplay: '/node',
    sandboxStatus: { active: true },
    limits: { maxActive: 1, maxBudgetMs: 1000 },
  };
  descriptor.revision = descriptorDigest(descriptor);
  const turn = { runId: randomUUID(), turnId: randomUUID(), text: 'search', attachments: [] };
  authority.commitTurn(lease, turn, descriptor, []);
  const value = {
    binding: lease.binding,
    executionId: randomUUID(),
    runId: turn.runId,
    turnId: turn.turnId,
    toolCallId: randomUUID(),
    capability: 'web_search',
    arguments: { query: 'x' },
    descriptorRevision: descriptor.revision,
    policyRevision: descriptor.policyRevision,
    budgetMs,
  };
  const intent: ExecutionIntent = { ...value, argumentDigest: intentDigest(value) };
  authority.persistExecution(lease, intent);
  const service = new DirectCentral({
    authority,
    authorize: () => {},
    capabilities: new GatewayCapabilities({
      inner: authority.inner,
      descriptor: () => descriptor,
      authorize: () => {},
      capabilities: new Map([
        ['web_search', { execute: async (_args, _intent, signal) => handler(signal) }],
      ]),
    }),
  });
  return { authority, lease, intent, service };
}
test('direct central web projection has stable start/status digests for lost ACK recovery', async () => {
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    return { text: 'search result' };
  });
  try {
    const first = await f.service.start(f.intent, new AbortController().signal);
    expect((first.terminal!.output as any).content[0].text).toContain('Untrusted');
    expect((await f.service.status(f.intent)).resultDigest).toBe(first.resultDigest);
    expect((await f.service.status(f.intent)).resultDigest).toBe(first.resultDigest);
    f.authority.commitResult(first);
    f.authority.commitResult(await f.service.status(f.intent));
    expect(calls).toBe(1);
  } finally {
    f.authority.close();
  }
});
test('direct central active budget aborts cooperative handler and preserves original evidence', async () => {
  const f = fixture(async (signal) => {
    await new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => resolve(), { once: true });
      if (signal.aborted) resolve();
    });
    throw new Error('aborted');
  }, 30);
  try {
    const start = performance.now();
    const result = await f.service.start(f.intent, new AbortController().signal);
    expect(performance.now() - start).toBeLessThan(1000);
    expect(result.effect).toBe('unknown');
  } finally {
    f.authority.close();
  }
});
test('held direct central effect remains running through cancellation and cannot clear admission', async () => {
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve)),
    started = new Promise<void>((resolve) => (entered = resolve));
  const f = fixture(async () => {
    entered();
    await held;
    return { text: 'finished' };
  });
  try {
    const controller = new AbortController(),
      running = f.service.start(f.intent, controller.signal);
    await started;
    controller.abort();
    expect((await f.service.status(f.intent)).state).toBe('running');
    expect(f.authority.hasUnresolvedExecutions(f.lease.binding.sessionId, 'alice')).toBe(true);
    release();
    const terminal = await running;
    f.authority.commitResult(terminal);
    expect(f.authority.hasUnresolvedExecutions(f.lease.binding.sessionId, 'alice')).toBe(false);
  } finally {
    release();
    f.authority.close();
  }
});
