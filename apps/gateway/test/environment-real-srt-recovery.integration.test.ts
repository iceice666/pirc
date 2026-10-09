/**
 * Combined M2 gate, never fake-srt evidence. Run with PIRC_TEST_SRT=embedded
 * (or a real srt executable) from apps/gateway. macOS needs an isolated HOME
 * outside /tmp: temporary writes are deliberately allowed by sandbox policy.
 * Only disposable harness sessions are provisioned; no production routing,
 * existing writer transfer, provider calls or private configuration is used.
 */
import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildDaemonApp } from '../src/daemon/app.js';
import { startNode } from '../src/node/runtime.js';
import type { NodeServices } from '../src/node/app.js';
import type { NodeConfig } from '../src/config.js';
import { NodeSandbox } from '../src/node/sandbox.js';
import { SandboxedEnvironmentExecutor } from '../src/node/environment-executor.js';
import { EnvironmentAuthority } from '../src/node/environment-authority.js';
import { EnvironmentInteractions } from '../src/node/environment-interactions.js';
import { fenceEnvironment } from '../src/node/environment-supervisor.js';
import { ApprovalAuthority, type EnvironmentApproval } from '../src/environment/approvals.js';
import { EnvironmentArtifacts } from '../src/environment/artifacts.js';
import { ArtifactTransfer, resolveArtifact } from '../src/environment/artifact-transfer.js';
import { ChunkStore } from '../src/environment/chunks.js';
import { generateDescriptor } from '../src/environment/descriptor.js';
import { EnvironmentFlow } from '../src/environment/flow.js';
import { ExecutionJournal } from '../src/environment/journal.js';
import { RemoteEnvironment } from '../src/environment/remote.js';
import { LocalEnvironment, dispatchEnvironment } from '../src/environment/service.js';
import {
  intentDigest,
  type Binding,
  type ExecutionIntent,
  type ExecutionRecord,
  type EnvironmentMessage,
} from '../src/environment/protocol.js';
import type { Json } from '../src/environment/json.js';
import { GatewaySessionAuthority } from '../src/gateway-runtime/authority.js';
import { GatewayAgentRuntime } from '../src/gateway-runtime/runtime.js';
import type { WriterLease } from '../src/gateway-runtime/contracts.js';
import { builtinTools } from '../src/agent/tools/index.js';
import { createSandboxTools } from '../src/agent/features/sandbox.js';
import { loadAgentConfig } from '../src/agent/config.js';
import { daemonConfig, testConfig, waitFor } from './helpers.js';

const srt = process.env.PIRC_TEST_SRT;
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
const user = 'test@example.com';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9V8AAAAASUVORK5CYII=',
  'base64',
);
const authorize = (bindings: Binding[]) => (actual: Binding) => {
  if (
    !bindings.some((binding) =>
      (Object.keys(binding) as Array<keyof Binding>).every((key) => binding[key] === actual[key]),
    )
  )
    throw new Error('Unprovisioned fixture binding');
};
const lines = (file: string) =>
  existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0;

async function provision(
  root: string,
  binding: Binding,
  config: NodeConfig,
  services: NodeServices,
  approvals: ApprovalAuthority,
  artifacts: EnvironmentArtifacts,
) {
  const cwd = path.join(root, 'workspace');
  const sessionDir = path.join(root, `executor-${binding.executorEpoch}`);
  mkdirSync(sessionDir);
  const sandbox = await new NodeSandbox(config).prepare({
    sessionId: binding.sessionId,
    workspaceRoot: cwd,
    sessionDir,
    environmentExecutor: true,
  });
  expect(sandbox.status.active).toBe(true);
  const env = {
    PIRC_CONFIG_DIR: path.join(root, 'config'),
    PIRC_SANDBOX: 'srt',
    PIRC_SANDBOX_POLICY: JSON.stringify(sandbox.policy.paths),
  };
  const descriptor = generateDescriptor({
    binding,
    cwd,
    env,
    tools: [...builtinTools(), ...createSandboxTools(() => undefined)],
    sandboxStatus: { active: true },
  });
  let executor!: SandboxedEnvironmentExecutor;
  const authority = new EnvironmentAuthority({
    config: loadAgentConfig(cwd, { providers: {} }, env),
    descriptor,
    sandbox,
    approvals,
    writes: services.writes,
    executor: () => executor,
  });
  executor = new SandboxedEnvironmentExecutor({
    sandbox,
    cwd,
    descriptor,
    artifacts,
    request: (kind, payload, intent, signal) =>
      authority.request(kind, payload as Record<string, any>, intent, signal),
  });
  cleanup.push(async () => {
    try {
      await executor.closeAndWait();
    } catch (error) {
      if (!String(error).includes('quarantined')) throw error;
    }
  });
  await executor.started;
  const make = (capability: string, args: Record<string, Json>): ExecutionIntent => {
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
      budgetMs: 20_000,
    };
    return { ...value, argumentDigest: intentDigest(value) };
  };
  return { cwd, descriptor, executor, make };
}

