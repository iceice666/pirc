/** Synthetic M0 baseline. Real Agent/Unix relay/NodeRegistry/PTC, test-only delayed WS links. */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { Agent } from '../../src/agent/agent.js';
import { loadAgentConfig } from '../../src/agent/config.js';
import { emptyUsage, type AssistantMessage } from '../../src/agent/messages.js';
import { RpcUi } from '../../src/agent/rpc.js';
import { SessionStore } from '../../src/agent/session-store.js';
import { readTool } from '../../src/agent/tools/files.js';
import { typed, type Tool } from '../../src/agent/tools/types.js';
import { NodeRegistry } from '../../src/daemon/nodes.js';
import { ModelStore, modelsSchema } from '../../src/models.js';
import { startNodeInference } from '../../src/node/inference.js';
import { NODE_PROTOCOL_VERSION } from '../../src/protocol.js';

export const FIXTURES = ['chat', 'single-tool', 'ptc-10', 'mixed-ptc'] as const;
export type Fixture = (typeof FIXTURES)[number];
export interface Cell {
  rttMs: number;
  contextBytes: number;
  sessions: number;
  fixture: Fixture;
}
export interface Sample {
  cell: Cell;
  success: boolean;
  errors: string[];
  measuredRttMs: number;
  taskMs: number[];
  deltaToUiMs: number[];
  toolQueueMs: number[];
  toolExecutionMs: number[];
  contextBytes: number[];
  nodeToGatewayBytes: number;
  gatewayToNodeBytes: number;
  uiBytes: number;
  modelCalls: number;
  environmentCalls: number;
  centralCalls: number;
  peakDelayQueueBytes: number;
  peakSocketBufferedBytes: number;
  cpuUserMs: number;
  cpuSystemMs: number;
  rssStartBytes: number;
  rssPeakBytes: number;
}

export function distribution(values: number[]) {
  if (!values.length) return { n: 0, p50: null, p95: null };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: sorted[Math.ceil(sorted.length * 0.5) - 1]!,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1]!,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** Fixed propagation delay, not bandwidth shaping. Concurrent frames retain FIFO timer order. */
export class DelayQueue {
  bytes = 0;
  peak = 0;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  constructor(readonly delayMs: number) {}
  send(frame: string, deliver: () => void) {
    const bytes = Buffer.byteLength(frame);
    this.bytes += bytes;
    this.peak = Math.max(this.peak, this.bytes);
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.bytes -= bytes;
      deliver();
    }, this.delayMs);
    this.timers.add(timer);
  }
  close() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.bytes = 0;
  }
}

