// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { api } from './api';
import { conversationEnvironment } from './conversation-environment';
const raw = {
  version: 1,
  sessionId: 'same-id',
  binding: {
    version: 1,
    membership: { revision: 2, legacyWorkspaceId: 'node:project' },
    execution: { generation: 7, workspaceId: 'node:project', nodeId: 'node', modeId: 'research' },
  },
  project: { revision: 3, workspaceId: 'node:project', resolution: 'member' },
  modePolicy: { revision: 4, definition: { id: 'research', projects: true } },
  workspacePolicy: {
    revision: 5,
    capabilities: {
      version: 1,
      delegation: true,
      memory_search: true,
      remote_recall: false,
      schedules: true,
      web_search: true,
      delegation_approval: 'always',
    },
  },
  enforcement: 'not_tracked',
};
afterEach(() => vi.unstubAllGlobals());
it('reads independent revisions through the actual API without issuing a command', async () => {
  const id = 'same /+id';
  const reply = { ...raw, sessionId: id };
  const fetch = vi.fn(async (_url: string) => new Response(JSON.stringify(reply), { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  expect(await api.environment(id)).toEqual(reply);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]?.[0]).toBe('/api/sessions/same%20%2F%2Bid/environment');
});
it('retains an unavailable mode and last known project without inferring enforcement', () => {
  const missing = {
    ...raw,
    project: { ...raw.project, resolution: 'mode_unavailable' },
    modePolicy: { revision: 5, definition: null },
  };
  expect(conversationEnvironment(missing, 'same-id')).toEqual(missing);
});
it.each([
  { ...raw, version: 2 },
  { ...raw, sessionId: 'another' },
  { ...raw, enforcement: 'ready' },
  { ...raw, project: { ...raw.project, revision: 0 } },
  { ...raw, project: { ...raw.project, workspaceId: 'another' } },
  { ...raw, project: { ...raw.project, resolution: 'none' } },
  { ...raw, project: { ...raw.project, resolution: 'mode_unavailable' } },
  { ...raw, modePolicy: null },
  { ...raw, modePolicy: { revision: 4, definition: { id: 'another' } } },
  { ...raw, workspacePolicy: { ...raw.workspacePolicy, revision: 9007199254740992 } },
  {
    ...raw,
    workspacePolicy: {
      revision: 1,
      capabilities: { ...raw.workspacePolicy.capabilities, web_search: 'true' },
    },
  },
  { ...raw, binding: null },
])('rejects inconsistent or unsupported state', (invalid) => {
  expect(() => conversationEnvironment(invalid, 'same-id')).toThrow();
});
it('does not hide an old server error or synthesize binding authority', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code: 'not_found', message: 'Not found' } }), {
          status: 404,
        }),
    ),
  );
  await expect(api.environment('same-id')).rejects.toThrow('Not found');
});
