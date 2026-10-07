import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import {
  registrationSchema as registration,
  nodeMessageSchema as nodeMessage,
} from '../protocol-schema.js';
import { ApiError } from '../errors.js';
import {
  AGENT_OP_MAX_LENGTH,
  AGENT_OP_PATTERN,
  AGENT_REQUEST_MAX_BYTES,
  NODE_FRAME_MAX_BYTES,
  NODE_PROTOCOL_VERSION,
  PROTOCOL_MISMATCH_CLOSE,
  agentError,
  type AgentAnswer,
  type DaemonToNode,
  type NodeHttpRequest,
  type NodeHttpResponse,
  type RegisteredWorkspace,
  type SessionActivity,
} from '../protocol.js';
import { publicModels, type ModelStore } from '../models.js';
import type { AssistantDelta, AssistantMessage } from '../agent/messages.js';
import {
  INFERENCE_BUFFER_MAX_BYTES,
  INFERENCE_MAX_REQUESTS,
  INFERENCE_REQUEST_MAX_BYTES,
  INFERENCE_STREAM_MAX_BYTES,
  INFERENCE_TIMEOUT_MS,
  type InferenceRequest,
  type InferenceEvent,
} from '../inference-wire.js';

const MAX_PENDING_REQUESTS = 100;
const MAX_TERMINAL_STREAMS = 64;
/** Agent requests the daemon works on at once for one node. */
const MAX_AGENT_REQUESTS = 32;
const REQUEST_TIMEOUT_MS = 30_000;
/**
 * Largest browser→node relayed message, per stream kind: terminal input
 * (keystrokes, a paste, a resize) and browser-view input (mouse, keys, text
 * the node caps at 10 000 characters). Larger ones end that stream, never
 * the node link (audit M13).
 */
export const RELAY_MESSAGE_MAX_BYTES = { terminal: 1024 * 1024, browser: 64 * 1024 } as const;
/**
 * Bytes queued on a node link before further sends fail (the request or
 * stream that sent them, not the link). Room for a few maximal frames
 * (uploads) behind a slow node.
 */
const NODE_SEND_BUFFER_MAX_BYTES = 4 * NODE_FRAME_MAX_BYTES;
/** Reserve one small detach frame per admitted stream, even behind a congested link. */
const STREAM_CLOSE_RESERVE_BYTES = MAX_TERMINAL_STREAMS * 256;

type SendFailure = 'too_large' | 'backpressure' | 'failed';

export interface ConnectedNode {
  id: string;
  role: 'chat' | 'node';
  workspaces: RegisteredWorkspace[];
  connectedAt: number;
  lastSeenAt: number;
}

export interface TerminalStreamHandlers {
  onFrame(frame: unknown): void;
  onClose(code: number, reason: string): void;
}

export interface TerminalStream {
  send(message: unknown): void;
  close(): void;
}

