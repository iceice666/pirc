import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import { NODE_ID_PATTERN } from '../config.js';
import { ApiError } from '../errors.js';
import {
  NODE_FRAME_MAX_BYTES,
  NODE_PROTOCOL_VERSION,
  PROTOCOL_MISMATCH_CLOSE,
  type DaemonToNode,
  type NodeHttpRequest,
  type NodeHttpResponse,
  type RegisteredWorkspace,
} from '../protocol.js';
import type { ModelStore } from '../models.js';

const MAX_PENDING_REQUESTS = 100;
const MAX_TERMINAL_STREAMS = 64;
const REQUEST_TIMEOUT_MS = 30_000;

const registration = z.object({
  type: z.literal('register'),
  protocol: z.number().int().optional(),
  workspaces: z
    .array(
      z.object({
        id: z.string().regex(NODE_ID_PATTERN),
        displayName: z.string().min(1).max(200),
      }),
    )
    .max(100),
});
const nodeMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('heartbeat') }),
  z.object({
    type: z.literal('response'),
    requestId: z.string(),
    data: z.object({ status: z.number().int(), body: z.unknown() }),
  }),
  z.object({
    type: z.literal('event'),
    sessionId: z.string(),
    event: z.record(z.unknown()),
  }),
  z.object({ type: z.literal('terminal_frame'), streamId: z.string(), frame: z.unknown() }),
  z.object({
    type: z.literal('terminal_closed'),
    streamId: z.string(),
    code: z.number().int(),
    reason: z.string(),
  }),
]);

export interface ConnectedNode {
  id: string;
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
    { nodeId: string; handlers: TerminalStreamHandlers }
  >();
  onEvent?: (nodeId: string, sessionId: string, event: Record<string, unknown>) => void;
  onDisconnect?: (nodeId: string) => void;
  onRegister?: (node: ConnectedNode) => void;
  resolveSession?: (nodeId: string, remoteSessionId: string) => string | undefined;

  constructor(private readonly models: ModelStore) {}

  private socketFor(nodeId: string): WebSocket {
    const connection = this.connections.get(nodeId);
    if (!connection || connection.socket.readyState !== connection.socket.OPEN)
      throw new ApiError(503, 'node_offline', 'Node is offline');
    return connection.socket;
  }

  private send(socket: WebSocket, message: DaemonToNode, onError?: () => void): void {
    socket.send(JSON.stringify(message), (error) => {
      if (error) onError?.();
    });
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
      this.send(socket, { type: 'request', requestId, data }, () => {
        clearTimeout(timer);
        this.requests.delete(requestId);
        reject(new ApiError(503, 'node_offline', 'Node connection failed'));
      });
    });
  }

  /** Relay a browser terminal WebSocket to a node's terminal. */
  openTerminal(
    nodeId: string,
    target: { user: string; sessionId: string; terminalId: string },
    handlers: TerminalStreamHandlers,
  ): TerminalStream {
    const socket = this.socketFor(nodeId);
    if (this.streams.size >= MAX_TERMINAL_STREAMS)
      throw new ApiError(503, 'node_error', 'Too many open terminal streams');
    const streamId = randomUUID();
    this.streams.set(streamId, { nodeId, handlers });
    const fail = () => this.endStream(streamId, 1011, 'node connection failed');
    this.send(socket, { type: 'terminal_open', streamId, ...target }, fail);
    return {
      send: (message) => {
        if (!this.streams.has(streamId)) return;
        this.send(socket, { type: 'terminal_input', streamId, message }, fail);
      },
      close: () => {
        if (!this.streams.delete(streamId)) return;
        if (socket.readyState === socket.OPEN)
          this.send(socket, { type: 'terminal_close', streamId });
      },
    };
  }

  private endStream(streamId: string, code: number, reason: string): void {
    const stream = this.streams.get(streamId);
    if (!stream) return;
    this.streams.delete(streamId);
    stream.handlers.onClose(code, reason);
  }

  addWorkspace(nodeId: string, workspace: RegisteredWorkspace): void {
    const node = this.connections.get(nodeId)?.node;
    if (!node) throw new ApiError(503, 'node_offline', 'Node is offline');
    if (!node.workspaces.some((item) => item.id === workspace.id)) node.workspaces.push(workspace);
  }

  get(nodeId: string): ConnectedNode | undefined {
    return this.connections.get(nodeId)?.node;
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
          workspaces: parsed.data.workspaces,
          connectedAt: lastSeenAt,
          lastSeenAt,
        };
        this.connections.set(nodeId, { socket, node });
        this.onRegister?.(node);
        this.send(socket, { type: 'registered', nodeId, models: this.models.current });
        return;
      }
      if (this.connections.get(nodeId)?.socket !== socket)
        return socket.close(4000, 'replaced by new connection');
      const parsed = nodeMessage.safeParse(message);
      if (!parsed.success) return socket.close(1008, 'unsupported message');
      const current = parsed.data;
      switch (current.type) {
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
        case 'terminal_frame': {
          const stream = this.streams.get(current.streamId);
          if (stream?.nodeId === nodeId) stream.handlers.onFrame(current.frame);
          return;
        }
        case 'terminal_closed': {
          if (this.streams.get(current.streamId)?.nodeId === nodeId)
            this.endStream(current.streamId, current.code, current.reason);
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

  private failNode(nodeId: string): void {
    for (const [id, pending] of this.requests) {
      if (pending.nodeId !== nodeId) continue;
      clearTimeout(pending.timer);
      this.requests.delete(id);
      pending.reject(
        new ApiError(503, 'node_offline', 'Node disconnected; outcome may be unknown'),
      );
    }
    for (const [id, stream] of this.streams)
      if (stream.nodeId === nodeId) this.endStream(id, 1012, 'node disconnected');
  }

  /** Push the current providers to every node; agents started afterwards use them. */
  broadcastModels(): void {
    for (const { socket } of this.connections.values())
      if (socket.readyState === socket.OPEN)
        this.send(socket, { type: 'models', models: this.models.current });
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