export async function runSample(cell: Cell): Promise<Sample> {
  if (
    ![0, 30, 100, 200].includes(cell.rttMs) ||
    ![1, 4].includes(cell.sessions) ||
    ![1024, 262144].includes(cell.contextBytes) ||
    !FIXTURES.includes(cell.fixture)
  )
    throw new Error('Unsupported baseline cell');
  const root = await mkdtemp(path.join(tmpdir(), 'pirc-runtime-m0-'));
  const up = new DelayQueue(cell.rttMs / 2);
  const down = new DelayQueue(cell.rttMs / 2);
  const metrics: Sample = {
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
  };
  const catalog = modelsSchema.parse({
    providers: {
      synthetic: {
        api: 'openai-chat',
        baseUrl: 'http://127.0.0.1:1',
        models: [{ id: 'm0', contextWindow: 1000000, maxTokens: 1000 }],
      },
    },
    defaultModel: { provider: 'synthetic', id: 'm0', thinking: 'off' },
  });
  const modelStore = new ModelStore();
  modelStore.set(catalog);
  const nodes = new NodeRegistry(modelStore);
  const agents: Agent[] = [];
  const peers = new Set<WebSocket>();
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const registered = deferred<void>();
  const heartbeat = deferred<void>();
  const finished = deferred<void>();
  const uiReady = deferred<WebSocket>();
  const deltaStarts = new Map<string, number>();
  const receivedTokens = new Set<string>();
  const sessionStarts = new Map<string, number>();
  const queueStarts = new Map<string, number>();
  const centralPending = new Map<string, ReturnType<typeof deferred<unknown>>>();
  let measured = false;
  let settled = 0;
  let sequence = 0;
  let relay: Awaited<ReturnType<typeof startNodeInference>> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let nodeClient: WebSocket | undefined;
  let uiClient: WebSocket | undefined;
  const fatal = deferred<never>();
  const fail = (error: unknown) =>
    fatal.reject(error instanceof Error ? error : new Error(String(error)));
  const guarded = <T>(promise: Promise<T>) => Promise.race([promise, fatal.promise]);
  // Keep early transport errors observed while setup is in progress.
  void fatal.promise.catch(() => {});
  watchdog = setTimeout(() => fail(new Error('Baseline run exceeded 30 seconds')), 30000);
  const sendUp = (value: unknown) => {
    const frame = JSON.stringify(value);
    if (measured) metrics.nodeToGatewayBytes += Buffer.byteLength(frame);
    up.send(frame, () => {
      if (nodeClient?.readyState === WebSocket.OPEN) nodeClient.send(frame);
    });
    return true;
  };
  try {
    await guarded(
      new Promise<void>((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
      }),
    );
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No loopback listener');
    server.on('connection', (socket, request) => {
      peers.add(socket);
      socket.on('error', fail);
      if (request.url === '/ui') {
        uiReady.resolve(socket);
        return;
      }
      const send = socket.send.bind(socket);
      // NodeRegistry uses the real ws socket, including its actual bufferedAmount.
      socket.send = ((data: string, callback?: (error?: Error) => void) => {
        const frame = String(data);
        if (measured) metrics.gatewayToNodeBytes += Buffer.byteLength(frame);
        down.send(frame, () => {
          if (socket.readyState === WebSocket.OPEN) send(frame, callback);
          else callback?.(new Error('Baseline link closed'));
        });
      }) as typeof socket.send;
      nodes.attach('baseline-node', socket);
    });
    nodeClient = new WebSocket(`ws://127.0.0.1:${address.port}/node`);
    nodeClient.on('error', fail);
    nodeClient.on('message', (raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.type === 'registered') registered.resolve();
      if (frame.type === 'heartbeat_ack') heartbeat.resolve();
      if (['model_delta', 'model_end', 'model_error'].includes(frame.type))
        relay?.receive(frame.requestId, frame);
      if (frame.type === 'agent_response') {
        const pending = centralPending.get(frame.requestId);
        centralPending.delete(frame.requestId);
        if (frame.body.error) pending?.reject(new Error(frame.body.error.message));
        else pending?.resolve(frame.body.result);
      }
    });
    await guarded(
      new Promise<void>((resolve, reject) => {
        nodeClient!.once('open', resolve);
        nodeClient!.once('error', reject);
      }),
    );
    sendUp({ type: 'register', role: 'node', protocol: NODE_PROTOCOL_VERSION, workspaces: [] });
    await guarded(registered.promise);
    const pingAt = performance.now();
    sendUp({ type: 'heartbeat' });
    await guarded(heartbeat.promise);
    metrics.measuredRttMs = performance.now() - pingAt;
    uiClient = new WebSocket(`ws://127.0.0.1:${address.port}/ui`);
    uiClient.on('error', fail);
    uiClient.on('message', (raw) => {
      const { sessionId, event } = JSON.parse(String(raw));
      const message = event.message;
      if (message.type === 'message_update') {
        const token = message.assistantMessageEvent?.delta;
        const start = deltaStarts.get(token);
        if (typeof token !== 'string' || start === undefined || receivedTokens.has(token)) {
          metrics.errors.push('Duplicate or unknown delta delivery');
        } else {
          receivedTokens.add(token);
          metrics.deltaToUiMs.push(performance.now() - start);
          deltaStarts.delete(token);
        }
      }
      if (message.type === 'agent_settled') {
        metrics.taskMs.push(performance.now() - sessionStarts.get(sessionId)!);
        if (++settled === cell.sessions) finished.resolve();
      }
    });
    const ui = await guarded(uiReady.promise);
    nodes.resolveSession = (_node, id) => id;
    nodes.onEvent = (_node, sessionId, event) => {
      const frame = JSON.stringify({ sessionId, event });
      if (measured) metrics.uiBytes += Buffer.byteLength(frame);
      ui.send(frame);
    };
    nodes.onAgentRequest = async (_node, request) => {
      metrics.centralCalls++;
      return {
        status: 200,
        body: { result: { value: Number((request.args as { value: number }).value) + 1 } },
      };
    };
    const rounds = new Map<string, number>();
    nodes.onInference = async (request, signal, delta) => {
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
            : 'const a = await tools.read({path:"0.txt"}); const b = await tools.baseline_central({value:parseInt(a.content)}); return (await tools.read({path:b.value + ".txt"})).content;';
        content.push({
          type: 'toolCall',
          id: `tool-${id}`,
          name: cell.fixture === 'single-tool' ? 'read' : 'ptc',
          arguments: cell.fixture === 'single-tool' ? { path: '0.txt' } : { code },
        });
      }
      return result;
    };
    relay = await startNodeInference({
      stateDir: path.join(root, 'inference'),
      send: sendUp,
      getModels: () => ({ ...catalog, inference: relay!.config }),
    });
    for (let i = 0; i < cell.sessions; i++) {
      const workspace = path.join(root, `workspace-${i}`);
      await mkdir(workspace);
      for (let n = 0; n <= 10; n++)
        await writeFile(path.join(workspace, `${n}.txt`), `${n + 1}.txt`);
      const store = new SessionStore(path.join(root, `session-${i}`), workspace);
      store.append({
        type: 'message',
        message: { role: 'user', content: 'h'.repeat(cell.contextBytes), timestamp: 1 },
      });
      store.append({
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
      const central: Tool = {
        name: 'baseline_central',
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
        async execute(args) {
          const requestId = `central-${++sequence}`;
          const pending = deferred<unknown>();
          centralPending.set(requestId, pending);
          sendUp({
            type: 'agent_request',
            requestId,
            sessionId: store.sessionId,
            op: 'baseline.lookup',
            args,
          });
          const result = (await pending.promise) as { value: number };
          return typed(JSON.stringify(result), result);
        },
      };
      const tools = [readTool, central].map(
        (tool): Tool => ({
          ...tool,
          async execute(args, ctx) {
            const start = performance.now();
            const queued = queueStarts.get(ctx.toolCallId);
            if (queued !== undefined) metrics.toolQueueMs.push(start - queued);
            if (tool.name === 'read') metrics.environmentCalls++;
            try {
              return await tool.execute(args, ctx);
            } finally {
              metrics.toolExecutionMs.push(performance.now() - start);
            }
          },
        }),
      );
      const agent = new Agent({
        config: loadAgentConfig(
          workspace,
          { ...catalog, inference: relay.config },
          { PIRC_CONFIG_DIR: path.join(root, 'empty-config') },
        ),
        store,
        tools,
        ui: new RpcUi(() => {}),
        hasUI: false,
        emit: (message) => {
          if (message.type === 'agent_error')
            metrics.errors.push(`Agent error: ${String(message.error)}`);
          if (message.type === 'tool_execution_start')
            queueStarts.set(String(message.toolCallId), performance.now());
          if (message.type === 'tool_execution_end' && message.isError)
            metrics.errors.push(`Tool returned an error: ${JSON.stringify(message.result)}`);
          if (
            message.type === 'message_end' &&
            (message.message as AssistantMessage)?.stopReason === 'error'
          )
            metrics.errors.push('Model returned an error');
          sendUp({
            type: 'event',
            sessionId: store.sessionId,
            event: { type: 'pi_event', message },
          });
        },
      });
      agents.push(agent);
      await agent.init();
    }
    const cpu = process.cpuUsage();
    metrics.rssStartBytes = process.memoryUsage().rss;
    metrics.rssPeakBytes = metrics.rssStartBytes;
    const sampleResources = () => {
      metrics.rssPeakBytes = Math.max(metrics.rssPeakBytes, process.memoryUsage().rss);
      metrics.peakDelayQueueBytes = Math.max(metrics.peakDelayQueueBytes, up.bytes + down.bytes);
      metrics.peakSocketBufferedBytes = Math.max(
        metrics.peakSocketBufferedBytes,
        ...[...peers, nodeClient!, uiClient!].map((socket) => socket.bufferedAmount),
      );
    };
    measured = true;
    timer = setInterval(sampleResources, 2);
    for (const agent of agents) {
      sessionStarts.set(agent.store.sessionId, performance.now());
      agent.prompt('Run the synthetic fixture.');
    }
    await guarded(finished.promise);
    sampleResources();
    const usage = process.cpuUsage(cpu);
    metrics.cpuUserMs = usage.user / 1000;
    metrics.cpuSystemMs = usage.system / 1000;
    metrics.peakDelayQueueBytes = Math.max(metrics.peakDelayQueueBytes, up.peak, down.peak);
    const expectedEnvironment =
      { chat: 0, 'single-tool': 1, 'ptc-10': 10, 'mixed-ptc': 2 }[cell.fixture] * cell.sessions;
    if (metrics.environmentCalls !== expectedEnvironment)
      metrics.errors.push('Environment call count mismatch');
    if (metrics.centralCalls !== (cell.fixture === 'mixed-ptc' ? cell.sessions : 0))
      metrics.errors.push('Central call count mismatch');
    if (metrics.modelCalls !== cell.sessions * (cell.fixture === 'chat' ? 1 : 2))
      metrics.errors.push('Model call count mismatch');
    if (metrics.deltaToUiMs.length !== metrics.modelCalls * 4 || deltaStarts.size)
      metrics.errors.push('Missing or duplicate delta delivery');
    metrics.success = metrics.errors.length === 0;
    return metrics;
  } finally {
    if (watchdog) clearTimeout(watchdog);
    if (timer) clearInterval(timer);
    for (const pending of centralPending.values()) pending.reject(new Error('Baseline cleanup'));
    for (const agent of agents) await agent.shutdown();
    await relay?.close();
    up.close();
    down.close();
    nodes.close();
    nodeClient?.terminate();
    uiClient?.terminate();
    for (const peer of peers) peer.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}