async function gateway(root: string, bindings: Binding[], port = 0) {
  const config = daemonConfig({
    stateDir: path.join(root, 'gateway'),
    databasePath: path.join(root, 'gateway', 'database.sqlite'),
    uploadsDir: path.join(root, 'gateway', 'uploads'),
    port,
  });
  const { app, services } = await buildDaemonApp(config);
  const journal = new ExecutionJournal(path.join(root, 'gateway-journal.sqlite'));
  const authority = new GatewaySessionAuthority(path.join(root, 'gateway-authority.sqlite'));
  const incoming = new ChunkStore(path.join(root, `gateway-chunks-${randomUUID()}`));
  const sent: string[] = [];
  let flow!: EnvironmentFlow;
  const remote = new RemoteEnvironment({
    nodeId: 'test',
    journal,
    authorize: authorize(bindings),
    timeoutMs: 1500,
    send: (message) => {
      sent.push(message.type);
      return flow.send(message);
    },
  });
  flow = new EnvironmentFlow({
    send: (raw) => services.nodes.sendEnvironmentFrame('test', raw),
    append: (...args) => incoming.append(...args),
    take: (id) => incoming.take(id),
    discard: (id) => incoming.discard(id),
    receive: (message) => remote.receive(message),
    failed: () => remote.disconnect(),
  });
  services.nodes.onEnvironmentFrame = async (_nodeId, raw) => {
    await flow.receive(raw);
  };
  await app.listen({ host: '127.0.0.1', port });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    remote.disconnect();
    flow.close();
    await app.close();
    journal.close();
    authority.close();
  };
  cleanup.push(close);
  return {
    app,
    services,
    journal,
    authority,
    remote,
    sent,
    close,
    port: (app.server.address() as { port: number }).port,
  };
}

async function terminal(remote: RemoteEnvironment, binding: Binding, executionId: string) {
  let result!: ExecutionRecord;
  await waitFor(
    async () => {
      result = await remote.status(binding, executionId);
      return Boolean(result.terminal);
    },
    true,
    10_000,
  );
  return result;
}

