import { describe, expect, it } from 'vitest';
import { demoModes } from './mock';
import {
  creatableModes,
  LEGACY_CHAT,
  LEGACY_DIRECTORY,
  modeOf,
  tabOf,
  UNAVAILABLE,
  workNodes,
} from './modes';
import type { NodeSummary, Workspace } from './types';

const workspace = (extra: Partial<Workspace>): Workspace => ({
  id: 'node:ws',
  hostId: 'node',
  displayName: 'Workspace',
  defaults: {},
  ...extra,
});
const node = (id: string, modes?: string[]): NodeSummary => ({
  id,
  connectedAt: 0,
  lastSeenAt: 0,
  workspaces: [],
  modes,
});

describe('modeOf and tabOf', () => {
  it("places a workspace by its mode's assistant access, not the legacy kind", () => {
    // The gateway derives `kind: chat` from scratch's per-session workdir.
    const scratch = workspace({ kind: 'chat', mode: 'scratch' });
    expect(modeOf(scratch, demoModes).id).toBe('scratch');
    expect(tabOf(scratch, demoModes)).toBe('work');
    expect(tabOf(workspace({ kind: 'chat', mode: 'chat' }), demoModes)).toBe('chat');
    expect(tabOf(workspace({ kind: 'directory', mode: 'directory' }), demoModes)).toBe('work');
  });

  it('falls back to the legacy kind without a catalog entry', () => {
    expect(modeOf(workspace({ kind: 'chat', mode: 'scratch' }), [])).toBe(LEGACY_CHAT);
    expect(tabOf(workspace({ kind: 'chat' }), [])).toBe('chat');
    expect(modeOf(workspace({}), [])).toBe(LEGACY_DIRECTORY);
    expect(tabOf(workspace({ kind: 'directory' }), [])).toBe('work');
    expect(modeOf(undefined, demoModes)).toBeUndefined();
  });

  it('keeps a workspace whose mode left the catalog under Work, with nothing on', () => {
    const gone = workspace({ kind: 'chat', mode: 'research', available: false });
    expect(modeOf(gone, demoModes)).toBe(UNAVAILABLE);
    expect(tabOf(gone, demoModes)).toBe('work');
    expect(tabOf(gone, [])).toBe('work');
  });
});

describe('creatableModes and workNodes', () => {
  it("offers a node's accepted Work modes the catalog knows", () => {
    expect(
      creatableModes(node('gpu', ['chat', 'scratch', 'directory', 'unknown']), demoModes).map(
        (mode) => mode.id,
      ),
    ).toEqual(['directory', 'scratch']);
    expect(creatableModes(node('old'), demoModes)).toEqual([]);
    expect(creatableModes(node('gpu', ['scratch']), [])).toEqual([]);
  });

  it('hosts Work on nodes accepting a non-assistant mode, else on non-chat nodes', () => {
    const nodes = [node('home', ['chat']), node('gpu', ['scratch']), node('legacy')];
    expect(workNodes(nodes, demoModes, new Set()).map((item) => item.id)).toEqual([
      'gpu',
      'legacy',
    ]);
    // An older gateway: every node but the chat nodes.
    expect(
      workNodes([node('home'), node('work')], [], new Set(['home'])).map((item) => item.id),
    ).toEqual(['work']);
  });
});
