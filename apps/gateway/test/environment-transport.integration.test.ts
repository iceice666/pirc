import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildDaemonApp } from '../src/daemon/app.js';
import { startNode } from '../src/node/runtime.js';
import { EnvironmentFlow } from '../src/environment/flow.js';
import { ChunkStore } from '../src/environment/chunks.js';
import { LocalEnvironment, dispatchEnvironment } from '../src/environment/service.js';
import { RemoteEnvironment } from '../src/environment/remote.js';
import { ExecutionJournal } from '../src/environment/journal.js';
import { descriptorDigest, intentDigest, type Descriptor } from '../src/environment/protocol.js';
import { daemonConfig, testConfig, waitFor } from './helpers.js';

test('opt-in environment harness crosses authenticated node WebSocket with independent bindings', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pirc-env-wire-'));
  const { app, services } = await buildDaemonApp(daemonConfig());
  const nodeJournal = new ExecutionJournal(path.join(root, 'node.sqlite'));
  const gatewayJournal = new ExecutionJournal(path.join(root, 'gateway.sqlite'));
  let node: Awaited<ReturnType<typeof startNode>> | undefined;
  let nodeFlow: EnvironmentFlow | undefined;
  let gatewayFlow: EnvironmentFlow | undefined;
  let remote: RemoteEnvironment | undefined;
  try {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const url = `ws://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const binding = {
      nodeId: 'test',
      workspaceId: 'test:test',
      sessionId: randomUUID(),
      writerEpoch: randomUUID(),
      executorEpoch: randomUUID(),
    };
    const content: Omit<Descriptor, 'revision'> = {
      binding,
      version: 1,
      policyRevision: 'a'.repeat(64),
      instructions: '',
      skills: [],
      role: 'coding',
      platform: 'linux',
      cwdDisplay: '/fixture',
      sandboxStatus: { active: true },
      limits: { maxActive: 1, maxBudgetMs: 1000 },
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
    };
    const descriptor = { ...content, revision: descriptorDigest(content) };
    const authorize = (actual: typeof binding) => {
      if (JSON.stringify(actual) !== JSON.stringify(binding)) {
        // Canonical transport key order differs; compare fields, not object insertion order.
        if (
          Object.keys(binding).some(
            (key) => actual[key as keyof typeof binding] !== binding[key as keyof typeof binding],
          )
        )
          throw new Error('unprovisioned fixture binding');
      }
    };
    const local = new LocalEnvironment({ nodeId: 'test', journal: nodeJournal, authorize });
    let effects = 0;
    local.provision(descriptor, {
      healthy: true,
      async execute() {
        effects++;
        return {
          state: 'completed',
          effect: 'completed',
          output: 'fixture',
          artifacts: [],
          truncated: false,
        };
      },
    });
    gatewayJournal.provision(binding, descriptor.revision, descriptor.policyRevision);
    const incoming = new ChunkStore(path.join(root, 'gateway-chunks'));
    remote = new RemoteEnvironment({
      nodeId: 'test',
      journal: gatewayJournal,
      authorize,
      send: (message) => gatewayFlow!.send(message),
    });
    gatewayFlow = new EnvironmentFlow({
      send: (raw) => services.nodes.sendEnvironmentFrame('test', raw),
      append: (...args) => incoming.append(...args),
      take: (id) => incoming.take(id),
      discard: (id) => incoming.discard(id),
      receive: (message) => remote!.receive(message),
      failed: () => remote!.disconnect(),
    });
    services.nodes.onEnvironmentFrame = async (nodeId, raw) => {
      expect(nodeId).toBe('test');
      await gatewayFlow!.receive(raw);
    };
    const outgoing = new ChunkStore(path.join(root, 'node-chunks'));
    node = await startNode(
      testConfig({ nodeId: 'test', nodeToken: 't'.repeat(32), daemonUrl: url }),
      {
        connect: (send) => {
          nodeFlow = new EnvironmentFlow({
            send,
            append: (...args) => outgoing.append(...args),
            take: (id) => outgoing.take(id),
            discard: (id) => outgoing.discard(id),
            receive: async (message) => {
              await nodeFlow!.send(await dispatchEnvironment(local, message));
            },
            failed: () => local.disconnect(),
          });
        },
        receive: (raw) => nodeFlow!.receive(raw),
        disconnect: () => {
          local.disconnect();
          nodeFlow?.close();
        },
      },
    );
    await waitFor(() => services.nodes.list().length, 1);
    expect(await remote.describe(binding)).toEqual(descriptor);
    const value = {
      binding,
      executionId: randomUUID(),
      runId: randomUUID(),
      turnId: randomUUID(),
      toolCallId: randomUUID(),
      capability: 'read',
      arguments: {},
      descriptorRevision: descriptor.revision,
      policyRevision: descriptor.policyRevision,
      budgetMs: 1000,
    };
    const intent = { ...value, argumentDigest: intentDigest(value) };
    await remote.start(intent);
    await waitFor(
      async () => (await remote!.status(binding, intent.executionId)).state,
      'completed',
    );
    await remote.start(intent);
    expect(effects).toBe(1);
    expect(gatewayJournal.receipt(binding, intent.executionId)?.terminal?.output).toBe('fixture');
    await local.close();
  } finally {
    remote?.disconnect();
    gatewayFlow?.close();
    nodeFlow?.close();
    await node?.close();
    await app.close();
    nodeJournal.close();
    gatewayJournal.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
