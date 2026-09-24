import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import type { GatewayConfig } from './config.js';
import { ApiError } from './errors.js';

const registration = z.object({
  type: z.literal('register'),
  workspaces: z
    .array(
      z.object({
        id: z.string().min(1).max(100),
        displayName: z.string().min(1).max(200),
      }),
    )
    .max(100),
});

export interface ConnectedNode {
  id: string;
  workspaces: Array<{ id: string; displayName: string }>;
  connectedAt: number;
  lastSeenAt: number;
}

export function validNodeToken(config: GatewayConfig, nodeId: string, token: string): boolean {
  const expected = config.nodeTokens?.get(nodeId);
  if (!expected || !token || token.length > 4096) return false;
  const actualBytes = Buffer.from(token);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export class NodeRegistry {
  private readonly connections = new Map<string, { socket: WebSocket; node: ConnectedNode }>();
  private readonly pending = new Set<WebSocket>();
  private readonly requests = new Map<
    string,
    {
      nodeId: string;
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  onEvent?: (nodeId: string, sessionId: string, event: Record<string, unknown>) => void;
  onDisconnect?: (nodeId: string) => void;
  onRegister?: (node: ConnectedNode) => void;
  resolveSession?: (nodeId: string, remoteSessionId: string) => string | undefined;

  request(nodeId: string, action: string, data: unknown): Promise<any> {
    if (this.requests.size >= 100)
      return Promise.reject(new ApiError(503, 'node_error', 'Too many pending node requests'));
    const connection = this.connections.get(nodeId);
    if (!connection || connection.socket.readyState !== connection.socket.OPEN)
      return Promise.reject(new ApiError(503, 'node_offline', 'Node is offline'));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(requestId);
        reject(
          new ApiError(504, 'node_timeout', 'Node response timed out; outcome may be unknown'),
        );
      }, 30_000);
      this.requests.set(requestId, { nodeId, resolve, reject, timer });
      connection.socket.send(
        JSON.stringify({ type: 'request', requestId, action, data }),
        (error) => {
          if (error) {
            clearTimeout(timer);
            this.requests.delete(requestId);
            reject(new ApiError(503, 'node_offline', 'Node connection failed'));
          }
        },
      );
    });
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
      if (Buffer.byteLength(raw.toString()) > 16_777_216)
        return socket.close(1009, 'message too large');
      let message: unknown;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return socket.close(1007, 'invalid JSON');
      }
      if (!registered) {
        const parsed = registration.safeParse(message);
        if (
          !parsed.success ||
          new Set(parsed.data.workspaces.map((w) => w.id)).size !== parsed.data.workspaces.length ||
          parsed.data.workspaces.some((w) => !/^[a-zA-Z0-9_-]{1,100}$/.test(w.id))
        )
          return socket.close(1008, 'invalid registration');
        registered = true;
        this.pending.delete(socket);
        if (this.connections.has(nodeId)) {
          this.onDisconnect?.(nodeId);
          this.connections.get(nodeId)?.socket.close(4000, 'replaced by new connection');
          this.failRequests(nodeId);
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
        socket.send(JSON.stringify({ type: 'registered', nodeId }));
      } else if (this.connections.get(nodeId)?.socket !== socket) {
        socket.close(4000, 'replaced by new connection');
      } else if (
        typeof message === 'object' &&
        message !== null &&
        'type' in message &&
        message.type === 'heartbeat'
      ) {
        lastSeenAt = Date.now();
        const current = this.connections.get(nodeId);
        if (current?.socket === socket) current.node.lastSeenAt = lastSeenAt;
        socket.send(JSON.stringify({ type: 'heartbeat_ack' }));
      } else if (
        typeof message === 'object' &&
        message !== null &&
        'type' in message &&
        message.type === 'response' &&
        'requestId' in message &&
        typeof message.requestId === 'string'
      ) {
        const pending = this.requests.get(message.requestId);
        if (
          pending &&
          pending.nodeId === nodeId &&
          this.connections.get(nodeId)?.socket === socket
        ) {
          clearTimeout(pending.timer);
          this.requests.delete(message.requestId);
          if ('error' in message && typeof message.error === 'string')
            pending.reject(new ApiError(503, 'node_error', message.error));
          else pending.resolve('data' in message ? message.data : null);
        }
      } else if (
        typeof message === 'object' &&
        message !== null &&
        'type' in message &&
        message.type === 'event' &&
        'sessionId' in message &&
        typeof message.sessionId === 'string' &&
        'event' in message &&
        typeof message.event === 'object' &&
        message.event !== null
      ) {
        const sessionId = this.resolveSession?.(nodeId, message.sessionId);
        if (sessionId) this.onEvent?.(nodeId, sessionId, message.event as Record<string, unknown>);
      } else socket.close(1008, 'unsupported message');
    });
    socket.on('close', () => {
      this.pending.delete(socket);
      clearInterval(deadline);
      if (this.connections.get(nodeId)?.socket === socket) {
        this.connections.delete(nodeId);
        this.failRequests(nodeId);
        this.onDisconnect?.(nodeId);
      }
    });
  }

  private failRequests(nodeId: string): void {
    for (const [id, pending] of this.requests) {
      if (pending.nodeId !== nodeId) continue;
      clearTimeout(pending.timer);
      this.requests.delete(id);
      pending.reject(
        new ApiError(503, 'node_offline', 'Node disconnected; outcome may be unknown'),
      );
    }
  }

  list(): ConnectedNode[] {
    return [...this.connections.values()].map(({ node }) => ({
      ...node,
      workspaces: [...node.workspaces],
    }));
  }

  close(): void {
    for (const nodeId of this.connections.keys()) this.failRequests(nodeId);
    for (const socket of this.pending) socket.close(1001, 'daemon shutting down');
    this.pending.clear();
    for (const { socket } of this.connections.values()) socket.close(1001, 'daemon shutting down');
    this.connections.clear();
  }
}
