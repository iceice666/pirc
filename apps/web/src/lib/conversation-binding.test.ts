import { describe, expect, it } from 'vitest';
import { snapshotFromRaw } from './api';
import { conversationBinding } from './conversation-binding';

const binding = {
  version: 1,
  membership: { revision: 2, legacyWorkspaceId: 'node:project' },
  execution: { generation: 7, workspaceId: 'node:project', nodeId: 'node', modeId: 'research' },
};

describe('conversation binding compatibility', () => {
  it('retains independent revisions through the production snapshot adapter', () => {
    const state = snapshotFromRaw(
      {
        session: {
          id: 'same-id',
          name: 'Existing',
          workspaceId: 'node:project',
          binding,
          runnerEpoch: 50,
        },
        watermark: { epoch: 50, sequence: 4 },
      },
      {},
    );
    expect(state.session.id).toBe('same-id');
    expect(state.session.binding).toEqual(binding);
    expect(state.runnerEpoch).toBe('50');
    expect(state.session.workspaceId).toBe('node:project');
  });

  it('keeps older servers readable without inventing revisions', () => {
    const state = snapshotFromRaw(
      { session: { id: 'old', name: 'Old', workspaceId: 'node:repo' } },
      {},
    );
    expect(state.session).not.toHaveProperty('binding');
  });

  it('accepts the unresolved Node mapping without granting a different workspace', () => {
    const pending = { ...binding, execution: { ...binding.execution, nodeId: null } };
    expect(conversationBinding(pending, 'node:project')).toEqual(pending);
  });

  it.each([
    { ...binding, version: 2 },
    { ...binding, membership: { ...binding.membership, revision: 0 } },
    { ...binding, membership: { ...binding.membership, legacyWorkspaceId: 'other' } },
    { ...binding, execution: { ...binding.execution, workspaceId: 'other' } },
    { ...binding, execution: { ...binding.execution, generation: 1.5 } },
    { ...binding, execution: { ...binding.execution, generation: Number.MAX_SAFE_INTEGER + 1 } },
    { ...binding, execution: { ...binding.execution, modeId: '' } },
    { ...binding, execution: { ...binding.execution, nodeId: undefined } },
    {},
  ])('rejects an unsupported or inconsistent advertised binding', (invalid) => {
    expect(() =>
      snapshotFromRaw(
        {
          session: {
            id: 'same-id',
            name: 'Existing',
            workspaceId: 'node:project',
            binding: invalid,
          },
        },
        {},
      ),
    ).toThrow('conversation binding');
  });
});
