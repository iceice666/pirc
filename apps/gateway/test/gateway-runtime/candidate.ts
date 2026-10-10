/**
 * Synthetic M5 candidate: the opt-in gateway runtime with M0's fixtures.
 * Real daemon NodeRegistry, authenticated node WebSocket, node runtime, Environment
 * transport, sandboxed node executor subprocess and gateway runtime loop, composed as
 * createGatewayRuntimeHost does (shared gateway database, DirectCentral, goals, PTC
 * service, node inner-operation event sink). It is built by hand only to keep the
 * worker-factory seam for attribution spans; the factory constructs the same
 * GatewayWorkerProcess. Test-only pieces: the delaying loopback relay, the
 * deterministic provider and the UI socket.
 *
 * Fields shared with M0 that mean something different here (see the M5 report):
 * toolQueueMs = gateway tool start → node executor entry (includes the one-way link);
 * toolExecutionMs/environmentCalls = one outer node execution (a whole PTC script);
 * taskMs starts at the gateway's runtime.run (M0 starts at the node-side prompt);
 * CPU/RSS cover the parent process only (executor, worker and srt children excluded).
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { emptyUsage, type AssistantMessage } from '../../src/agent/messages.js';
import { readTool } from '../../src/agent/tools/files.js';
import type { Tool } from '../../src/agent/tools/types.js';
import { buildDaemonApp } from '../../src/daemon/app.js';
import { GatewayDatabase } from '../../src/database.js';
import { CentralLink } from '../../src/environment/central-link.js';
import { ChunkStore } from '../../src/environment/chunks.js';
import { generateDescriptor } from '../../src/environment/descriptor.js';
import { EnvironmentFlow } from '../../src/environment/flow.js';
import { canonicalJson } from '../../src/environment/json.js';
import { ExecutionJournal } from '../../src/environment/journal.js';
import { nodeEnvironmentReceiver } from '../../src/environment/node-channel.js';
import {
  ENVIRONMENT_PROTOCOL_VERSION,
  type Binding,
  type Descriptor,
  type ExecutionIntent,
} from '../../src/environment/protocol.js';
import { RemoteEnvironment } from '../../src/environment/remote.js';
import { LocalEnvironment, type EnvironmentExecutor } from '../../src/environment/service.js';
import { GatewaySessionAuthority } from '../../src/gateway-runtime/authority.js';
import { GatewayCapabilities } from '../../src/gateway-runtime/capabilities.js';
import { DirectCentral } from '../../src/gateway-runtime/direct-central.js';
import { GatewayGoals } from '../../src/gateway-runtime/goals.js';
import type { WriterLease } from '../../src/gateway-runtime/contracts.js';
import { MixedCentral } from '../../src/gateway-runtime/mixed-central.js';
import { GatewayPtcService } from '../../src/gateway-runtime/ptc-service.js';
import { GatewayAgentRuntime, type RuntimeEvent } from '../../src/gateway-runtime/runtime.js';
import {
  GatewayWorkerProcess,
  type RuntimeWorker,
} from '../../src/gateway-runtime/worker-process.js';
import type { WorkerAction } from '../../src/gateway-runtime/worker.js';
import { SandboxedEnvironmentExecutor } from '../../src/node/environment-executor.js';
import { startNode } from '../../src/node/runtime.js';
import { NodeSandbox } from '../../src/node/sandbox.js';
import { daemonConfig, testConfig } from '../helpers.js';
import { DelayQueue, FIXTURES, type Cell, type Sample } from './baseline.js';

export interface CandidateOptions {
  /** Compiled `pirc-runtime-worker`; absent uses the in-process synthetic phase driver. */
  worker?: string | undefined;
  /** `fake` runs the real executor child unconfined; `embedded` uses bundled srt. */
  srt: 'fake' | 'embedded';
}

/** Expected deterministic tool result: n.txt contains `${n + 1}.txt`. */
const EXPECTED = {
  chat: undefined,
  'single-tool': '1.txt',
  'ptc-10': '10.txt',
  'mixed-ptc': '3.txt',
};

