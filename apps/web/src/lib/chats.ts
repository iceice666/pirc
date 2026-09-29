import type { Workspace } from './types';

/**
 * Chat workspaces hold the assistant's chats, like the chat list and projects
 * of the ChatGPT and Claude web apps. A chat node's top-level one, local id
 * `chats`, holds chats outside any project.
 */
export const isChatWorkspace = (workspace: Workspace | undefined) => workspace?.kind === 'chat';

export const isTopLevelChats = (workspace: Workspace) =>
  isChatWorkspace(workspace) && workspace.id === `${workspace.hostId}:chats`;

/** Nodes hosting top-level chats; they hold chat workspaces only, never directories. */
export const chatNodeIds = (workspaces: Workspace[]) =>
  new Set(workspaces.filter(isTopLevelChats).map((workspace) => workspace.hostId));

/** The top-level chats (the first chat node's, if several nodes host chats). */
export const topLevelChats = (workspaces: Workspace[]) => workspaces.find(isTopLevelChats);

export type NewWorkspace =
  | { nodeId: string; path: string; displayName: string }
  | { nodeId: string; kind: 'chat'; displayName: string };
