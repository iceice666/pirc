/**
 * Chat workspaces (plans/assistant.md): the assistant's chats, grouped like
 * the chat list and projects of the ChatGPT and Claude web apps. Their
 * directories live in the node's state directory and are never picked or
 * shown by the user; each session works in its own subdirectory, so one chat
 * writing never blocks another on the write broker.
 */
import { mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { CHAT_WORKSPACE_ID, type NodeConfig } from '../config.js';
import type { GatewayDatabase } from '../database.js';
import type { Workspace } from '../types.js';

export function chatWorkspaceDir(config: NodeConfig, workspaceId: string): string {
  const dir = path.join(config.stateDir, 'chat', workspaceId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return realpathSync(dir);
}

/** The top-level chat workspace, for chats outside any project. */
export function ensureTopLevelChats(config: NodeConfig, db: GatewayDatabase): Workspace {
  return db.ensureChatWorkspace(
    CHAT_WORKSPACE_ID,
    config.nodeId,
    'Chats',
    chatWorkspaceDir(config, CHAT_WORKSPACE_ID),
  );
}

/** Where a session works: its own directory in a chat workspace, else the workspace itself. */
export function sessionRoot(workspace: Workspace, sessionId: string): string {
  if (workspace.kind !== 'chat') return workspace.canonicalPath;
  const dir = path.join(workspace.canonicalPath, 'sessions', path.basename(sessionId));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
