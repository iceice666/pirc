/**
 * `pirc node`: owns agent processes, terminals, session files, metadata and
 * the event buffer locally, and serves them to the daemon over one outbound
 * WebSocket. Daemon requests are replayed on the local router with
 * `app.inject`; terminal streams are multiplexed on the same connection.
 */
import { WebSocket } from 'ws';
import { z } from 'zod';
import type { NodeConfig } from '../config.js';
import { ApiError } from '../errors.js';
import {
  NODE_FRAME_MAX_BYTES,
  NODE_PROTOCOL_VERSION,
  NODE_USER_HEADER,
  PROTOCOL_MISMATCH_CLOSE,
  type NodeHttpResponse,
  type NodeToDaemon,
} from '../protocol.js';
import { buildNodeApp } from './app.js';
import type { TerminalConnection } from './panel-routes.js';

const RECONNECT_MS = 3_000;
const HEARTBEAT_MS = 15_000;

const daemonMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('registered'), nodeId: z.string() }),
  z.object({ type: z.literal('heartbeat_ack') }),
  z.object({
    type: z.literal('request'),
    requestId: z.string().min(1).max(100),
    data: z.object({
      method: z.enum(['GET', 'POST', 'PATCH']),
      url: z.string().startsWith('/api/').max(8192),
      user: z.string().min(1),
      payload: z.unknown().optional(),
      bodyBase64: z.string().optional(),
      contentType: z.string().max(200).optional(),
    }),
  }),
  z.object({
    type: z.literal('terminal_open'),
    streamId: z.string().min(1).max(100),
    user: z.string().min(1),
    sessionId: z.string().min(1),
    terminalId: z.string().min(1),
  }),
  z.object({ type: z.literal('terminal_input'), streamId: z.string(), message: z.unknown() }),
  z.object({ type: z.literal('terminal_close'), streamId: z.string() }),
]);

export async function startNode(config: NodeConfig): Promise<{ close: () => Promise<void> }> {
  const { app, services } = await buildNodeApp(config);
  const registeredWorkspaces = () =>
    services.db
      .listWorkspaces()
      .filter((workspace) => workspace.hostId === config.nodeId)
      .map(({ id, displayName }) => ({ id, displayName }));
  let stopped = false;
  let socket: WebSocket | undefined;
  let registered = false;
  let retry: NodeJS.Timeout | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  const terminals = new Map<string, TerminalConnection>();

  const send = (message: NodeToDaemon) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };
  const closeTerminals = () => {
    for (const connection of terminals.values()) connection.detach();
    terminals.clear();
  };
  const unsubscribeEvents = services.events.subscribeAll((event) => {
    if (registered) send({ type: 'event', sessionId: event.sessionId, event: { ...event } });
  });

  async function handleRequest(
    data: z.infer<typeof daemonMessage> & { type: 'request' },
  ): Promise<NodeHttpResponse> {
    const { method, url, user, payload, bodyBase64, contentType } = data.data;
    const response = await app.inject({
      method,
      url,
      headers: {
        [NODE_USER_HEADER]: user,
        ...(bodyBase64 !== undefined
          ? { 'content-type': contentType ?? 'application/octet-stream' }
          : {}),
      },
      ...(bodyBase64 !== undefined
        ? { payload: Buffer.from(bodyBase64, 'base64') }
        : payload !== undefined
          ? { payload: payload as Record<string, unknown> }
          : {}),
    });
    let body: unknown = null;
    if (response.body) {
      try {
        body = response.json();
      } catch {
        body = { error: { code: 'node_error', message: 'Node returned a non-JSON response' } };
      }
    }
    return { status: response.statusCode, body };
  }

  function openTerminal(message: z.infer<typeof daemonMessage> & { type: 'terminal_open' }) {
    const { streamId } = message;
    if (terminals.has(streamId)) return;
    try {
      const connection = services.terminalStreams.open(
        message,
        (frame) => send({ type: 'terminal_frame', streamId, frame }),
        // The shell exited: end the relayed stream (PTY events are async, so
        // this never runs before the connection is registered below).
        (code, reason) => {
          const current = terminals.get(streamId);
          if (!current) return;
          terminals.delete(streamId);
          current.detach();
          send({ type: 'terminal_closed', streamId, code, reason });
        },
      );
      terminals.set(streamId, connection);
    } catch (error) {
      const status = error instanceof ApiError ? error.statusCode : 500;
      send({
        type: 'terminal_closed',
        streamId,
        code: status === 401 ? 4401 : status === 403 ? 4403 : status === 404 ? 4404 : 4400,
        reason: error instanceof Error ? error.message.slice(0, 120) : 'invalid request',
      });
    }
  }

  function connect() {
    if (stopped) return;
    const url = new URL('/node/connect', config.daemonUrl);
    if (url.username || url.password || url.search || url.hash)
      throw new Error('Invalid daemon URL');
    const connection = new WebSocket(url, {
      headers: { 'x-pirc-node-id': config.nodeId, authorization: `Bearer ${config.nodeToken}` },
      maxPayload: NODE_FRAME_MAX_BYTES,
    });
    socket = connection;
    registered = false;
    connection.on('open', () => {
      send({
        type: 'register',
        protocol: NODE_PROTOCOL_VERSION,
        workspaces: registeredWorkspaces(),
      });
      heartbeat = setInterval(() => send({ type: 'heartbeat' }), HEARTBEAT_MS);
    });
    connection.on('message', (raw) => {
      if (connection !== socket) return;
      let parsed: ReturnType<typeof daemonMessage.safeParse>;
      try {
        parsed = daemonMessage.safeParse(JSON.parse(raw.toString()));
      } catch {
        connection.close(1007, 'invalid JSON');
        return;
      }
      if (!parsed.success) return;
      const message = parsed.data;
      if (message.type === 'registered') {
        registered = true;
        app.log.info({ daemon: config.daemonUrl }, 'registered with daemon');
        return;
      }
      if (!registered) return;
      switch (message.type) {
        case 'request':
          void handleRequest(message)
            .catch((error: unknown) => {
              app.log.error({ error }, 'node request failed');
              return {
                status: 500,
                body: { error: { code: 'internal_error', message: 'Node request failed' } },
              };
            })
            .then((data) => send({ type: 'response', requestId: message.requestId, data }));
          return;
        case 'terminal_open':
          openTerminal(message);
          return;
        case 'terminal_input':
          terminals.get(message.streamId)?.input(message.message);
          return;
        case 'terminal_close':
          terminals.get(message.streamId)?.detach();
          terminals.delete(message.streamId);
          return;
      }
    });
    connection.on('error', (error) => app.log.warn({ error }, 'node transport failure'));
    connection.on('close', (code, reason) => {
      if (socket !== connection) return;
      registered = false;
      closeTerminals();
      if (heartbeat) clearInterval(heartbeat);
      if (code === PROTOCOL_MISMATCH_CLOSE)
        app.log.error(
          { reason: reason.toString() },
          'daemon rejected this node protocol version; upgrade the daemon and node together',
        );
      if (!stopped) retry = setTimeout(connect, RECONNECT_MS);
    });
  }
  connect();
  return {
    close: async () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      if (heartbeat) clearInterval(heartbeat);
      unsubscribeEvents();
      closeTerminals();
      socket?.terminate();
      await app.close();
    },
  };
}
