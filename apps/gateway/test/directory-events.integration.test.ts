import { afterEach, expect, it } from 'bun:test';
import WebSocket from 'ws';
import { headers, startCluster, waitFor, type Cluster } from './helpers.js';

const clusters: Cluster[] = [];
afterEach(async () => {
  await Promise.all(clusters.splice(0).map((cluster) => cluster.close()));
});

async function openEvents(url: string, query: string) {
  const socket = new WebSocket(`${url}/api/events?${query}`, { headers });
  const received: any[] = [];
  socket.on('message', (raw) => received.push(JSON.parse(raw.toString())));
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  return { socket, received };
}

it('tells opted-in event sockets when the node list changes', async () => {
  const cluster = await startCluster([{ nodeId: 'alpha' }, { nodeId: 'beta' }]);
  clusters.push(cluster);
  const { app, services, url } = cluster;
  await waitFor(() => services.db.listWorkspaces().some((w) => w.id === 'alpha:test'), true);
  const created = await app.inject({
    method: 'POST',
    url: '/api/sessions',
    headers,
    payload: { workspaceId: 'alpha:test' },
  });
  expect(created.statusCode).toBe(201);
  const sessionId = encodeURIComponent(created.json().session.id);
  const optedIn = await openEvents(url, `sessionId=${sessionId}&directory=1`);
  const plain = await openEvents(url, `sessionId=${sessionId}`);
  const directoryEvents = (socket: { received: any[] }) =>
    socket.received.filter((event) => event.type === 'directory_changed').length;

  // Another node going away changes the list; the session's own node is unaffected.
  await cluster.nodes[1]!.close();
  await waitFor(() => services.nodes.list().length, 1);
  await waitFor(() => directoryEvents(optedIn), 1);
  const [event] = optedIn.received.filter((item) => item.type === 'directory_changed');
  // Outside the session's sequence: no cursor fields a client could adopt.
  expect(event).toEqual({ type: 'directory_changed' });
  expect(directoryEvents(plain)).toBe(0);

  optedIn.socket.close();
  plain.socket.close();
});
