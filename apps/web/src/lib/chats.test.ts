import { describe, expect, it } from 'vitest';
import { chatNodeIds } from './chats';
import type { Workspace } from './types';

const workspace = (id: string, kind: Workspace['kind']): Workspace => ({
  id,
  hostId: id.split(':')[0]!,
  displayName: id,
  kind,
  defaults: {},
});

describe('chatNodeIds', () => {
  it('names the nodes hosting top-level chats, which take no directory workspaces', () => {
    expect(
      chatNodeIds([
        workspace('home:chats', 'chat'),
        workspace('home:workspace_trip', 'chat'),
        workspace('work:pirc', 'directory'),
        // A directory that happens to be called "chats" does not make a chat node.
        workspace('lab:chats', 'directory'),
      ]),
    ).toEqual(new Set(['home']));
  });
});
