import { describe, expect, it } from 'vitest';
import { demoModes } from './mock';
import { creatableModes, LEGACY_DIRECTORY, modeOf, UNAVAILABLE, workNodes } from './modes';
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

describe('modeOf', () => {
  it("reads a workspace's mode from the catalog", () => {
    expect(modeOf(workspace({ mode: 'scratch' }), demoModes).id).toBe('scratch');
    expect(modeOf(workspace({ mode: 'directory' }), demoModes).id).toBe('directory');
  });

  it('falls back to the default directory mode without a catalog entry', () => {
    expect(modeOf(workspace({ mode: 'scratch' }), [])).toBe(LEGACY_DIRECTORY);
    expect(modeOf(workspace({}), [])).toBe(LEGACY_DIRECTORY);
    expect(modeOf(undefined, demoModes)).toBeUndefined();
  });

  it('turns everything off for a workspace whose mode left the catalog', () => {
    const gone = workspace({ mode: 'research', available: false });
    expect(modeOf(gone, demoModes)).toBe(UNAVAILABLE);
    expect(modeOf(gone, [])).toBe(UNAVAILABLE);
  });
});

describe('creatableModes and workNodes', () => {
  it("offers a node's accepted modes the catalog knows", () => {
    expect(
      creatableModes(node('gpu', ['scratch', 'directory', 'unknown']), demoModes).map(
        (mode) => mode.id,
      ),
    ).toEqual(['directory', 'scratch']);
    expect(creatableModes(node('old'), demoModes)).toEqual([]);
    expect(creatableModes(node('gpu', ['scratch']), [])).toEqual([]);
  });

  it('hosts workspaces on nodes accepting a known mode, else on every node', () => {
    const nodes = [node('home', ['unknown']), node('gpu', ['scratch']), node('legacy')];
    expect(workNodes(nodes, demoModes).map((item) => item.id)).toEqual(['gpu', 'legacy']);
    // An older gateway: every node.
    expect(workNodes([node('home'), node('work')], []).map((item) => item.id)).toEqual([
      'home',
      'work',
    ]);
  });
});
