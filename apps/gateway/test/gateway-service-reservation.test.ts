import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { GatewayAgentRuntime } from '../src/gateway-runtime/runtime.js';
import { GatewaySessionAuthority } from '../src/gateway-runtime/authority.js';
import { descriptorDigest, type Descriptor, type Binding } from '../src/environment/protocol.js';
import { emptyUsage } from '../src/agent/messages.js';

test('reserved service configuration rejects UI/sibling work and cancellation prevents later admission', async () => {
  const authority = new GatewaySessionAuthority(':memory:');
  let runtime: GatewayAgentRuntime | undefined, sibling: GatewayAgentRuntime | undefined;
  try {
    const lease = authority.activate({
      ...authority.prepare({
        owner: 'alice',
        nodeId: 'n',
        workspaceId: 'n:w',
        legacySessionIds: [],
      }),
      fenced: true,
    });
    const options = {
      authority,
      environment: {} as any,
      inference: {} as any,
      online: () => true,
      models: [
        { provider: 'fake', id: 'scheduled', contextWindow: 10000, thinking: 'off' as const },
        { provider: 'fake', id: 'ui', contextWindow: 10000, thinking: 'off' as const },
      ],
      authorizeModel: () => {},
      workerExecutable: '/unused',
      systemPrompt: '',
      tools: [],
    };
    runtime = new GatewayAgentRuntime(options);
    sibling = new GatewayAgentRuntime(options);
    const id = randomUUID(),
      input = { runId: id, turnId: id, text: 'task', attachments: [] };
    let configuring!: () => void;
    const entered = new Promise<void>((resolve) => {
      configuring = resolve;
    });
    const admitted = runtime.serviceDelivery(lease, 'alice', input, async (signal) => {
      runtime!.selectModel(lease, 'alice', 'fake', 'scheduled');
      configuring();
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
    });
    await entered;
    expect(() => runtime!.selectModel(lease, 'alice', 'fake', 'ui')).toThrow('busy');
    expect(() => sibling!.selectThinking(lease, 'alice', 'high')).toThrow('busy');
    await expect(
      sibling.run(lease, 'alice', { ...input, runId: randomUUID(), turnId: randomUUID() }),
    ).rejects.toThrow('busy');
    await runtime.cancel(lease.binding.sessionId, 'alice');
    await expect(admitted).rejects.toThrow('cancelled');
    expect(authority.runState(lease.binding.sessionId, 'alice', input.runId)).toBeUndefined();
  } finally {
    await runtime?.close();
    await sibling?.close();
    authority.close();
  }
});

test('five concurrent service runs wait for the four descriptor preparation slots', async () => {
  const authority = new GatewaySessionAuthority(':memory:');
  let runtime: GatewayAgentRuntime | undefined;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let descriptions = 0;
  try {
    const leases = Array.from({ length: 5 }, () =>
      authority.activate({
        ...authority.prepare({
          owner: 'alice',
          nodeId: 'n',
          workspaceId: 'n:w',
          legacySessionIds: [],
        }),
        fenced: true,
      }),
    );
    runtime = new GatewayAgentRuntime({
      authority,
      environment: {
        describe: async (binding: Binding) => {
          descriptions++;
          await gate;
          const descriptor: Descriptor = {
            binding,
            version: 1,
            revision: '',
            policyRevision: 'a'.repeat(64),
            capabilityCatalog: [],
            instructions: '',
            skills: [],
            role: 'general',
            platform: 'linux',
            cwdDisplay: '/node',
            sandboxStatus: { active: true },
            limits: { maxActive: 1, maxBudgetMs: 1000 },
          };
          descriptor.revision = descriptorDigest(descriptor);
          return descriptor;
        },
        pinArtifact: async () => {},
        fetchArtifact: async () => {
          throw Error('No artifact');
        },
      } as any,
      inference: {
        run: async () => ({
          role: 'assistant',
          api: 'openai-chat',
          provider: 'fake',
          model: 'fake',
          content: [{ type: 'text', text: 'done' }],
          usage: emptyUsage(),
          stopReason: 'stop',
          timestamp: Date.now(),
        }),
      },
      online: () => true,
      models: [{ provider: 'fake', id: 'fake', contextWindow: 10000, thinking: 'off' }],
      authorizeModel: () => {},
      workerExecutable: '/unused',
      systemPrompt: '',
      tools: [],
      workerFactory: () => ({
        drive: async (step, signal) => {
          let action: any = 'model';
          while (true) {
            signal.throwIfAborted();
            const next = await step(action);
            if (action === 'done') return;
            action = next;
          }
        },
        close: async () => {},
      }),
    });
    const starts = leases.map((lease) => {
      const id = randomUUID();
      return runtime!.serviceDelivery(
        lease,
        'alice',
        { runId: id, turnId: id, text: 'task', attachments: [] },
        async () => {},
      );
    });
    await Bun.sleep(100);
    expect(descriptions).toBe(4);
    release();
    const results = await Promise.all(starts);
    expect(results.map((result) => result?.state)).toEqual(Array(5).fill('completed'));
    // Without attachments nothing awaits between attestation and commit, so one describe
    // per turn suffices; attachment turns re-attest after loading (turn-lifecycle test).
    expect(descriptions).toBe(5);
  } finally {
    release();
    await runtime?.close();
    authority.close();
  }
});
