import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildDaemonApp } from '../src/daemon/app.js';
import { startNode } from '../src/node/runtime.js';
import { NodeSandbox } from '../src/node/sandbox.js';
import { SandboxedEnvironmentExecutor } from '../src/node/environment-executor.js';
import { GatewaySessionAuthority } from '../src/gateway-runtime/authority.js';
import { GatewayCapabilities } from '../src/gateway-runtime/capabilities.js';
import { MixedCentral } from '../src/gateway-runtime/mixed-central.js';
import { ExecutionJournal } from '../src/environment/journal.js';
import { CentralLink } from '../src/environment/central-link.js';
import { RemoteEnvironment } from '../src/environment/remote.js';
import { LocalEnvironment } from '../src/environment/service.js';
import { nodeEnvironmentReceiver } from '../src/environment/node-channel.js';
import { EnvironmentFlow } from '../src/environment/flow.js';
import { ChunkStore } from '../src/environment/chunks.js';
import { generateDescriptor } from '../src/environment/descriptor.js';
import { builtinTools } from '../src/agent/tools/index.js';
import { intentDigest, type ExecutionIntent } from '../src/environment/protocol.js';
import { canonicalJson } from '../src/environment/json.js';
import { daemonConfig, testConfig, waitFor } from './helpers.js';

