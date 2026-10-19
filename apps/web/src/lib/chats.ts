import { isAssistant, modeOf, type Catalog } from './modes';
import type { Workspace } from './types';

/**
 * Assistant workspaces (`assistant: full`) hold the assistant's chats, like the
 * chat list and projects of the ChatGPT and Claude web apps. A chat node's
 * top-level one, local id `chats`, holds chats outside any project.
 */
export const isTopLevelChats = (workspace: Workspace, catalog: Catalog) =>
  isAssistant(modeOf(workspace, catalog)) && workspace.id === `${workspace.hostId}:chats`;

/** Nodes hosting top-level chats. */
export const chatNodeIds = (workspaces: Workspace[], catalog: Catalog) =>
  new Set(
    workspaces
      .filter((workspace) => isTopLevelChats(workspace, catalog))
      .map((workspace) => workspace.hostId),
  );

/** The top-level chats (the first chat node's, if several nodes host chats). */
export const topLevelChats = (workspaces: Workspace[], catalog: Catalog) =>
  workspaces.find((workspace) => isTopLevelChats(workspace, catalog));

export type NewWorkspace =
  /** A workspace in a catalog mode; `path` iff the mode's workdir is `workspace`. */
  | { nodeId: string; mode: string; displayName: string; path?: string }
  /** Older gateways: an existing directory. */
  | { nodeId: string; path: string; displayName: string }
  /** A chat project. */
  | { nodeId: string; kind: 'chat'; displayName: string };