export function validNodeToken(
  nodeTokens: Map<string, string>,
  nodeId: string,
  token: string,
): boolean {
  const expected = nodeTokens.get(nodeId);
  if (!expected || !token || token.length > 4096) return false;
  const actualBytes = Buffer.from(token);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

/** Connected nodes, request/response correlation, and relayed terminal streams. */
export class NodeRegistry {
  private readonly connections = new Map<string, { socket: WebSocket; node: ConnectedNode }>();
  private readonly pending = new Set<WebSocket>();
  private readonly requests = new Map<
    string,
    {
      nodeId: string;
      resolve: (value: NodeHttpResponse) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private readonly streams = new Map<
    string,
    { nodeId: string; socket: WebSocket; handlers: TerminalStreamHandlers }
  >();
  private readonly inferences = new Map<
    string,
    { nodeId: string; controller: AbortController; timer: NodeJS.Timeout; bytes: number }
  >();
  onInference?: (
    request: InferenceRequest,
    signal: AbortSignal,
    onDelta: (delta: AssistantDelta, partial: AssistantMessage) => void,
    nodeId: string,
  ) => Promise<AssistantMessage>;
  onEvent?: (nodeId: string, sessionId: string, event: Record<string, unknown>) => void;
  onDisconnect?: (nodeId: string) => void;
  /** The node's sessions with an open run or a write lease now (the node's own session ids). */
  onActivity?: (nodeId: string, sessions: SessionActivity[]) => void;
  onRegister?: (node: ConnectedNode) => void;
  acceptRole?: (nodeId: string, role: 'chat' | 'node') => boolean;
  resolveSession?: (nodeId: string, remoteSessionId: string) => string | undefined;
  /** Answers an agent's request that its node forwarded (see protocol.ts). */
  onAgentRequest?: (
    nodeId: string,
    request: { sessionId: string; op: string; args: unknown },
  ) => Promise<AgentAnswer>;
  private readonly agentRequests = new Map<string, number>();
  /** Byte offsets of a node's mirrored workspace-memory ledgers, sent when it registers. */
  mirrorWatermarks?: (nodeId: string) => Record<string, number>;
  /** Stores a mirrored chunk and returns the ledger's watermark (see protocol.ts). */
  onMirror?: (
    nodeId: string,
    frame: {
      ledgerKey: string;
      offset: number;
      end: number;
      reset?: boolean | undefined;
      lines: unknown[];
    },
  ) => number;

  constructor(private readonly models: ModelStore) {}

  private socketFor(nodeId: string): WebSocket {
    const connection = this.connections.get(nodeId);
    if (!connection || connection.socket.readyState !== connection.socket.OPEN)
      throw new ApiError(503, 'node_offline', 'Node is offline');
    return connection.socket;
  }

  /**
   * Send one frame to a node. A frame the node would reject (larger than its
   * frame limit: it closes the whole link with 1009) or one that would pile
   * up behind a stalled link fails only its sender, through `onError`.
   */
  private send(
    socket: WebSocket,
    message: DaemonToNode,
    onError?: (failure: SendFailure) => void,
  ): boolean {
    const frame = JSON.stringify(message);
    const bytes = Buffer.byteLength(frame);
    if (bytes > NODE_FRAME_MAX_BYTES) {
      onError?.('too_large');
      return false;
    }
    const limit =
      NODE_SEND_BUFFER_MAX_BYTES +
      (message.type === 'terminal_close' ? STREAM_CLOSE_RESERVE_BYTES : 0);
    if (socket.bufferedAmount + bytes > limit) {
      onError?.('backpressure');
      return false;
    }
    try {
      socket.send(frame, (error) => {
        if (error) onError?.('failed');
      });
      return true;
    } catch {
      onError?.('failed');
      return false;
    }
  }

  /**
   * Replay an HTTP request on the node. Resolves with the node's status and
   * body (including 4xx/5xx); rejects only when the transport fails, in which
   * case the outcome on the node is unknown.
   */
  request(nodeId: string, data: NodeHttpRequest): Promise<NodeHttpResponse> {
    if (this.requests.size >= MAX_PENDING_REQUESTS)
      return Promise.reject(new ApiError(503, 'node_error', 'Too many pending node requests'));
    let socket: WebSocket;
    try {
      socket = this.socketFor(nodeId);
    } catch (error) {
      return Promise.reject(error);
    }
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(requestId);
        reject(
          new ApiError(504, 'node_timeout', 'Node response timed out; outcome may be unknown'),
        );
      }, REQUEST_TIMEOUT_MS);
      this.requests.set(requestId, { nodeId, resolve, reject, timer });
      this.send(socket, { type: 'request', requestId, data }, (failure) => {
        clearTimeout(timer);
        this.requests.delete(requestId);
        reject(
          failure === 'too_large'
            ? new ApiError(413, 'payload_too_large', 'Request is too large to relay to the node')
            : failure === 'backpressure'
              ? new ApiError(503, 'node_error', 'Node link is congested; try again')
              : new ApiError(503, 'node_offline', 'Node connection failed'),
        );
      });
    });
  }

  /** Relay a browser terminal WebSocket to a node's terminal. */
  openTerminal(
    nodeId: string,
    target: { user: string; sessionId: string; terminalId: string; kind?: 'terminal' | 'browser' },
    handlers: TerminalStreamHandlers,
  ): TerminalStream {
    const socket = this.socketFor(nodeId);
    if (this.streams.size >= MAX_TERMINAL_STREAMS)
      throw new ApiError(503, 'node_error', 'Too many open terminal streams');
    const streamId = randomUUID();
    this.streams.set(streamId, { nodeId, socket, handlers });
    const fail = (failure: SendFailure) =>
      this.endStream(streamId, {
        code: failure === 'failed' ? 1011 : 1013,
        reason: failure === 'failed' ? 'node connection failed' : 'node link congested',
        detach: true,
      });
    this.send(socket, { type: 'terminal_open', streamId, ...target }, fail);
    return {
      send: (message) => {
        if (!this.streams.has(streamId)) return;
        const bytes = Buffer.byteLength(JSON.stringify(message ?? null));
        if (bytes > RELAY_MESSAGE_MAX_BYTES[target.kind ?? 'terminal']) {
          this.endStream(streamId, { code: 1009, reason: 'message too large', detach: true });
          return;
        }
        this.send(socket, { type: 'terminal_input', streamId, message }, fail);
      },
      close: () => this.endStream(streamId, { detach: true }),
    };
  }

  /** One finalizer for local detach, remote close and link loss. Never kills the shell. */
  private endStream(
    streamId: string,
    end: { detach?: boolean; code?: number; reason?: string },
  ): void {
    const stream = this.streams.get(streamId);
    if (!stream) return;
    // Remove first: synchronous send failures and client close callbacks can reenter.
    this.streams.delete(streamId);
    if (end.detach && stream.socket.readyState === stream.socket.OPEN) {
      this.send(stream.socket, { type: 'terminal_close', streamId }, () => {
        // A tiny reserved control budget normally permits detach under congestion.
        // If even that fails, close this original link: node link teardown detaches
        // all subscriptions. Never send an old stream's close on a replacement link.
        stream.socket.close(1013, 'stream cleanup failed');
      });
    }
    if (end.code !== undefined) stream.handlers.onClose(end.code, end.reason ?? '');
  }

  addWorkspace(nodeId: string, workspace: RegisteredWorkspace): void {
    const node = this.connections.get(nodeId)?.node;
    if (!node) throw new ApiError(503, 'node_offline', 'Node is offline');
    if (!node.workspaces.some((item) => item.id === workspace.id)) node.workspaces.push(workspace);
  }

  get(nodeId: string): ConnectedNode | undefined {
    return this.connections.get(nodeId)?.node;
  }

  disconnect(nodeId: string): void {
    const connection = this.connections.get(nodeId);
    if (!connection) return;
    this.connections.delete(nodeId);
    this.failNode(nodeId);
    this.onDisconnect?.(nodeId);
    connection.socket.close(4000, 'chat node binding released');
  }

  attach(nodeId: string, socket: WebSocket): void {
    if (this.pending.size >= 100) return socket.close(1013, 'too many pending registrations');
    this.pending.add(socket);
    // A reconnect replaces the old transport. Listeners on the old socket must not delete the new one.
    let registered = false;
    let lastSeenAt = Date.now();
    const deadline = setInterval(() => {
      if (Date.now() - lastSeenAt > (registered ? 45_000 : 10_000))
        socket.close(4001, 'heartbeat timeout');
    }, 5_000);
    deadline.unref();
    socket.on('message', (raw) => {
      const text = raw.toString();
      if (Buffer.byteLength(text) > NODE_FRAME_MAX_BYTES)
        return socket.close(1009, 'message too large');
      let message: unknown;
      try {
        message = JSON.parse(text);
      } catch {
        return socket.close(1007, 'invalid JSON');
      }
      if (!registered) {
        const envelope = z
          .object({ type: z.literal('register'), protocol: z.number().int().optional() })
          .safeParse(message);
        if (envelope.success && envelope.data.protocol !== NODE_PROTOCOL_VERSION)
          return socket.close(
            PROTOCOL_MISMATCH_CLOSE,
            `node protocol ${envelope.data.protocol ?? 1} != daemon ${NODE_PROTOCOL_VERSION}`,
          );
        const parsed = registration.safeParse(message);
        if (
          !parsed.success ||
          new Set(parsed.data.workspaces.map((w) => w.id)).size !== parsed.data.workspaces.length
        )
          return socket.close(1008, 'invalid registration');
        if (parsed.data.protocol !== NODE_PROTOCOL_VERSION)
          return socket.close(
            PROTOCOL_MISMATCH_CLOSE,
            `node protocol ${parsed.data.protocol ?? 1} != daemon ${NODE_PROTOCOL_VERSION}`,
          );
        if (
          parsed.data.workspaces.some(
            (workspace) => (workspace.kind === 'chat') !== (parsed.data.role === 'chat'),
          )
        )
          return socket.close(1008, 'workspace kind does not match node role');
        if (this.acceptRole && !this.acceptRole(nodeId, parsed.data.role)) {
          this.send(socket, {
            type: 'registration_error',
            status: 409,
            code: 'chat_node_exists',
            message:
              'A different chat node is bound to this gateway. Release it in Settings → Assistant first.',
          });
          return socket.close(4409, 'chat_node_exists');
        }
        registered = true;
        this.pending.delete(socket);
        if (this.connections.has(nodeId)) {
          this.onDisconnect?.(nodeId);
          this.connections.get(nodeId)?.socket.close(4000, 'replaced by new connection');
          this.failNode(nodeId);
        }
        lastSeenAt = Date.now();
        const node = {
          id: nodeId,
          role: parsed.data.role,
          workspaces: parsed.data.workspaces,
          connectedAt: lastSeenAt,
          lastSeenAt,
        };
        this.connections.set(nodeId, { socket, node });
        this.onRegister?.(node);
        this.send(socket, {
          type: 'registered',
          nodeId,
          models: publicModels(this.models.current),
          mirrors: this.mirrorWatermarks?.(nodeId) ?? {},
        });
        return;
      }
      if (this.connections.get(nodeId)?.socket !== socket)
        return socket.close(4000, 'replaced by new connection');
      const parsed = nodeMessage.safeParse(message);
      if (!parsed.success) return socket.close(1008, 'unsupported message');
      const current = parsed.data;
      switch (current.type) {
        case 'model_start':
          this.startInference(nodeId, socket, current.requestId, current.request);
          return;
        case 'model_cancel':
          this.cancelInference(nodeId, current.requestId);
          return;
        case 'heartbeat': {
          lastSeenAt = Date.now();
          const connection = this.connections.get(nodeId);
          if (connection) connection.node.lastSeenAt = lastSeenAt;
          this.send(socket, { type: 'heartbeat_ack' });
          return;
        }
        case 'response': {
          const pending = this.requests.get(current.requestId);
          if (!pending || pending.nodeId !== nodeId) return;
          clearTimeout(pending.timer);
          this.requests.delete(current.requestId);
          pending.resolve(current.data);
          return;
        }
        case 'event': {
          const sessionId = this.resolveSession?.(nodeId, current.sessionId);
          if (sessionId) this.onEvent?.(nodeId, sessionId, current.event);
          return;
        }
        case 'activity':
          this.onActivity?.(nodeId, current.sessions);
          return;
        case 'agent_request':
          this.answerAgent(nodeId, socket, current);
          return;
        case 'memory_mirror': {
          let watermark = current.offset;
          try {
            watermark = this.onMirror?.(nodeId, current) ?? current.end;
          } catch {
            /* nothing stored; the node sends it again after the acknowledgement */
          }
          this.send(socket, { type: 'memory_mirror_ack', ledgerKey: current.ledgerKey, watermark });
          return;
        }
        case 'terminal_frame': {
          const stream = this.streams.get(current.streamId);
          if (stream?.nodeId === nodeId) stream.handlers.onFrame(current.frame);
          return;
        }
        case 'terminal_closed': {
          if (this.streams.get(current.streamId)?.nodeId === nodeId)
            this.endStream(current.streamId, { code: current.code, reason: current.reason });
          return;
        }
      }
    });
    socket.on('close', () => {
      this.pending.delete(socket);
      clearInterval(deadline);
      if (this.connections.get(nodeId)?.socket === socket) {
        this.connections.delete(nodeId);
        this.failNode(nodeId);
        this.onDisconnect?.(nodeId);
      }
    });
  }

  /**
   * The op and args come from an agent, so a bad value is answered with an
   * error rather than treated as a protocol violation that closes the link.
   */
  private answerAgent(
    nodeId: string,
    socket: WebSocket,
    message: { requestId: string; sessionId: string; op: string; args?: unknown },
  ): void {
    const reply = ({ status, body }: AgentAnswer) => {
      if (socket.readyState !== socket.OPEN) return;
      const requestId = message.requestId;
      this.send(socket, { type: 'agent_response', requestId, status, body }, (failure) => {
        // An answer too large for one frame becomes an error, not a dropped link.
        if (failure === 'too_large') {
          const error = agentError(413, 'payload_too_large', 'Gateway answer is too large');
          this.send(socket, { type: 'agent_response', requestId, ...error });
        }
      });
    };
    const inFlight = this.agentRequests.get(nodeId) ?? 0;
    if (inFlight >= MAX_AGENT_REQUESTS)
      return reply(
        agentError(
          429,
          'too_many_requests',
          'Too many gateway requests are in flight for this node',
        ),
      );
    if (message.op.length > AGENT_OP_MAX_LENGTH || !AGENT_OP_PATTERN.test(message.op))
      return reply(
        agentError(400, 'invalid_input', 'A gateway operation is named like area.action'),
      );
    const args = message.args ?? {};
    if (Buffer.byteLength(JSON.stringify(args)) > AGENT_REQUEST_MAX_BYTES)
      return reply(agentError(413, 'payload_too_large', 'Gateway request arguments are too large'));
    const handler = this.onAgentRequest;
    if (!handler)
      return reply(
        agentError(404, 'unknown_operation', `Unknown gateway operation: ${message.op}`),
      );
    this.agentRequests.set(nodeId, inFlight + 1);
    void handler(nodeId, { sessionId: message.sessionId, op: message.op, args })
      .catch(() => agentError(500, 'internal_error', 'The gateway operation failed'))
      .then((answer) => {
        const left = (this.agentRequests.get(nodeId) ?? 1) - 1;
        if (left > 0) this.agentRequests.set(nodeId, left);
        else this.agentRequests.delete(nodeId);
        reply(answer);
      });
  }

  private cancelInference(nodeId: string, requestId: string): void {
    const key = JSON.stringify([nodeId, requestId]);
    const request = this.inferences.get(key);
    if (!request) return;
    this.inferences.delete(key);
    clearTimeout(request.timer);
    request.controller.abort();
  }

  private startInference(
    nodeId: string,
    socket: WebSocket,
    requestId: string,
    request: InferenceRequest,
  ): void {
    const key = JSON.stringify([nodeId, requestId]);
    // A duplicate ID must never replace or route into another active stream.
    if (this.inferences.has(key)) {
      socket.close(1008, 'duplicate inference request');
      return;
    }
    const send = (event: InferenceEvent): boolean => {
      if (socket.readyState !== socket.OPEN) return false;
      const frame = JSON.stringify({ ...event, requestId });
      if (
        Buffer.byteLength(frame) > NODE_FRAME_MAX_BYTES ||
        socket.bufferedAmount + Buffer.byteLength(frame) > INFERENCE_BUFFER_MAX_BYTES
      )
        return false;
      socket.send(frame, (error) => {
        if (error) this.cancelInference(nodeId, requestId);
      });
      return true;
    };
    if (!this.onInference) {
      send({ type: 'model_error', code: 'unavailable' });
      return;
    }
    if (
      this.inferences.size >= 128 ||
      [...this.inferences.values()].filter((item) => item.nodeId === nodeId).length >=
        INFERENCE_MAX_REQUESTS ||
      Buffer.byteLength(JSON.stringify(request)) > INFERENCE_REQUEST_MAX_BYTES
    ) {
      if (!send({ type: 'model_error', code: 'limit_exceeded' }))
        socket.close(1013, 'inference buffer limit');
      return;
    }
    const controller = new AbortController();
    const finish = (event: InferenceEvent) => {
      if (!this.inferences.has(key)) return;
      this.cancelInference(nodeId, requestId);
      if (!send(event) && !send({ type: 'model_error', code: 'limit_exceeded' }))
        socket.close(1013, 'inference buffer limit');
    };
    const timer = setTimeout(
      () => finish({ type: 'model_error', code: 'timeout' }),
      INFERENCE_TIMEOUT_MS,
    );
    timer.unref();
    const state = { nodeId, controller, timer, bytes: 0 };
    this.inferences.set(key, state);
    const onDelta = (delta: AssistantDelta) => {
      if (!this.inferences.has(key)) return;
      const event: InferenceEvent = { type: 'model_delta', delta };
      state.bytes += Buffer.byteLength(JSON.stringify(event));
      if (state.bytes > INFERENCE_STREAM_MAX_BYTES || !send(event))
        finish({ type: 'model_error', code: 'limit_exceeded' });
    };
    try {
      void this.onInference(request, controller.signal, onDelta, nodeId).then(
        (message) => finish({ type: 'model_end', message }),
        () => finish({ type: 'model_error', code: 'inference_failed' }),
      );
    } catch {
      finish({ type: 'model_error', code: 'inference_failed' });
    }
  }

  private failNode(nodeId: string): void {
    for (const [key, request] of this.inferences) {
      if (request.nodeId !== nodeId) continue;
      this.inferences.delete(key);
      clearTimeout(request.timer);
      request.controller.abort();
    }
    for (const [id, pending] of this.requests) {
      if (pending.nodeId !== nodeId) continue;
      clearTimeout(pending.timer);
      this.requests.delete(id);
      pending.reject(
        new ApiError(503, 'node_offline', 'Node disconnected; outcome may be unknown'),
      );
    }
    for (const [id, stream] of this.streams)
      if (stream.nodeId === nodeId) this.endStream(id, { code: 1012, reason: 'node disconnected' });
  }

  /** Push the current providers to every node; agents started afterwards use them. */
  broadcastModels(): void {
    for (const { socket } of this.connections.values())
      if (socket.readyState === socket.OPEN)
        this.send(socket, { type: 'models', models: publicModels(this.models.current) });
  }

  list(): ConnectedNode[] {
    return [...this.connections.values()].map(({ node }) => ({
      ...node,
      workspaces: [...node.workspaces],
    }));
  }

  close(): void {
    for (const nodeId of this.connections.keys()) this.failNode(nodeId);
    for (const socket of this.pending) socket.close(1001, 'daemon shutting down');
    this.pending.clear();
    for (const { socket } of this.connections.values()) socket.close(1001, 'daemon shutting down');
    this.connections.clear();
  }
}
