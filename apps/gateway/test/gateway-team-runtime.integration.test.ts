import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GatewaySessionAuthority } from '../src/gateway-runtime/authority.js';
import { GatewayAgentRuntime, type RuntimeEvent } from '../src/gateway-runtime/runtime.js';
import { GatewayPtcService } from '../src/gateway-runtime/ptc-service.js';
import { GatewayCapabilities } from '../src/gateway-runtime/capabilities.js';
import { gatewayTeam } from '../src/gateway-runtime/team.js';
import { ExecutionJournal } from '../src/environment/journal.js';
import { capabilityMetadata } from '../src/environment/catalog.js';
import {
  descriptorDigest,
  type Descriptor,
  type ExecutionIntent,
} from '../src/environment/protocol.js';
import { emptyUsage } from '../src/agent/messages.js';
import type { WorkerAction } from '../src/gateway-runtime/worker.js';

const native = process.env.PIRC_TEST_NATIVE_PTC ? test : test.skip;
native(
  'team member is a gateway runtime instance with bound ask/reply and no node agent loop',
  async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'pirc-m4-team-')),
      file = path.join(root, 'authority.sqlite');
    let authority = new GatewaySessionAuthority(file);
    const journals: ExecutionJournal[] = [];
    const activate = () =>
      authority.activate({
        ...authority.prepare({
          owner: 'alice',
          nodeId: 'n',
          workspaceId: 'n:w',
          legacySessionIds: [],
        }),
        fenced: true,
      });
    const parent = activate();
    const notices: Record<string, any>[] = [];
    let launches = 0,
      nodeStarts = 0;
    const team = gatewayTeam({
      authority,
      parent,
      owner: 'alice',
      team: {
        models: { providers: {} },
        deliverParent: (entry) => notices.push(entry),
        askUser: async () => ({ status: 'cancelled', answers: [] }),
      },
      provision: async (request) => {
        launches++;
        const lease = activate();
        let emit: (event: RuntimeEvent) => void = () => {};
        const journal = new ExecutionJournal(':memory:');
        journals.push(journal);
        const catalog = ['agent_ask', 'agent_list'].map((name) => ({
          name,
          ...capabilityMetadata(name),
          argumentSchema: { type: 'object' },
          resultSchema: { type: 'object' },
          hookRevision: 'a'.repeat(64),
        }));
        const descriptor: Descriptor = {
          binding: lease.binding,
          version: 1,
          revision: '',
          policyRevision: 'b'.repeat(64),
          capabilityCatalog: catalog,
          instructions: 'trusted fixture instructions',
          skills: [],
          role: 'general',
          platform: 'linux',
          cwdDisplay: '/node/workspace',
          sandboxStatus: { active: true },
          limits: { maxActive: 1, maxBudgetMs: 120000 },
        };
        descriptor.revision = descriptorDigest(descriptor);
        const environment = {
          describe: async () => descriptor,
          start: async () => {
            nodeStarts++;
            throw new Error('No environment effect expected');
          },
          status: async () => {
            throw new Error('No node operation');
          },
          cancel: async () => {
            throw new Error('No node operation');
          },
          ack: async () => {},
          pinArtifact: async () => {},
          fetchArtifact: async () => {
            throw new Error('No artifacts');
          },
        };
        const capabilities = new GatewayCapabilities({
          inner: authority.inner,
          descriptor: () => descriptor,
          authorize: (intent) => authority.assertOwner(intent.binding.sessionId, 'alice'),
          capabilities: new Map(
            catalog.map((cap) => [
              cap.name,
              {
                execute: async (
                  args: Record<string, unknown>,
                  _intent: ExecutionIntent,
                  signal: AbortSignal,
                ) => {
                  const result = await request.call(cap.name, args, signal);
                  return { text: JSON.stringify(result), ...(result as object) };
                },
              },
            ]),
          ),
        });
        const ptc = new GatewayPtcService({
          environment,
          journal,
          inner: authority.inner,
          workerExecutable: process.env.PIRC_TEST_NATIVE_PTC!,
          online: () => true,
          central: (intent, signal, gate) => capabilities.execute(intent, signal, gate),
        });
        let models = 0;
        const runtime = new GatewayAgentRuntime({
          authority,
          environment,
          ptc,
          online: () => true,
          models: [{ provider: 'fake', id: 'fake', thinking: 'off', contextWindow: 100000 }],
          authorizeModel: () => {},
          systemPrompt: 'fixture',
          tools: catalog.map((cap) => ({ name: cap.name, description: cap.name, parameters: {} })),
          workerExecutable: process.env.PIRC_TEST_GATEWAY_WORKER ?? '/unused',
          ...(!process.env.PIRC_TEST_GATEWAY_WORKER
            ? {
                workerFactory: () => ({
                  drive: async (step, signal) => {
                    let action: WorkerAction = 'model';
                    for (;;) {
                      signal.throwIfAborted();
                      const next = await step(action);
                      if (action === 'done') return;
                      action = next;
                    }
                  },
                  close: async () => {},
                }),
              }
            : {}),
          inference: {
            run: async () => {
              models++;
              return {
                role: 'assistant',
                api: 'fake',
                provider: 'fake',
                model: 'fake',
                usage: emptyUsage(),
                timestamp: 1,
                content:
                  models === 1
                    ? [
                        {
                          type: 'toolCall',
                          id: 'ask',
                          name: 'ptc',
                          arguments: {
                            code: 'return await tools.agent_ask({question:"Need parent detail"});',
                          },
                        },
                      ]
                    : [{ type: 'text', text: 'gateway child finished' }],
                stopReason: models === 1 ? 'toolUse' : 'stop',
              };
            },
          },
          event: (event) => emit(event),
        });
        return {
          runtime,
          lease,
          subscribe: (listener) => {
            emit = listener;
            return () => {};
          },
        };
      },
    });
    try {
      await team.spawn(
        { name: 'child', task: 'Ask parent then report' },
        { cwd: '.', model: 'fake/fake' },
      );
      await new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error('Child result timeout')), 10000);
        const check = () => {
          if (notices.some((entry) => entry.kind === 'result')) {
            clearTimeout(deadline);
            resolve();
          } else setTimeout(check, 20);
        };
        check();
      });
      expect(launches).toBe(1);
      expect(nodeStarts).toBe(0);
      const question = team.records.find(
        (record) => record.kind === 'question' && record.from === 'child',
      );
      expect(question).toBeDefined();
      await team.call('parent', 'agent_reply', {
        question_id: question!.id,
        answer: 'Parent detail',
      });
      await expect(
        team.call('parent', 'agent_reply', { question_id: question!.id, answer: 'Replay' }),
      ).rejects.toThrow('already answered');
      expect(notices.some((entry) => entry.body?.includes('gateway child finished'))).toBe(true);
      await team.spawn(
        { name: 'peer', task: 'Second independent task' },
        { cwd: '.', model: 'fake/fake' },
      );
      await new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => reject(Error('Peer result timeout')), 10000);
        const check = () => {
          if (team.records.some((record) => record.kind === 'result' && record.from === 'peer')) {
            clearTimeout(deadline);
            resolve();
          } else setTimeout(check, 20);
        };
        check();
      });
      expect(launches).toBe(2);
      expect(nodeStarts).toBe(0);
      await team.stop('child');
      await team.stop('peer');
      await team.close();
      authority.close();
      authority = new GatewaySessionAuthority(file);
      const restored = gatewayTeam({
        authority,
        parent,
        owner: 'alice',
        team: {
          models: { providers: {} },
          deliverParent: () => {},
          askUser: async () => ({ status: 'cancelled', answers: [] }),
        },
        provision: async () => {
          throw Error('Restart must not replay children');
        },
      });
      expect(restored.list().agents).toHaveLength(2);
      expect(restored.list().agents.every((member) => member.status === 'stopped')).toBe(true);
      expect(
        restored.records.some((record) => record.kind === 'result' && record.from === 'peer'),
      ).toBe(true);
      await restored.close();
    } finally {
      await team.close();
      for (const journal of journals) journal.close();
      authority.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
  20000,
);
