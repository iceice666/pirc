import { WebSocket } from 'ws';
import { buildApp } from './app.js';
import type { GatewayConfig } from './config.js';

/** The node owns its Pi processes, session files, metadata and event buffer locally. */
export async function startNodeAgent(
  config: GatewayConfig,
  nodeId: string,
  token: string,
  daemonUrl: string,
): Promise<{ close: () => Promise<void> }> {
  const { app, services } = await buildApp({ ...config, nodeAuthSecret: token });
  const registeredWorkspaces = () =>
    services.db
      .listWorkspaces()
      .filter((workspace) => workspace.hostId === nodeId)
      .map(({ id, displayName }) => ({ id, displayName }));
  let stopped = false;
  let socket: WebSocket | undefined;
  let retry: NodeJS.Timeout | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  const subscriptions = new Map<string, () => void>();
  const registeredConnections = new WeakSet<WebSocket>();
  const requestResults = new Map<string, { result: unknown; error?: string }>();
  const inflightCreates = new Set<string>();
  const allowedSessions = new Map<string, string>();
  for (const session of services.db.listSessions()) {
    if (session.ownerUser) allowedSessions.set(session.id, session.ownerUser);
  }
  const send = (message: unknown) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };
  function connect() {
    if (stopped) return;
    const url = new URL('/node/connect', daemonUrl);
    if (url.username || url.password || url.search || url.hash)
      throw new Error('Invalid daemon URL');
    const connection = new WebSocket(url, {
      headers: { 'x-pirc-node-id': nodeId, authorization: `Bearer ${token}` },
      maxPayload: 16_777_216,
    });
    socket = connection;
    connection.on('open', () => {
      connection.send(
        JSON.stringify({
          type: 'register',
          workspaces: registeredWorkspaces(),
        }),
      );
      heartbeat = setInterval(() => send({ type: 'heartbeat' }), 15_000);
    });
    connection.on('message', (raw) => {
      let message: any;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        connection.close(1007);
        return;
      }
      if (message.type === 'registered') {
        registeredConnections.add(connection);
        for (const session of services.db.listSessions()) subscribe(session.id);
        return;
      }
      if (!registeredConnections.has(connection) || connection !== socket) return;
      if (message.type !== 'request' || typeof message.requestId !== 'string') return;
      if (inflightCreates.has(message.requestId)) return;
      if (requestResults.has(message.requestId)) {
        const cached = requestResults.get(message.requestId)!;
        send({
          type: 'response',
          requestId: message.requestId,
          ...(cached.error ? { error: cached.error } : { data: cached.result }),
        });
        return;
      }
      void (async () => {
        try {
          const routes: Record<string, { method: string; path: RegExp }> = {
            workspaceCreate: { method: 'POST', path: /^\/api\/workspaces$/ },
            create: { method: 'POST', path: /^\/api\/sessions$/ },
            snapshot: { method: 'GET', path: /^\/api\/sessions\/[^/?]+\/snapshot$/ },
            command: { method: 'POST', path: /^\/api\/sessions\/[^/?]+\/commands$/ },
            lease: { method: 'POST', path: /^\/api\/sessions\/[^/?]+\/control\/acquire$/ },
            leaseHeartbeat: {
              method: 'POST',
              path: /^\/api\/sessions\/[^/?]+\/control\/heartbeat$/,
            },
            leaseRelease: { method: 'POST', path: /^\/api\/sessions\/[^/?]+\/control\/release$/ },
            rename: { method: 'PATCH', path: /^\/api\/sessions\/[^/?]+$/ },
            answer: {
              method: 'POST',
              path: /^\/api\/sessions\/[^/?]+\/interactions\/[^/?]+\/answer$/,
            },
            models: { method: 'GET', path: /^\/api\/models\?sessionId=[^&]+$/ },
          };
          const route = routes[message.action];
          if (
            !route ||
            message.data?.method !== route.method ||
            typeof message.data?.url !== 'string' ||
            !route.path.test(message.data.url) ||
            typeof message.data.user !== 'string' ||
            !config.allowedUsers.has(message.data.user)
          )
            throw new Error('Invalid node request');
          if (message.action !== 'create' && message.action !== 'workspaceCreate') {
            const sessionId =
              message.action === 'models'
                ? new URL(message.data.url, 'http://node.internal').searchParams.get('sessionId')
                : message.data.url.split('/')[3];
            if (
              !sessionId ||
              allowedSessions.get(decodeURIComponent(sessionId)) !== message.data.user
            )
              throw new Error('Remote session is not owned by this user');
          }
          if (message.action === 'create' || message.action === 'workspaceCreate')
            inflightCreates.add(message.requestId);
          const response = await app.inject({
            method: message.data.method,
            url: message.data.url,
            headers: {
              host: [...config.allowedHosts][0]!,
              origin: [...config.allowedOrigins][0]!,
              authorization: `Bearer ${token}`,
              [config.identityHeader]: message.data.user,
            },
            payload: message.data.payload,
          });
          const body = response.statusCode === 204 ? {} : response.json();
          if (response.statusCode >= 400)
            throw new Error(body.error?.message ?? `Node request failed (${response.statusCode})`);
          if (message.action === 'create' && body.session?.id) {
            allowedSessions.set(body.session.id, message.data.user);
            subscribe(body.session.id);
          }
          if (message.action === 'create' || message.action === 'workspaceCreate')
            requestResults.set(message.requestId, { result: body });
          send({ type: 'response', requestId: message.requestId, data: body });
        } catch (error) {
          if (message.action === 'create' || message.action === 'workspaceCreate')
            requestResults.set(message.requestId, {
              result: null,
              error: (error as Error).message,
            });
          send({ type: 'response', requestId: message.requestId, error: (error as Error).message });
        } finally {
          inflightCreates.delete(message.requestId);
        }
      })();
    });
    connection.on('error', (error) => app.log.warn({ error }, 'node transport failure'));
    connection.on('close', () => {
      if (socket !== connection) return;
      if (heartbeat) clearInterval(heartbeat);
      if (!stopped) retry = setTimeout(connect, 3_000);
    });
  }
  function subscribe(sessionId: string) {
    if (subscriptions.has(sessionId)) return;
    subscriptions.set(
      sessionId,
      services.events.subscribe(sessionId, (event) => send({ type: 'event', sessionId, event })),
    );
  }
  connect();
  return {
    close: async () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      if (heartbeat) clearInterval(heartbeat);
      for (const unsubscribe of subscriptions.values()) unsubscribe();
      socket?.terminate();
      await app.close();
    },
  };
}