/** Structured value of a direct read or a PTC script's return value. */
function resultText(result: unknown): string | undefined {
  const value = result as {
    data?: { content?: unknown };
    details?: { value?: unknown };
  } | null;
  const text = value?.data?.content ?? value?.details?.value;
  return typeof text === 'string' ? text.trim() : undefined;
}

const syntheticWorker = (): RuntimeWorker => ({
  async drive(step, signal) {
    let action: WorkerAction = 'model';
    for (;;) {
      signal.throwIfAborted();
      const next = await step(action);
      if (action === 'done') return;
      action = next;
    }
  },
  async close() {},
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** Candidate-only frame counts; M0's Sample shape and harness bytes stay unchanged. */
export interface CandidateSample extends Sample {
  nodeToGatewayFrames: number;
  /** Decoded Environment messages, either direction, that carry the 256 KiB history marker. */
  historyMessages: number;
  gatewayToNodeFrames: number;
  /** Attribution spans (ms), measured window only: Environment RPCs, turn preparation, worker. */
  spans: Record<string, number[]>;
}
const TRACED = ['describe', 'start', 'status', 'ack', 'pinArtifact'] as const;
/** A run only the 256 KiB synthetic history contains (the 1 KiB history is shorter). */
const HISTORY_MARK = 'h'.repeat(4096);

export function candidateRunner(options: CandidateOptions) {
  return (cell: Cell) => runCandidateSample(cell, options);
}

export async function runCandidateSample(
  cell: Cell,
  options: CandidateOptions,
): Promise<CandidateSample> {
  if (
    ![0, 30, 100, 200].includes(cell.rttMs) ||
    ![1, 4].includes(cell.sessions) ||
    ![1024, 262144].includes(cell.contextBytes) ||
    !FIXTURES.includes(cell.fixture)
  )
    throw new Error('Unsupported candidate cell');
  const root = await mkdtemp(path.join(tmpdir(), 'pirc-runtime-m5-'));
  const up = new DelayQueue(cell.rttMs / 2);
  const down = new DelayQueue(cell.rttMs / 2);
  const metrics: CandidateSample = {
    cell,
    success: false,
    errors: [],
    measuredRttMs: 0,
    taskMs: [],
    deltaToUiMs: [],
    toolQueueMs: [],
    toolExecutionMs: [],
    contextBytes: [],
    nodeToGatewayBytes: 0,
    gatewayToNodeBytes: 0,
    uiBytes: 0,
    modelCalls: 0,
    environmentCalls: 0,
    centralCalls: 0,
    peakDelayQueueBytes: 0,
    peakSocketBufferedBytes: 0,
    cpuUserMs: 0,
    cpuSystemMs: 0,
    rssStartBytes: 0,
    rssPeakBytes: 0,
    nodeToGatewayFrames: 0,
    historyMessages: 0,
    gatewayToNodeFrames: 0,
    spans: {},
  };
  // Data messages travel as base64 chunks, so the marker is checked after decoding.
  const inspect = (message: unknown) => {
    if (measured && JSON.stringify(message).includes(HISTORY_MARK)) metrics.historyMessages++;
  };
  const span = (name: string, ms: number) => {
    if (measured) (metrics.spans[name] ??= []).push(ms);
  };
  const peers = new Set<WebSocket>();
  const executors: SandboxedEnvironmentExecutor[] = [];
  const sessions: Array<{ lease: WriterLease; descriptor: Descriptor }> = [];
  const bindings = new Set<string>();
  const deltaStarts = new Map<string, number>();
  const receivedTokens = new Set<string>();
  const sessionStarts = new Map<string, number>();
  const queueStarts = new Map<string, number>();
  const queuedCapability = new Map<string, string>();
  const toolEnds = new Map<string, number>();
  const runs: Promise<void>[] = [];
  let innerOperationEnds = 0;
  const finished = deferred<void>();
  const uiReady = deferred<WebSocket>();
  const nodeFacing = deferred<WebSocket>();
  const fatal = deferred<never>();
  const fail = (error: unknown) =>
    fatal.reject(error instanceof Error ? error : new Error(String(error)));
  const guarded = <T>(promise: Promise<T>) => Promise.race([promise, fatal.promise]);
  void fatal.promise.catch(() => {});
  const watchdog = setTimeout(() => fail(new Error('Candidate run exceeded 30 seconds')), 30000);
  const oldConfig = process.env.PIRC_CONFIG_DIR;
  let measured = false;
  let settled = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let daemon: ReturnType<typeof daemonConfig> | undefined;
  let nodeConfig: ReturnType<typeof testConfig> | undefined;
  let database: GatewayDatabase | undefined;
  let authority: GatewaySessionAuthority | undefined;
  let nodeJournal: ExecutionJournal | undefined;
  let transport: ExecutionJournal | undefined;
  let app: Awaited<ReturnType<typeof buildDaemonApp>>['app'] | undefined;
  let relay: WebSocketServer | undefined;
  let node: Awaited<ReturnType<typeof startNode>> | undefined;
  let runtime: GatewayAgentRuntime | undefined;
  let remote: RemoteEnvironment | undefined;
  let local: LocalEnvironment | undefined;
  let gatewayFlow: EnvironmentFlow | undefined;
  let nodeFlow: EnvironmentFlow | undefined;
  let gatewayCentral: CentralLink | undefined;
  let nodeCentral: CentralLink | undefined;
  let uiClient: WebSocket | undefined;
  const authorize = (binding: Binding) => {
    if (!bindings.has(canonicalJson(binding, 65536))) throw new Error('Foreign binding');
  };
  try {
    const configDir = path.join(root, 'config');
    await mkdir(configDir);
    await writeFile(
      path.join(configDir, 'config.json'),
      JSON.stringify({ features: { autoMode: { enabled: false } } }),
    );
    process.env.PIRC_CONFIG_DIR = configDir;
    daemon = daemonConfig();
    const nodeConf = testConfig({ nodeId: 'test', nodeToken: 't'.repeat(32) });
    nodeConfig = nodeConf;
    // Production composition shares the gateway database with existing central records.
    database = new GatewayDatabase(path.join(root, 'gateway.sqlite'));
    const gatewayAuthority = new GatewaySessionAuthority(database.raw);
    authority = gatewayAuthority;
    const nodeJ = new ExecutionJournal(path.join(root, 'node.sqlite'));
    nodeJournal = nodeJ;
    const gatewayJournal = new ExecutionJournal(path.join(root, 'transport.sqlite'));
    transport = gatewayJournal;
    const incoming = new ChunkStore(path.join(root, 'incoming'));
    const outgoing = new ChunkStore(path.join(root, 'outgoing'));
    const daemonApp = await buildDaemonApp(daemon);
    const daemonHttp = daemonApp.app;
    app = daemonHttp;
    const services = daemonApp.services;
    const relayServer = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    relay = relayServer;
    const listening = new Promise<void>((resolve, reject) => {
      relayServer.once('listening', resolve);
      relayServer.once('error', reject);
    });
    await daemonHttp.listen({ host: '127.0.0.1', port: 0 });
    const daemonPort = (daemonHttp.server.address() as { port: number }).port;
    await guarded(listening);
    const relayPort = (relayServer.address() as { port: number }).port;
    // Transparent loopback relay: every node application frame gets RTT/2 per direction.
    relayServer.on('connection', (socket, request) => {
      peers.add(socket);
      socket.on('error', fail);
      if (request.url === '/ui') {
        uiReady.resolve(socket);
        return;
      }
      const upstream = new WebSocket(`ws://127.0.0.1:${daemonPort}${request.url ?? ''}`, {
        headers: {
          'x-pirc-node-id': String(request.headers['x-pirc-node-id'] ?? ''),
          authorization: String(request.headers.authorization ?? ''),
        },
      });
      peers.add(upstream);
      upstream.on('error', fail);
      const early: string[] = [];
      upstream.once('open', () => {
        for (const frame of early.splice(0)) upstream.send(frame);
        nodeFacing.resolve(socket);
      });
      socket.on('message', (raw) => {
        const frame = raw.toString();
        if (measured) {
          metrics.nodeToGatewayBytes += Buffer.byteLength(frame);
          metrics.nodeToGatewayFrames++;
        }
        up.send(frame, () => {
          if (upstream.readyState === WebSocket.OPEN) upstream.send(frame);
          else if (upstream.readyState === WebSocket.CONNECTING) early.push(frame);
        });
      });
      upstream.on('message', (raw) => {
        const frame = raw.toString();
        if (measured) {
          metrics.gatewayToNodeBytes += Buffer.byteLength(frame);
          metrics.gatewayToNodeFrames++;
        }
        down.send(frame, () => {
          if (socket.readyState === WebSocket.OPEN) socket.send(frame);
        });
      });
      socket.on('close', () => upstream.close());
      upstream.on('close', () => socket.close());
    });

    const sandbox = new NodeSandbox({
      ...nodeConf,
      sandbox:
        options.srt === 'embedded'
          ? {}
          : { srt: path.resolve(import.meta.dir, '../fixtures/fake-srt.sh') },
    });
    const centralTool: Tool = {
      name: 'web_search',
      description: 'Synthetic central lookup; no external I/O',
      ptc: true,
      parameters: {
        type: 'object',
        properties: { value: { type: 'number' } },
        required: ['value'],
      },
      resultSchema: {
        type: 'object',
        properties: { value: { type: 'number' } },
        required: ['value'],
      },
      async execute() {
        throw new Error('Central only');
      },
    };
    for (let i = 0; i < cell.sessions; i++) {
      const workspace = path.join(root, `workspace-${i}`);
      const sessionDir = path.join(root, `session-${i}`);
      await mkdir(workspace);
      await mkdir(sessionDir);
      for (let n = 0; n <= 10; n++)
        await writeFile(path.join(workspace, `${n}.txt`), `${n + 1}.txt`);
      const lease = gatewayAuthority.activate({
        ...gatewayAuthority.prepare({
          owner: 'alice',
          nodeId: 'test',
          workspaceId: `test:workspace-${i}`,
          legacySessionIds: [],
        }),
        fenced: true,
      });
      bindings.add(canonicalJson(lease.binding, 65536));
      // Same synthetic history as M0, created fresh (no legacy import).
      gatewayAuthority.append(lease, randomUUID(), {
        type: 'message',
        message: { role: 'user', content: 'h'.repeat(cell.contextBytes), timestamp: 1 },
      });
      gatewayAuthority.append(lease, randomUUID(), {
        type: 'message',
        message: {
          role: 'assistant',
          api: 'openai-chat',
          provider: 'synthetic',
          model: 'm0',
          content: [{ type: 'text', text: 'history' }],
          usage: emptyUsage(),
          stopReason: 'stop',
          timestamp: 1,
        },
      });
      const prepared = await sandbox.prepare({
        sessionId: lease.binding.sessionId,
        workspaceRoot: workspace,
        sessionDir,
        environmentExecutor: true,
      });
      const descriptor = generateDescriptor({
        binding: lease.binding,
        cwd: workspace,
        tools: [readTool, centralTool],
        sandboxStatus: { active: true },
        env: {
          PIRC_CONFIG_DIR: configDir,
          PIRC_SANDBOX: 'srt',
          PIRC_SANDBOX_POLICY: JSON.stringify(prepared.policy.paths),
        },
      });
      const executor = new SandboxedEnvironmentExecutor({
        sandbox: prepared,
        cwd: workspace,
        descriptor,
        inner: nodeJ.inner,
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
      executors.push(executor);
      await guarded(executor.started);
      sessions.push({ lease, descriptor });
    }
    const descriptorFor = (binding: Binding) => {
      const found = sessions.find((s) => s.lease.binding.sessionId === binding.sessionId);
      if (!found) throw new Error('Unknown binding');
      return found.descriptor;
    };
    const capabilities = new GatewayCapabilities({
      inner: gatewayAuthority.inner,
      descriptor: (intent) => descriptorFor(intent.binding),
      authorize: (intent) => authorize(intent.binding),
      capabilities: new Map([
        [
          'web_search',
          {
            execute: async (args) => {
              metrics.centralCalls++;
              return { value: Number(args.value) + 1 };
            },
          },
        ],
      ]),
    });
    const mixed = new MixedCentral({
      authority: gatewayAuthority,
      capabilities,
      authorize: (intent) => authorize(intent.binding),
    });
    gatewayCentral = new CentralLink({
      nodeId: 'test',
      authorize,
      execute: (intent, signal, final) => mixed.execute(intent, signal, final),
      status: (intent) => mixed.status(intent),
      send: (message) => gatewayFlow!.send(message),
    });
    nodeCentral = new CentralLink({
      nodeId: 'test',
      authorize,
      send: (message) => nodeFlow!.send(message),
    });
    local = new LocalEnvironment({
      nodeId: 'test',
      journal: nodeJ,
      authorize,
      // Node → gateway progress/operation events and results over the same delayed
      // subchannel. No production composition exists yet; this mirrors the host wiring.
      event: (event) => {
        void nodeFlow
          ?.send({
            version: ENVIRONMENT_PROTOCOL_VERSION,
            requestId: randomUUID(),
            type: 'execution.event',
            event,
          })
          .catch(fail);
      },
      // Terminal results are pushed as soon as they are durable; status stays a fallback.
      result: (record) => {
        void nodeFlow
          ?.send({
            version: ENVIRONMENT_PROTOCOL_VERSION,
            requestId: randomUUID(),
            type: 'execution.result',
            record,
          })
          .catch(fail);
      },
    });
    sessions.forEach(({ descriptor }, i) => {
      const executor = executors[i]!;
      const sessionId = descriptor.binding.sessionId;
      // Same process: a trusted span around the node executor entry, never inside the child.
      const timed: EnvironmentExecutor = {
        get healthy() {
          return executor.healthy;
        },
        ...(executor.managesBudget === undefined ? {} : { managesBudget: executor.managesBudget }),
        async execute(intent, signal, event, remaining) {
          const start = performance.now();
          const queued = queueStarts.get(sessionId);
          if (queued !== undefined && intent.capability === queuedCapability.get(sessionId))
            metrics.toolQueueMs.push(start - queued);
          if (intent.capability === 'read' || intent.capability === 'ptc')
            metrics.environmentCalls++;
          try {
            return await executor.execute(intent, signal, event, remaining);
          } finally {
            metrics.toolExecutionMs.push(performance.now() - start);
          }
        },
      };
      local!.provision(descriptor, timed);
      gatewayJournal.provision(descriptor.binding, descriptor.revision, descriptor.policyRevision);
    });
    remote = new RemoteEnvironment({
      nodeId: 'test',
      journal: gatewayJournal,
      authorize,
      central: gatewayCentral,
      send: (message) => gatewayFlow!.send(message),
      // As createGatewayRuntimeHost wires it: node inner-operation events commit durably.
      event: async (event) => {
        if (
          event.kind === 'operation' &&
          (event.payload as { type?: unknown } | null)?.type === 'tool_execution_end'
        )
          innerOperationEnds++;
        runtime?.clients.environment(event);
      },
    });
    gatewayFlow = new EnvironmentFlow({
      send: (raw) => services.nodes.sendEnvironmentFrame('test', raw),
      append: (...args) => incoming.append(...args),
      take: (id) => incoming.take(id),
      discard: (id) => incoming.discard(id),
      receive: (message) => {
        inspect(message);
        return remote!.receive(message);
      },
      failed: () => remote!.disconnect(),
    });
    services.nodes.onEnvironmentFrame = async (nodeId, raw) => {
      if (nodeId !== 'test') throw new Error('Unexpected node');
      await gatewayFlow!.receive(raw);
    };
    node = await startNode(
      { ...nodeConfig, daemonUrl: `ws://127.0.0.1:${relayPort}` },
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
            receive: (() => {
              const receive = nodeEnvironmentReceiver({
                environment: local!,
                central: nodeCentral!,
                send: (message) => nodeFlow!.send(message),
              });
              return (message: Parameters<typeof receive>[0]) => {
                inspect(message);
                return receive(message);
              };
            })(),
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
    const facing = await guarded(nodeFacing.promise);
    // Registration and the Environment subchannel both cross the delayed link.
    const deadline = performance.now() + 15000;
    while (!nodeFlow || !services.nodes.list().some((entry) => entry.id === 'test')) {
      if (performance.now() > deadline) throw new Error('Node registration timed out');
      await guarded(Bun.sleep(5));
    }
    for (const { lease } of sessions) await guarded(remote.describe(lease.binding));
    // Same delayed path, one monotonic clock: relay → node socket ping/pong → relay.
    metrics.measuredRttMs = await guarded(
      new Promise<number>((resolve) => {
        const start = performance.now();
        facing.once('pong', () => up.send('', () => resolve(performance.now() - start)));
        down.send('', () => facing.ping());
      }),
    );
    uiClient = new WebSocket(`ws://127.0.0.1:${relayPort}/ui`);
    uiClient.on('error', fail);
    const expected = EXPECTED[cell.fixture];
    uiClient.on('message', (raw) => {
      const { sessionId, event } = JSON.parse(String(raw)) as {
        sessionId: string;
        event: RuntimeEvent;
      };
      if (event.type === 'message_update') {
        const token = (event.assistantMessageEvent as { delta?: unknown }).delta;
        const start = typeof token === 'string' ? deltaStarts.get(token) : undefined;
        if (typeof token !== 'string' || start === undefined || receivedTokens.has(token)) {
          metrics.errors.push('Duplicate or unknown delta delivery');
        } else {
          receivedTokens.add(token);
          metrics.deltaToUiMs.push(performance.now() - start);
          deltaStarts.delete(token);
        }
      }
      if (event.type === 'tool_execution_end') {
        toolEnds.set(sessionId, (toolEnds.get(sessionId) ?? 0) + 1);
        if (event.isError)
          metrics.errors.push(`Tool returned an error: ${JSON.stringify(event.result)}`);
        else if (resultText(event.result) !== expected)
          metrics.errors.push(`Unexpected tool result: ${JSON.stringify(event.result)}`);
      }
      if (event.type === 'agent_settled') {
        metrics.taskMs.push(performance.now() - sessionStarts.get(sessionId)!);
        if (++settled === cell.sessions) finished.resolve();
      }
    });
    await guarded(
      new Promise<void>((resolve, reject) => {
        uiClient!.once('open', resolve);
        uiClient!.once('error', reject);
      }),
    );
    const ui = await guarded(uiReady.promise);
    const rounds = new Map<string, number>();
    // Same object and calls; only wall-time spans around each Environment RPC are recorded.
    const environment = new Proxy(remote, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== 'function') return value;
        if (!TRACED.includes(property as (typeof TRACED)[number])) return value.bind(target);
        return async (...args: unknown[]) => {
          const start = performance.now();
          try {
            return await value.apply(target, args);
          } finally {
            span(`rpc.${String(property)}`, performance.now() - start);
          }
        };
      },
    });
    const agentStarts = new Map<string, number>();
    // The default production launcher, constructed identically; timed to its first phase.
    const workerFactory = (): RuntimeWorker => {
      const created = performance.now();
      const worker = options.worker
        ? new GatewayWorkerProcess({ executable: options.worker })
        : syntheticWorker();
      return {
        drive(step, signal) {
          let first = true;
          return worker.drive(async (action) => {
            if (first) {
              first = false;
              span('worker.firstPhase', performance.now() - created);
            }
            return step(action);
          }, signal);
        },
        close: () => worker.close(),
      };
    };
    runtime = new GatewayAgentRuntime({
      authority: gatewayAuthority,
      environment,
      online: () => services.nodes.list().some((entry) => entry.id === 'test'),
      inference: {
        // Same deterministic provider and injection level as M0's NodeRegistry.onInference.
        async run(request, signal, delta) {
          metrics.modelCalls++;
          metrics.contextBytes.push(
            Buffer.byteLength(
              JSON.stringify({
                systemPrompt: request.systemPrompt,
                messages: request.messages,
                tools: request.tools,
              }),
            ),
          );
          const id = request.sessionId!;
          const round = rounds.get(id) ?? 0;
          rounds.set(id, round + 1);
          const content: AssistantMessage['content'] = [];
          const result: AssistantMessage = {
            role: 'assistant',
            api: 'openai-chat',
            provider: 'synthetic',
            model: 'm0',
            content,
            usage: emptyUsage(),
            stopReason: 'stop',
            timestamp: 1,
          };
          for (let chunk = 0; chunk < 4; chunk++) {
            await Bun.sleep(5);
            signal.throwIfAborted();
            const token = `${id}:${round}:${chunk};`;
            deltaStarts.set(token, performance.now());
            delta({ type: 'text_delta', contentIndex: 0, delta: token }, result);
            if (content[0]?.type === 'text') content[0].text += token;
            else content.push({ type: 'text', text: token });
          }
          if (round === 0 && cell.fixture !== 'chat') {
            result.stopReason = 'toolUse';
            const code =
              cell.fixture === 'ptc-10'
                ? 'let p = "0.txt"; for (let i = 0; i < 10; i++) { p = (await tools.read({path:p})).content.trim(); } return p;'
                : 'const a = await tools.read({path:"0.txt"}); const b = await tools.web_search({value:parseInt(a.content)}); return (await tools.read({path:b.value + ".txt"})).content;';
            content.push({
              type: 'toolCall',
              id: `tool-${id}`,
              name: cell.fixture === 'single-tool' ? 'read' : 'ptc',
              arguments: cell.fixture === 'single-tool' ? { path: '0.txt' } : { code },
            });
          }
          return result;
        },
      },
      models: [{ provider: 'synthetic', id: 'm0', thinking: 'off', contextWindow: 1_000_000 }],
      authorizeModel() {},
      systemPrompt: 'Gateway system prompt',
      tools: [
        { name: 'read', description: readTool.description, parameters: {} },
        { name: 'web_search', description: centralTool.description, parameters: {} },
      ],
      ptc: new GatewayPtcService({
        environment,
        journal: gatewayJournal,
        inner: gatewayAuthority.inner,
        // Environment-only and mixed scripts are node-placed; no gateway guest starts.
        workerExecutable: process.env.PIRC_TEST_NATIVE_PTC ?? '/unused-node-placement-only',
        online: () => services.nodes.list().some((entry) => entry.id === 'test'),
        central: async () => {
          throw new Error('Gateway-only PTC is not part of this fixture');
        },
      }),
      // Host parity: direct central dispatch and goals are composed as in production.
      central: new DirectCentral({
        authority: gatewayAuthority,
        capabilities,
        authorize: (intent) => authorize(intent.binding),
      }),
      goals: new GatewayGoals(gatewayAuthority),
      workerExecutable: options.worker ?? '/unused-synthetic-worker',
      workerFactory,
      event: (event) => {
        if (event.type === 'agent_start') {
          agentStarts.set(event.sessionId, performance.now());
          span('turn.prepare', performance.now() - sessionStarts.get(event.sessionId)!);
        }
        if (event.type === 'agent_settled' && agentStarts.has(event.sessionId))
          span('turn.agentToSettled', performance.now() - agentStarts.get(event.sessionId)!);
        if (event.type === 'tool_execution_start') {
          queueStarts.set(event.sessionId, performance.now());
          queuedCapability.set(event.sessionId, event.toolName);
        }
        const frame = JSON.stringify({ sessionId: event.sessionId, event });
        if (measured) metrics.uiBytes += Buffer.byteLength(frame);
        ui.send(frame);
      },
    });
    const cpu = process.cpuUsage();
    metrics.rssStartBytes = process.memoryUsage().rss;
    metrics.rssPeakBytes = metrics.rssStartBytes;
    const sampleResources = () => {
      metrics.rssPeakBytes = Math.max(metrics.rssPeakBytes, process.memoryUsage().rss);
      metrics.peakDelayQueueBytes = Math.max(metrics.peakDelayQueueBytes, up.bytes + down.bytes);
      metrics.peakSocketBufferedBytes = Math.max(
        metrics.peakSocketBufferedBytes,
        ...[...peers, uiClient!].map((socket) => socket.bufferedAmount),
      );
    };
    measured = true;
    timer = setInterval(sampleResources, 2);
    for (const { lease } of sessions) {
      sessionStarts.set(lease.binding.sessionId, performance.now());
      const run = runtime
        .run(lease, 'alice', {
          runId: randomUUID(),
          turnId: randomUUID(),
          text: 'Run the synthetic fixture.',
          attachments: [],
        })
        .then((state) => {
          if (state.state !== 'completed') metrics.errors.push(`Run ${state.state}`);
        });
      // A run that throws before agent_settled must fail the sample, not hit the watchdog.
      run.catch(fail);
      runs.push(run);
    }
    await guarded(finished.promise);
    sampleResources();
    measured = false;
    // agent_settled precedes worker close; the run's terminal state is checked too.
    await guarded(Promise.all(runs));
    const usage = process.cpuUsage(cpu);
    metrics.cpuUserMs = usage.user / 1000;
    metrics.cpuSystemMs = usage.system / 1000;
    metrics.peakDelayQueueBytes = Math.max(metrics.peakDelayQueueBytes, up.peak, down.peak);
    // Outer node executions: one read, or one whole node-placed PTC script.
    if (metrics.environmentCalls !== (cell.fixture === 'chat' ? 0 : cell.sessions))
      metrics.errors.push('Environment call count mismatch');
    if (metrics.centralCalls !== (cell.fixture === 'mixed-ptc' ? cell.sessions : 0))
      metrics.errors.push('Central call count mismatch');
    if (metrics.modelCalls !== cell.sessions * (cell.fixture === 'chat' ? 1 : 2))
      metrics.errors.push('Model call count mismatch');
    if (metrics.deltaToUiMs.length !== metrics.modelCalls * 4 || deltaStarts.size)
      metrics.errors.push('Missing or duplicate delta delivery');
    const inner = { chat: 0, 'single-tool': 0, 'ptc-10': 10, 'mixed-ptc': 3 }[cell.fixture];
    if (innerOperationEnds !== inner * cell.sessions)
      metrics.errors.push('Inner operation event count mismatch');
    for (const { lease } of sessions) {
      if ((toolEnds.get(lease.binding.sessionId) ?? 0) !== (cell.fixture === 'chat' ? 0 : 1))
        metrics.errors.push('Tool end event count mismatch');
      // Exactly one durable tool result per call; no lost or duplicated transcript entries.
      const results = gatewayAuthority
        .read(lease.binding.sessionId, 'alice')
        .entries.filter((entry) => JSON.stringify(entry).includes('"role":"toolResult"'));
      if (results.length !== (cell.fixture === 'chat' ? 0 : 1))
        metrics.errors.push('Transcript tool result count mismatch');
    }
    metrics.success = metrics.errors.length === 0;
    return metrics;
  } finally {
    measured = false;
    clearTimeout(watchdog);
    if (timer) clearInterval(timer);
    await runtime?.close().catch(() => {});
    remote?.disconnect();
    gatewayCentral?.disconnect();
    nodeCentral?.disconnect();
    gatewayFlow?.close();
    nodeFlow?.close();
    await gatewayCentral?.drain().catch(() => {});
    await local?.close().catch(() => {});
    for (const executor of executors) await executor.closeAndWait().catch(() => {});
    await node?.close().catch(() => {});
    up.close();
    down.close();
    uiClient?.terminate();
    for (const peer of peers) peer.terminate();
    if (relay) await new Promise<void>((resolve) => relay!.close(() => resolve()));
    await app?.close().catch(() => {});
    nodeJournal?.close();
    transport?.close();
    authority?.close();
    database?.raw.close();
    if (oldConfig === undefined) delete process.env.PIRC_CONFIG_DIR;
    else process.env.PIRC_CONFIG_DIR = oldConfig;
    await rm(root, { recursive: true, force: true });
    if (daemon) await rm(daemon.stateDir, { recursive: true, force: true });
    if (nodeConfig) await rm(nodeConfig.stateDir, { recursive: true, force: true });
  }
}