test('mixed PTC uses authenticated reverse RPC; node final hooks, central transaction and lost reply are original-ID safe', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pirc-mixed-wire-'));
  const cwd = path.join(root, 'workspace'),
    configDir = path.join(root, 'config'),
    sessionDir = path.join(root, 'session');
  for (const dir of [cwd, configDir, sessionDir]) mkdirSync(dir);
  writeFileSync(path.join(cwd, 'input.txt'), 'node input');
  writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify({
      features: { autoMode: { enabled: false } },
      hooks: {
        beforeTool: [{ matcher: 'schedule', command: `echo '{"args":{"action":"create"}}'` }],
        afterTool: [{ matcher: 'schedule', command: 'echo mixed-post-hook' }],
      },
    }),
  );
  const oldConfig = process.env.PIRC_CONFIG_DIR;
  process.env.PIRC_CONFIG_DIR = configDir;
  const authority = new GatewaySessionAuthority(path.join(root, 'authority.sqlite'));
  const journal = new ExecutionJournal(path.join(root, 'node.sqlite')),
    transport = new ExecutionJournal(path.join(root, 'transport.sqlite'));
  const { app, services } = await buildDaemonApp(daemonConfig());
  let node: Awaited<ReturnType<typeof startNode>> | undefined,
    executor: SandboxedEnvironmentExecutor | undefined;
  let gatewayFlow: EnvironmentFlow | undefined, nodeFlow: EnvironmentFlow | undefined;
  let gatewayCentral: CentralLink | undefined,
    nodeCentral: CentralLink | undefined,
    remote: RemoteEnvironment | undefined,
    local: LocalEnvironment | undefined;
  const incoming = new ChunkStore(path.join(root, 'incoming')),
    outgoing = new ChunkStore(path.join(root, 'outgoing'));
  try {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const url = `ws://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const lease = authority.activate({
      ...authority.prepare({
        owner: 'alice',
        nodeId: 'test',
        workspaceId: 'test:test',
        legacySessionIds: [],
      }),
      fenced: true,
    });
    const binding = lease.binding,
      authorize = (actual: typeof binding) => {
        if (canonicalJson(actual, 65536) !== canonicalJson(binding, 65536))
          throw new Error('Foreign binding');
      };
    const prepared = await new NodeSandbox(
      testConfig({
        sandbox:
          process.env.PIRC_TEST_SRT === 'embedded'
            ? {}
            : process.env.PIRC_TEST_SRT
              ? { srt: process.env.PIRC_TEST_SRT }
              : { srt: path.resolve('test/fixtures/fake-srt.sh') },
      }),
    ).prepare({
      sessionId: binding.sessionId,
      workspaceRoot: cwd,
      sessionDir,
      environmentExecutor: true,
    });
    const descriptor = generateDescriptor({
      binding,
      cwd,
      tools: [
        ...builtinTools(),
        {
          name: 'schedule',
          description: 'transaction fixture',
          parameters: {
            type: 'object',
            properties: { action: { type: 'string' } },
            required: ['action'],
          },
          resultSchema: { type: 'object' },
          execute: async () => {
            throw new Error('Central only');
          },
        },
      ],
      sandboxStatus: { active: true },
      env: {
        PIRC_CONFIG_DIR: configDir,
        PIRC_SANDBOX: 'srt',
        PIRC_SANDBOX_POLICY: JSON.stringify(prepared.policy.paths),
      },
    });
    const observed: unknown[] = [];
    let centralRequests = 0,
      lost = false;
    let inner: ExecutionIntent | undefined;
    const capabilities = new GatewayCapabilities({
      inner: authority.inner,
      descriptor: () => descriptor,
      authorize: (_intent, args) => {
        expect(args.action).toBe('create');
      },
      capabilities: new Map([
        [
          'schedule',
          {
            mutate: (db, args) => {
              db.exec('CREATE TABLE IF NOT EXISTS fixture_effects(id TEXT PRIMARY KEY);');
              db.query('INSERT INTO fixture_effects VALUES (?)').run('one');
              observed.push(args);
              return { text: 'central committed' };
            },
          },
        ],
      ]),
    });
    const mixed = new MixedCentral({
      authority,
      capabilities,
      authorize: (intent) => authorize(intent.binding),
    });
    gatewayCentral = new CentralLink({
      nodeId: 'test',
      authorize,
      execute: async (intent, signal, final) => {
        centralRequests++;
        inner = intent;
        return mixed.execute(intent, signal, final);
      },
      status: (intent) => mixed.status(intent),
      send: async (message) => {
        if (message.type === 'ptc.central.result' && !lost) {
          lost = true;
          nodeCentral!.disconnect();
          return;
        }
        await gatewayFlow!.send(message);
      },
    });
    nodeCentral = new CentralLink({
      nodeId: 'test',
      authorize,
      send: (message) => nodeFlow!.send(message),
    });
    executor = new SandboxedEnvironmentExecutor({
      sandbox: prepared,
      cwd,
      descriptor,
      inner: journal.inner,
      request: async (kind, payload, intent, signal) => {
        if (kind === 'lease') return null;
        if (kind === 'ptc_central')
          return nodeCentral!.request(
            intent,
            signal,
            (payload as { arguments: ExecutionIntent['arguments'] }).arguments,
          );
        throw new Error('Unexpected broker');
      },
    });
    await executor.started;
    local = new LocalEnvironment({ nodeId: 'test', journal, authorize, unfencedHarness: true });
    local.provision(descriptor, executor);
    transport.provision(binding, descriptor.revision, descriptor.policyRevision);
    remote = new RemoteEnvironment({
      nodeId: 'test',
      journal: transport,
      authorize,
      central: gatewayCentral,
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
    node = await startNode(
      testConfig({ nodeId: 'test', nodeToken: 't'.repeat(32), daemonUrl: url }),
      {
        connect: (send) => {
          local!.reconnect();
          remote!.reconnect();
          nodeCentral!.reconnect();
          nodeFlow = new EnvironmentFlow({
            send,
            append: (...args) => outgoing.append(...args),
            take: (id) => outgoing.take(id),
            discard: (id) => outgoing.discard(id),
            receive: nodeEnvironmentReceiver({
              environment: local!,
              central: nodeCentral!,
              send: (message) => nodeFlow!.send(message),
            }),
            failed: () => {
              local!.disconnect();
              nodeCentral!.disconnect();
            },
          });
        },
        receive: (raw) => nodeFlow!.receive(raw),
        disconnect: () => {
          nodeFlow?.close();
          nodeCentral?.disconnect();
          local?.disconnect();
        },
      },
    );
    await waitFor(() => services.nodes.list().length, 1);
    await remote.describe(binding);
    const turn = { runId: randomUUID(), turnId: randomUUID(), text: 'mixed', attachments: [] };
    authority.commitTurn(lease, turn, descriptor, []);
    const value = {
      binding,
      executionId: randomUUID(),
      runId: turn.runId,
      turnId: turn.turnId,
      toolCallId: randomUUID(),
      descriptorRevision: descriptor.revision,
      policyRevision: descriptor.policyRevision,
      capability: 'ptc',
      arguments: {
        code: 'await tools.read({path:"input.txt"});return await tools.schedule({action:"list"});',
        timeout: 10,
      },
      budgetMs: 10000,
    };
    authority.persistExecution(lease, { ...value, argumentDigest: intentDigest(value) });
    authority.preparePtc(lease, value.executionId);
    const intent = authority.executionIntent(binding, value.executionId);
    await remote.start(intent);
    await waitFor(async () => !!(await remote!.status(binding, intent.executionId)).terminal, true);
    const outer = await remote.status(binding, intent.executionId);
    expect(outer.state).not.toBe('completed');
    expect(observed).toEqual([{ action: 'create' }]);
    expect(centralRequests).toBe(1);
    await gatewayCentral.drain();
    nodeCentral.reconnect();
    const recovered = await nodeCentral.status(inner!, new AbortController().signal);
    expect(recovered.ok).toBe(true);
    expect(centralRequests).toBe(1);
    await executor.stopped;
    journal.inner.seal(binding, intent.executionId);
    expect(executor.healthy).toBe(false);
    const original = journal.inner.status(binding, intent.executionId, inner!.innerOperationId!);
    expect(original.result?.effect).toBe('unknown');
    const evidence = authority.inner.status(
      binding,
      intent.executionId,
      inner!.innerOperationId!,
    ).result!;
    journal.inner.reconcile(binding, intent.executionId, inner!.innerOperationId!, evidence);
    expect(
      journal.inner.status(binding, intent.executionId, inner!.innerOperationId!).result?.effect,
    ).toBe('completed');
  } finally {
    remote?.disconnect();
    gatewayCentral?.disconnect();
    nodeCentral?.disconnect();
    gatewayFlow?.close();
    nodeFlow?.close();
    await gatewayCentral?.drain();
    await local?.close();
    try {
      await executor?.closeAndWait();
    } catch (error) {
      if (!String(error).includes('quarantined')) throw error;
    }
    await node?.close();
    await app.close();
    journal.close();
    transport.close();
    authority.close();
    if (oldConfig === undefined) delete process.env.PIRC_CONFIG_DIR;
    else process.env.PIRC_CONFIG_DIR = oldConfig;
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
