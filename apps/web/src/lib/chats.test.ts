import { describe, expect, it } from 'vitest';
import { chatNodeIds, topLevelChats } from './chats';
import { demoModes } from './mock';
import type { Workspace } from './types';

const workspace = (id: string, kind: Workspace['kind'], mode?: string): Workspace => ({
  id,
  hostId: id.split(':')[0]!,
  displayName: id,
  kind,
  mode,
  defaults: {},
});

describe('chatNodeIds', () => {
  it('names the nodes hosting top-level chats, which take no directory workspaces', () => {
    expect(
      chatNodeIds(
        [
          workspace('home:chats', 'chat'),
          workspace('home:workspace_trip', 'chat'),
          workspace('work:pirc', 'directory'),
          // A directory that happens to be called "chats" does not make a chat node.
          workspace('lab:chats', 'directory'),
        ],
        [],
      ),
    ).toEqual(new Set(['home']));
  });

  it("asks the mode, not the legacy kind: a per-session scratch workspace is not the assistant's", () => {
    const workspaces = [workspace('lab:chats', 'chat', 'scratch')];
    expect(chatNodeIds(workspaces, demoModes)).toEqual(new Set());
    expect(topLevelChats(workspaces, demoModes)).toBeUndefined();
    // Without the catalog (an older gateway) the kind decides.
    expect(topLevelChats(workspaces, [])?.id).toBe('lab:chats');
  });
});
