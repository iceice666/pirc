import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { GatewaySessionAuthority } from '../src/gateway-runtime/authority.js';
import { GatewayAgentRuntime } from '../src/gateway-runtime/runtime.js';
import { descriptorDigest, type Descriptor } from '../src/environment/protocol.js';
import { emptyUsage } from '../src/agent/messages.js';
import { OBS_RECORDED } from '../src/agent/features/memory/ledger.js';

for (const failure of ['throw', 'length', 'small-context', 'partial-length'] as const)
  test(`optional memory uses configured fallback after ${failure} without repeating main model`, async () => {
    const authority = new GatewaySessionAuthority(':memory:');
    let runtime: GatewayAgentRuntime | undefined;
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
      const descriptor: Descriptor = {
        binding: lease.binding,
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
      const requested: string[] = [];
      let observerCalls = 0;
      runtime = new GatewayAgentRuntime({
        authority,
        environment: {
          describe: async () => descriptor,
          pinArtifact: async () => {},
          fetchArtifact: async () => {
            throw Error('No artifact');
          },
        } as any,
        online: () => true,
        inference: {
          run: async (request) => {
            requested.push(request.modelId);
            if (request.modelId === 'observer' && failure === 'throw')
              throw Error('Synthetic observer unavailable');
            if (
              request.modelId === 'observer' &&
              failure === 'partial-length' &&
              observerCalls++ === 0
            ) {
              const source = authority
                .memoryBranch(lease.binding.sessionId, 'alice', lease.branchId)
                .find((entry) => entry.type === 'message' && entry.message.role === 'user')!;
              return {
                role: 'assistant',
                api: 'openai-chat',
                provider: 'fake',
                model: request.modelId,
                content: [
                  {
                    type: 'toolCall',
                    id: 'observation',
                    name: 'record_observations',
                    arguments: {
                      observations: [
                        {
                          content: 'Partial must not cover chunk',
                          timestamp: '2026-10-09 14:00',
                          relevance: 'high',
                          sourceEntryIds: [source.id],
                        },
                      ],
                    },
                  },
                ],
                usage: emptyUsage(),
                stopReason: 'toolUse',
                timestamp: Date.now(),
              };
            }
            return {
              role: 'assistant',
              api: 'openai-chat',
              provider: 'fake',
              model: request.modelId,
              content: [{ type: 'text', text: 'done' }],
              usage: emptyUsage(),
              stopReason:
                request.modelId === 'observer' &&
                (failure === 'length' || failure === 'partial-length')
                  ? 'length'
                  : 'stop',
              timestamp: Date.now(),
            };
          },
        },
        models: ['main', 'observer', 'fallback'].map((id) => ({
          provider: 'fake',
          id,
          thinking: 'off',
          contextWindow: id === 'observer' && failure === 'small-context' ? 100 : 10000,
        })),
        authorizeModel: () => {},
        workerExecutable: '/unused',
        systemPrompt: '',
        tools: [],
        observationalMemory: {
          observeAfterTokens: 1,
          reflectAfterTokens: 100000,
          chunkTokens: 1000,
          poolTarget: 1000,
          maxTurns: 2,
          maxTokens: 1000,
          model: { provider: 'fake', id: 'observer' },
          fallbackModels:
            failure === 'partial-length' ? [] : [{ provider: 'fake', id: 'fallback' }],
        },
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
      const id = randomUUID();
      const result = await runtime.run(lease, 'alice', {
        runId: id,
        turnId: id,
        text: 'Remember project decisions',
        attachments: [],
      });
      expect(result.state).toBe('completed');
      expect(requested).toEqual(
        failure === 'small-context'
          ? ['main', 'fallback']
          : failure === 'partial-length'
            ? ['main', 'observer', 'observer']
            : ['main', 'observer', 'fallback'],
      );
      const pending = authority.inner.operations.db
        .query("SELECT COUNT(*) AS n FROM runtime_model_calls WHERE state='pending'")
        .get() as { n: number };
      expect(pending.n).toBe(0);
      if (failure === 'partial-length')
        expect(
          authority.customEntries(lease.binding.sessionId, 'alice', lease.branchId, OBS_RECORDED),
        ).toHaveLength(0);
    } finally {
      await runtime?.close();
      authority.close();
    }
  });
