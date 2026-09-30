/**
 * Chat workspaces (plans/assistant.md): the assistant's chats, grouped like
 * the chat list and projects of the ChatGPT and Claude web apps. Their
 * directories live in the node's state directory and are never picked or
 * shown by the user; each session works in its own subdirectory, so one chat
 * writing never blocks another on the write broker.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CHAT_WORKSPACE_ID, type NodeConfig } from '../config.js';
import type { GatewayDatabase } from '../database.js';
import { ApiError } from '../errors.js';
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

/**
 * Per-project instructions (plans/assistant.md §5): text the user writes for
 * every chat of a project, edited from the web only. It lives on the node,
 * next to the project's sessions but outside every session's directory, so
 * the agent's file tools cannot reach it (it is also protected, see
 * `PIRC_PROJECT_INSTRUCTIONS`). The runner reads it and hands it to the
 * agent, which freezes it in the session when the chat starts.
 */
export const INSTRUCTIONS_FILE = 'instructions.md';
export const INSTRUCTIONS_MAX_CHARS = 8000;

export function projectInstructionsPath(workspace: Workspace): string | undefined {
  return workspace.kind === 'chat'
    ? path.join(workspace.canonicalPath, INSTRUCTIONS_FILE)
    : undefined;
}

/** The project's instructions, or '' when there are none (or this is not a chat). */
export function readProjectInstructions(workspace: Workspace): string {
  const file = projectInstructionsPath(workspace);
  if (!file) return '';
  try {
    return readFileSync(file, 'utf8').trim().slice(0, INSTRUCTIONS_MAX_CHARS);
  } catch {
    return '';
  }
}

/** Replace the project's instructions; empty text removes them. */
export function writeProjectInstructions(workspace: Workspace, text: string): string {
  const file = projectInstructionsPath(workspace);
  if (!file) throw new ApiError(400, 'invalid_input', 'Only chat projects have instructions');
  const value = text.replace(/\r\n/g, '\n').trim();
  if (value.length > INSTRUCTIONS_MAX_CHARS)
    throw new ApiError(
      413,
      'payload_too_large',
      `Instructions are limited to ${INSTRUCTIONS_MAX_CHARS} characters`,
    );
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (!value) {
    rmSync(file, { force: true });
    return '';
  }
  const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(temp, `${value}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(temp, file);
  return value;
}
