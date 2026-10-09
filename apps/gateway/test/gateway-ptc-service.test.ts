import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { ExecutionJournal } from '../src/environment/journal.js';
import { GatewayPtcService } from '../src/gateway-runtime/ptc-service.js';
import { capabilityMetadata } from '../src/environment/catalog.js';
import {
  descriptorDigest,
  intentDigest,
  type Descriptor,
  type ExecutionIntent,
  type Environment,
} from '../src/environment/protocol.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
const native = process.env.PIRC_TEST_NATIVE_PTC ? test : test.skip;
native(
  'gateway-only PTC uses isolated guest and persistent central result identity',
  async () => {
    const journal = new ExecutionJournal(':memory:');
    cleanups.push(() => journal.close());
    const binding = {
      nodeId: 'n',
      workspaceId: 'n:w',
      sessionId: randomUUID(),
      writerEpoch: randomUUID(),
      executorEpoch: randomUUID(),
    };
    const descriptor: Descriptor = {
      binding,
      version: 1,
      revision: '',
      policyRevision: 'b'.repeat(64),
      capabilityCatalog: [
        {
          name: 'web_search',
          ...capabilityMetadata('web_search'),
          argumentSchema: {},
          resultSchema: {},
          hookRevision: 'c'.repeat(64),
        },
      ],
      instructions: '',
      skills: [],
      role: 'general',
      platform: process.platform === 'darwin' ? 'darwin' : 'linux',
      cwdDisplay: '/workspace',
      sandboxStatus: { active: true },
      limits: { maxActive: 1, maxBudgetMs: 600_000 },
    };
    descriptor.revision = descriptorDigest(descriptor);
    let central = 0,
      node = 0;
    const unsupported = async (): Promise<never> => {
      node++;
      throw new Error('Unexpected node RPC');
    };
    const environment: Environment = {
      describe: unsupported,
      start: unsupported,
      status: unsupported,
      cancel: unsupported,
      ack: unsupported,
    };
    const service = new GatewayPtcService({
      environment,
      journal,
      inner: journal.inner,
      workerExecutable: process.env.PIRC_TEST_NATIVE_PTC!,
      online: () => true,
      central: async (intent) => {
        journal.inner.claim(intent.binding, intent.parentExecutionId!, intent.innerOperationId!);
        central++;
        return {
          ok: true,
          contractVersion: 1,
          operationId: intent.innerOperationId!,
          data: { text: 'result' },
          attachments: [],
          truncated: false,
        };
      },
    });
    const branch = randomUUID();
    const value = {
      binding,
      executionId: randomUUID(),
      runId: randomUUID(),
      turnId: randomUUID(),
      toolCallId: randomUUID(),
      descriptorRevision: descriptor.revision,
      policyRevision: descriptor.policyRevision,
      capability: 'ptc',
      arguments: {
        code: 'const found=await tools.web_search({query:"test"});store("found",found.text);return found.text;',
      },
      budgetMs: 120_000,
      ptc: { branchId: branch, revision: branch, store: '{}', untrusted: [] },
    };
    const intent: ExecutionIntent = { ...value, argumentDigest: intentDigest(value) };
    const first = await service.start(intent, descriptor, new AbortController().signal);
    expect(first.state).toBe('completed');
    expect(central).toBe(1);
    expect(node).toBe(0);
    expect(JSON.stringify(first.terminal?.output)).toContain('found');
    expect(
      (await service.start(intent, descriptor, new AbortController().signal)).resultDigest,
    ).toBe(first.resultDigest);
    expect(central).toBe(1);
    expect(journal.inner.list(binding, intent.executionId)).toHaveLength(1);
    await service.acknowledge(intent, first.resultDigest!);
    expect((await service.status(intent)).acknowledged).toBe(true);
  },
  35_000,
);