// An explicit fake path must not be passed off as the opt-in real fixture.
test.skipIf(!srt)(
  'real-srt combined approvals, produced artifact/result/lost-ACK recovery and startup quarantine across both-end restart',
  async () => {
    expect(srt).not.toContain('fake-srt');
    const root = mkdtempSync(path.join(os.tmpdir(), 'pirc-real-srt-recovery-'));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    for (const dir of [
      'workspace',
      'config',
      'node',
      'node/uploads',
      'node/sessions',
      'gateway',
      'gateway/uploads',
    ])
      mkdirSync(path.join(root, dir), { recursive: true });
    writeFileSync(
      path.join(root, 'config', 'config.json'),
      JSON.stringify({ features: { autoMode: { enabled: false } } }),
    );
    const previous = process.env.PIRC_CONFIG_DIR;
    process.env.PIRC_CONFIG_DIR = path.join(root, 'config');
    cleanup.push(() => {
      if (previous === undefined) delete process.env.PIRC_CONFIG_DIR;
      else process.env.PIRC_CONFIG_DIR = previous;
    });

    const bindings: Binding[] = [];
    let g = await gateway(root, bindings);
    const transfer = g.authority.prepare({
      owner: user,
      nodeId: 'test',
      workspaceId: 'test:test',
      legacySessionIds: [],
    });
    const binding = transfer.binding;
    bindings.push(binding);
    const nodeConfig = testConfig({
      stateDir: path.join(root, 'node'),
      databasePath: path.join(root, 'node', 'database.sqlite'),
      uploadsDir: path.join(root, 'node', 'uploads'),
      sessionsDir: path.join(root, 'node', 'sessions'),
      workspaceMemoryDir: path.join(root, 'node', 'workspace-memory'),
      daemonUrl: `ws://127.0.0.1:${g.port}`,
      sandbox: srt === 'embedded' ? {} : { srt: srt! },
      workspaces: [
        { id: 'test', path: path.join(root, 'workspace'), displayName: 'Fixture', defaults: {} },
      ],
    });
    const notices: EnvironmentApproval[] = [];
    let services!: NodeServices;
    let local!: LocalEnvironment;
    let approvals!: ApprovalAuthority;
    let artifacts!: EnvironmentArtifacts;
    let interactions!: EnvironmentInteractions;
    let first!: Awaited<ReturnType<typeof provision>>;
    let lease!: WriterLease;
    let dropAckReply = false;
    let rejectNextPin = false;
    let droppedAckReplies = 0;

    const start = async (initialize: (s: NodeServices) => Promise<void>) => {
      const outgoing = new ChunkStore(path.join(root, `node-chunks-${randomUUID()}`));
      let flow: EnvironmentFlow | undefined;
      const node = await startNode(nodeConfig, {
        interactions: (db, events) => (interactions = new EnvironmentInteractions(db, events)),
        initialize: async (s) => {
          services = s;
          artifacts = new EnvironmentArtifacts(path.join(root, 'node', 'artifacts'));
          const storage = artifacts;
          cleanup.push(() => storage.close());
          approvals = new ApprovalAuthority(
            path.join(root, 'node', 'approvals.sqlite'),
            (record) => {
              notices.push(record);
              interactions.publish(
                record,
                services.db.getSession(record.binding.sessionId).runnerEpoch,
                approvals,
              );
            },
          );
          const ownedApprovals = approvals;
          cleanup.push(() => ownedApprovals.close());
          local = new LocalEnvironment({
            nodeId: 'test',
            journal: s.environmentJournal,
            authorize: authorize(bindings),
          });
          await initialize(s);
        },
        connect: (send) => {
          local.reconnect();
          approvals.reconnect();
          g.remote.reconnect();
          const transfer = new ArtifactTransfer({
            storage: artifacts,
            authorize: authorize(bindings),
            online: () => true,
          });
          flow = new EnvironmentFlow({
            send,
            append: (...args) => outgoing.append(...args),
            take: (id) => outgoing.take(id),
            discard: (id) => outgoing.discard(id),
            receive: async (message) => {
              let reply: EnvironmentMessage;
              try {
                if (rejectNextPin && message.type === 'artifact.pin') {
                  rejectNextPin = false;
                  throw new Error('Fixture interrupted pin before durable storage');
                }
                reply = await dispatchEnvironment(local, message, transfer);
              } catch (error) {
                // Expected authorization refusals are correlated protocol errors,
                // not corrupt-wire failures which retire the authenticated link.
                reply = {
                  version: 1,
                  requestId: message.requestId,
                  type: 'environment.error',
                  error: { code: 'invalid_binding', message: String(error).slice(0, 8192) },
                };
              }
              if (dropAckReply && reply.type === 'execution.acknowledged') {
                dropAckReply = false;
                droppedAckReplies++;
                return;
              }
              await flow!.send(reply);
            },
            failed: () => local.disconnect(),
          });
        },
        receive: (raw) => flow!.receive(raw),
        disconnect: () => {
          approvals.disconnect();
          local.disconnect();
          flow?.close();
        },
      });
      let closed = false;
      const close = async () => {
        if (closed) return;
        closed = true;
        await node.close();
      };
      cleanup.push(close);
      await waitFor(() => g.services.nodes.list().length, 1);
      return { close };
    };
    let node = await start(async (s) => {
      // Disposable UI projection only, matching the existing interaction harness;
      // it is not a legacy transcript import or production writer transfer.
      const session = s.db.createSession(
        'test',
        path.join(root, 'node', 'sessions', 'fixture.jsonl'),
        null,
        null,
        user,
      );
      s.db.raw.query('UPDATE sessions SET id=? WHERE id=?').run(binding.sessionId, session.id);
      lease = g.authority.activate(await s.writerFence.fence(transfer, async () => {}));
      first = await provision(root, binding, nodeConfig, s, approvals, artifacts);
      local.provision(first.descriptor, first.executor);
      g.journal.provision(binding, first.descriptor.revision, first.descriptor.policyRevision);
    });
    const http = (url: string, payload: Record<string, unknown>, owner = user) =>
      g.services.nodes.request('test', { method: 'POST', url, user: owner, payload });
    const control = await http(`/api/sessions/${binding.sessionId}/control/acquire`, {
      clientId: 'fixture-human',
    });
    expect(control.status).toBe(200);
    const controlGeneration = (control.body as { lease: { generation: number } }).lease.generation;
    const startExecution = async (intent: ExecutionIntent) => {
      g.authority.persistExecution(lease, intent);
      await g.remote.start(intent);
      return terminal(g.remote, intent.binding, intent.executionId);
    };
    const commit = async (record: ExecutionRecord) => {
      for (const artifact of record.terminal!.artifacts)
        await g.remote.pinArtifact(record.binding, artifact);
      g.authority.commitResult(record);
    };

    // Real sandbox produces the image, then real read yields the child bytes which
    // the trusted supervisor stores as opaque artifacts. No synthetic executor.
    const produced = first.make('bash', {
      command: `${JSON.stringify(process.execPath)} -e 'require("fs").writeFileSync("produced.png", Buffer.from("${png.toString('base64')}", "base64")); require("fs").appendFileSync("produced.txt", "once\\n")'`,
    });
    const producedDone = await startExecution(produced);
    expect(producedDone.state).toBe('completed');
    await commit(producedDone);
    await g.authority.acknowledge(g.remote, binding, produced.executionId);
    expect(readFileSync(path.join(first.cwd, 'produced.png'))).toEqual(png);

    // Human-owned authenticated ingress: wrong owner and stale control lease are
    // refused; only the exact node approval may permit this host exception.
    const host = first.make('unsandboxed_bash', {
      command: 'echo approved >> approved.txt',
      reason: 'disposable real-srt recovery fixture',
    });
    g.authority.persistExecution(lease, host);
    await g.remote.start(host);
    await waitFor(() => notices.length, 1);
    expect(notices[0]!.action).toBe('host_exec');
    const interaction = services.db.pendingInteractions(binding.sessionId)[0]!;
    const answerUrl = `/api/sessions/${binding.sessionId}/interactions/${interaction.id}/answer`;
    const answer = {
      clientId: 'fixture-human',
      generation: controlGeneration,
      answer: { confirmed: true },
    };
    expect((await http(answerUrl, answer, 'other@example.com')).status).not.toBe(200);
    expect((await http(answerUrl, { ...answer, generation: controlGeneration + 1 })).status).toBe(
      409,
    );
    expect(existsSync(path.join(first.cwd, 'approved.txt'))).toBe(false);
    expect((await http(answerUrl, answer)).status).toBe(200);
    expect((await http(answerUrl, answer)).status).toBe(409);
    const hostDone = await terminal(g.remote, binding, host.executionId);
    expect(hostDone.state).toBe('completed');
    await commit(hostDone);
    await g.authority.acknowledge(g.remote, binding, host.executionId);
    expect(lines(path.join(first.cwd, 'approved.txt'))).toBe(1);

    const image = first.make('read', { path: 'produced.png' });
    const imageDone = await startExecution(image);
    expect(imageDone.state).toBe('completed');
    expect(imageDone.terminal!.artifacts).toHaveLength(1);
    const ref = imageDone.terminal!.artifacts[0]!;
    const fetch = () =>
      resolveArtifact(binding, ref, (request) =>
        g.remote.fetchArtifact(request.binding, request.artifact, request.offset, request.limit),
      );
    expect(await fetch()).toEqual(png);
    expect(() => g.authority.artifact(binding.sessionId, user, ref.artifactId)).toThrow(
      'not referenced',
    );
    await commit(imageDone);
    expect(g.authority.artifact(binding.sessionId, user, ref.artifactId).reference).toEqual(ref);
    await expect(artifacts.removeUnreferenced(binding, ref)).rejects.toThrow('referenced');
    // Drop the reply AFTER durable node ACK, not a fabricated journal ACK.
    dropAckReply = true;
    await expect(g.authority.acknowledge(g.remote, binding, image.executionId)).rejects.toThrow(
      'timed out',
    );
    expect(droppedAckReplies).toBe(1);
    expect(services.environmentJournal.status(binding, image.executionId).acknowledged).toBe(true);
    expect(
      g.authority
        .executions(binding.sessionId, user)
        .find((record) => record.intent.executionId === image.executionId)!.acknowledged,
    ).toBe(false);

    // A second real result is durable on the node but not committed on the gateway.
    const uncommitted = first.make('read', { path: 'produced.png' });
    const uncommittedDone = await startExecution(uncommitted);
    expect(uncommittedDone.terminal!.artifacts).toHaveLength(1);
    const uncommittedRef = uncommittedDone.terminal!.artifacts[0]!;
    expect(() => g.authority.artifact(binding.sessionId, user, uncommittedRef.artifactId)).toThrow(
      'not referenced',
    );

    const denied = first.make('unsandboxed_bash', {
      command: 'echo forbidden >> denied.txt',
      reason: 'disconnect must withdraw this approval',
    });
    g.authority.persistExecution(lease, denied);
    await g.remote.start(denied);
    await waitFor(() => notices.length, 2);
    const lostApproval = notices[1]!;
    g.services.nodes.disconnect('test');
    await waitFor(() => g.services.nodes.list().length, 0);
    await waitFor(() => g.services.nodes.list().length, 1, 7000);
    const deniedDone = await terminal(g.remote, binding, denied.executionId);
    expect(deniedDone.state).toBe('failed');
    expect(existsSync(path.join(first.cwd, 'denied.txt'))).toBe(false);

    const interrupted = first.make('bash', { command: 'echo effect >> interrupted.txt; sleep 60' });
    g.authority.persistExecution(lease, interrupted);
    await g.remote.start(interrupted);
    await waitFor(() => existsSync(path.join(first.cwd, 'interrupted.txt')), true);
    first.executor.close();
    await first.executor.stopped;
    const fenced = await fenceEnvironment({
      binding,
      environment: local,
      executor: first.executor,
      journal: services.environmentJournal,
      approvals,
      writes: services.writes,
    });
    expect(fenced.quarantined).toBeDefined();
    expect(services.environmentJournal.quarantines()).toHaveLength(1);
    expect(services.writes.acquire(binding.sessionId, realpathSync(first.cwd)).granted).toBe(false);
    await local.close();
    await node.close();
    approvals.close();
    artifacts.close();
    await g.close();

    // Both daemon and node restart. Actual startNode/buildNodeApp restores the
    // durable fence before initialize, transport registration or any provisioning.
    g = await gateway(root, bindings, g.port);
    const otherRoot = path.join(root, 'other');
    for (const dir of ['workspace', 'config'])
      mkdirSync(path.join(otherRoot, dir), { recursive: true });
    writeFileSync(
      path.join(otherRoot, 'config', 'config.json'),
      JSON.stringify({ features: { autoMode: { enabled: false } } }),
    );
    const otherTransfer = g.authority.prepare({
      owner: user,
      nodeId: 'test',
      workspaceId: 'test:other',
      legacySessionIds: [],
    });
    bindings.push(otherTransfer.binding);
    let second!: Awaited<ReturnType<typeof provision>>;
    node = await start(async (s) => {
      expect(s.environmentJournal.quarantines()).toHaveLength(1);
      for (const sessionId of [binding.sessionId, randomUUID()])
        expect(s.writes.acquire(sessionId, realpathSync(first.cwd)).granted).toBe(false);
      s.writes.release(binding.sessionId);
      expect(s.writes.acquire(randomUUID(), realpathSync(first.cwd)).granted).toBe(false);
      for (const replacement of [
        { ...binding, executorEpoch: randomUUID() },
        {
          ...binding,
          sessionId: randomUUID(),
          writerEpoch: randomUUID(),
          executorEpoch: randomUUID(),
        },
      ])
        expect(() =>
          s.environmentJournal.provision(
            replacement,
            first.descriptor.revision,
            first.descriptor.policyRevision,
          ),
        ).toThrow('quarantined');
      local.adoptRetired(binding);
      expect(
        approvals.humanAnswer(
          lostApproval.binding,
          lostApproval.interactionId,
          lostApproval.finalArgumentDigest,
          true,
        ),
      ).toBe(false);
      second = await provision(
        otherRoot,
        otherTransfer.binding,
        nodeConfig,
        s,
        approvals,
        artifacts,
      );
      local.provision(second.descriptor, second.executor);
      g.journal.provision(
        otherTransfer.binding,
        second.descriptor.revision,
        second.descriptor.policyRevision,
      );
    });
    const entriesBefore = g.authority.read(binding.sessionId, user).entries.length;
    const recoveredImage = await terminal(g.remote, binding, image.executionId);
    expect(recoveredImage.resultDigest).toBe(imageDone.resultDigest);
    expect(recoveredImage.acknowledged).toBe(true);
    expect(await fetch()).toEqual(png);
    await expect(artifacts.removeUnreferenced(binding, ref)).rejects.toThrow('referenced');
    await commit(recoveredImage);
    await g.authority.acknowledge(g.remote, binding, image.executionId);
    expect(g.authority.read(binding.sessionId, user).entries).toHaveLength(entriesBefore);
    expect(
      g.authority
        .executions(binding.sessionId, user)
        .find((record) => record.intent.executionId === image.executionId)!.acknowledged,
    ).toBe(true);

    // Exercise the production recovery supervisor, not a synthetic result/ACK
    // implementation. A failed pin must leave the authoritative result absent
    // and unacknowledged; retry queries the original ID, never invokes a model,
    // worker or executor side effect.
    const runtime = new GatewayAgentRuntime({
      authority: g.authority,
      environment: g.remote,
      online: () => g.services.nodes.list().some((node) => node.id === 'test'),
      inference: {
        async run() {
          throw new Error('Recovery must not request inference');
        },
      },
      models: [{ provider: 'fixture', id: 'fixture', thinking: 'off', contextWindow: 100_000 }],
      authorizeModel() {
        throw new Error('Recovery must not select a model');
      },
      workerExecutable: '/recovery-must-not-launch-worker',
      workerFactory() {
        throw new Error('Recovery must not launch a worker');
      },
      systemPrompt: '',
      tools: [],
    });
    cleanup.push(() => runtime.close());
    rejectNextPin = true;
    await expect(runtime.reconcile(binding.sessionId, user)).rejects.toThrow('interrupted pin');
    expect(
      g.authority
        .executions(binding.sessionId, user)
        .find((record) => record.intent.executionId === uncommitted.executionId)!.receipt,
    ).toBeUndefined();
    expect(services.environmentJournal.status(binding, uncommitted.executionId).acknowledged).toBe(
      false,
    );
    expect(() => g.authority.artifact(binding.sessionId, user, uncommittedRef.artifactId)).toThrow(
      'not referenced',
    );
    const reconciled = await runtime.reconcile(binding.sessionId, user);
    expect(reconciled.results.map((result) => result.executionId)).toEqual([
      uncommitted.executionId,
      denied.executionId,
      interrupted.executionId,
    ]);
    expect(
      g.authority.executions(binding.sessionId, user).filter((record) => !record.acknowledged),
    ).toHaveLength(0);
    const recoveredUncommitted = await terminal(g.remote, binding, uncommitted.executionId);
    expect(recoveredUncommitted.resultDigest).toBe(uncommittedDone.resultDigest);
    expect(
      await resolveArtifact(binding, uncommittedRef, (request) =>
        g.remote.fetchArtifact(request.binding, request.artifact, request.offset, request.limit),
      ),
    ).toEqual(png);
    expect(recoveredUncommitted.acknowledged).toBe(true);
    expect(
      g.authority.artifact(binding.sessionId, user, uncommittedRef.artifactId).reference,
    ).toEqual(uncommittedRef);
    await expect(artifacts.removeUnreferenced(binding, uncommittedRef)).rejects.toThrow(
      'referenced',
    );
    const recoveredInterrupted = await terminal(g.remote, binding, interrupted.executionId);
    expect(recoveredInterrupted.state).toBe('unknown');
    expect(recoveredInterrupted.effect).toBe('unknown');
    expect(recoveredInterrupted.acknowledged).toBe(true);
    expect((await g.remote.status(binding, denied.executionId)).state).toBe('failed');
    expect(g.sent).not.toContain('execution.start');
    for (const intent of [produced, host, image, uncommitted, denied, interrupted])
      await expect(g.remote.start(intent)).rejects.toThrow();
    await expect(
      g.remote.start(first.make('bash', { command: 'echo replay >> replay.txt' })),
    ).rejects.toThrow();
    expect(lines(path.join(first.cwd, 'produced.txt'))).toBe(1);
    expect(lines(path.join(first.cwd, 'approved.txt'))).toBe(1);
    expect(lines(path.join(first.cwd, 'interrupted.txt'))).toBe(1);
    expect(existsSync(path.join(first.cwd, 'denied.txt'))).toBe(false);
    expect(existsSync(path.join(first.cwd, 'replay.txt'))).toBe(false);
    const unrelated = second.make('bash', { command: 'echo unrelated >> unrelated.txt' });
    await g.remote.start(unrelated);
    expect((await terminal(g.remote, otherTransfer.binding, unrelated.executionId)).state).toBe(
      'completed',
    );
    expect(lines(path.join(otherRoot, 'workspace', 'unrelated.txt'))).toBe(1);
    expect(services.writes.acquire(binding.sessionId, realpathSync(first.cwd)).granted).toBe(false);
    await local.close();
  },
  120_000,
);
