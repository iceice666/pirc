/**
 * Node side of the agent → gateway channel: runners hand over their agent's
 * `gateway_request` here, and the answer comes back from the daemon as an
 * `agent_response` on the node link. Every request gets exactly one answer:
 * the daemon's, `gateway_offline` while the link is down (or when it drops
 * mid-request), or `gateway_timeout`.
 */
import { randomUUID } from 'node:crypto';
import {
  AGENT_REQUEST_TIMEOUT_MS,
  agentError,
  type AgentAnswer,
  type NodeToDaemon,
} from '../protocol.js';

export interface AgentGateway {
  /** Ask the daemon on behalf of `sessionId`, a session of this node. Never rejects. */
  request(sessionId: string, op: string, args: unknown): Promise<AgentAnswer>;
}

const offline = (message = 'This node is not connected to the gateway') =>
  agentError(503, 'gateway_offline', message);

/** For a node router without a daemon link (tests, or before one exists). */
export const offlineGateway: AgentGateway = { request: async () => offline() };

const MAX_PENDING = 64;

export class DaemonAgentGateway implements AgentGateway {
  private send: ((message: NodeToDaemon) => boolean) | undefined;
  private readonly pending = new Map<
    string,
    { resolve: (answer: AgentAnswer) => void; timer: NodeJS.Timeout }
  >();

  constructor(
    private readonly timeoutMs = AGENT_REQUEST_TIMEOUT_MS,
    private readonly maxPending = MAX_PENDING,
  ) {}

  /** The link is registered: `send` returns false when a frame could not be sent. */
  connect(send: (message: NodeToDaemon) => boolean): void {
    this.send = send;
  }

  /** The link is gone: requests still waiting will never hear back. */
  disconnect(): void {
    this.send = undefined;
    for (const { resolve, timer } of this.pending.values()) {
      clearTimeout(timer);
      resolve(offline('The gateway connection dropped; the outcome is unknown'));
    }
    this.pending.clear();
  }

  receive(message: { requestId: string; status: number; body?: unknown }): void {
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.requestId);
    pending.resolve({ status: message.status, body: message.body ?? null });
  }

  request(sessionId: string, op: string, args: unknown): Promise<AgentAnswer> {
    const send = this.send;
    if (!send) return Promise.resolve(offline());
    if (this.pending.size >= this.maxPending)
      return Promise.resolve(
        agentError(
          429,
          'too_many_requests',
          'Too many gateway requests are in flight on this node',
        ),
      );
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve(
          agentError(
            504,
            'gateway_timeout',
            'The gateway did not answer in time; the outcome is unknown',
          ),
        );
      }, this.timeoutMs);
      this.pending.set(requestId, { resolve, timer });
      if (!send({ type: 'agent_request', requestId, sessionId, op, args })) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        resolve(offline());
      }
    });
  }
}
