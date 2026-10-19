import type { ModeInfo, NodeSummary, Workspace } from './types';

/**
 * Workspace modes: the gateway's catalog says what a workspace can do. The UI
 * asks these capabilities (`modeOf(workspace).repository`, …), never mode ids;
 * the legacy `kind` is read only when the catalog lacks the workspace's mode
 * (an older gateway).
 */
export type Catalog = readonly ModeInfo[];

/** The two sidebar tabs: the assistant's chats, and your own work. */
export type Tab = 'chat' | 'work';

const nothing = {
  description: '',
  features_off: [],
  features_on: [],
  tools: null,
  delegate: false,
  delegate_target: false,
  schedule_scope: 'own',
  project_instructions: false,
  project_files: false,
  project_config: false,
  workspace_memory: false,
  repository: false,
  recap: false,
  delete_sessions: false,
  projects: false,
} satisfies Partial<ModeInfo>;

/** An older gateway's `kind: chat` workspace: the default chat mode. */
export const LEGACY_CHAT: ModeInfo = {
  ...nothing,
  id: 'chat',
  label: 'Chat',
  ui: { noun: 'chat' },
  workdir: 'per-session',
  assistant: 'full',
  delegate: true,
  schedule_scope: 'any',
  project_instructions: true,
  project_files: true,
  delete_sessions: true,
  projects: true,
};

/** An older gateway's directory workspace: the default directory mode. */
export const LEGACY_DIRECTORY: ModeInfo = {
  ...nothing,
  id: 'directory',
  label: 'Work',
  ui: { noun: 'session' },
  workdir: 'workspace',
  assistant: 'user',
  delegate_target: true,
  project_config: true,
  workspace_memory: true,
  repository: true,
  recap: true,
};

/**
 * A workspace whose mode is missing from the catalog: its history stays
 * readable under Work, but it offers nothing else and takes no new sessions.
 */
export const UNAVAILABLE: ModeInfo = {
  ...nothing,
  id: '',
  label: 'Unavailable',
  ui: { noun: 'session' },
  workdir: 'per-session',
  assistant: 'user',
};

/** The workspace's mode, or what its legacy `kind` implies without a catalog entry. */
export function modeOf(workspace: Workspace, catalog: Catalog): ModeInfo;
export function modeOf(workspace: Workspace | undefined, catalog: Catalog): ModeInfo | undefined;
export function modeOf(workspace: Workspace | undefined, catalog: Catalog) {
  if (!workspace) return undefined;
  if (workspace.available === false) return UNAVAILABLE;
  const found = workspace.mode ? catalog.find((mode) => mode.id === workspace.mode) : undefined;
  if (found) return found;
  return workspace.kind === 'chat' ? LEGACY_CHAT : LEGACY_DIRECTORY;
}

/** The personal assistant's modes (chats and projects): no Work chrome. */
export const isAssistant = (mode: ModeInfo | undefined) => mode?.assistant === 'full';

/** A workspace is in the Chat tab iff its mode is the assistant's. */
export const tabOf = (workspace: Workspace | undefined, catalog: Catalog): Tab =>
  isAssistant(modeOf(workspace, catalog)) ? 'chat' : 'work';

/** Mode missing from the catalog: read-only, no new sessions. */
export const isReadOnly = (workspace: Workspace | undefined) => workspace?.available === false;

/** "chat" → "Chat". */
export const capitalized = (noun: string) => noun.charAt(0).toUpperCase() + noun.slice(1);

/**
 * The modes a new Work workspace on `node` can have: the node's accepted
 * modes the catalog knows, without the assistant's (chat projects have their
 * own dialog). Empty with an older gateway: then a path makes a directory.
 */
export function creatableModes(node: NodeSummary | undefined, catalog: Catalog): ModeInfo[] {
  const accepted = node?.modes;
  if (!accepted || !catalog.length) return [];
  return catalog.filter((mode) => accepted.includes(mode.id) && !isAssistant(mode));
}

/**
 * Nodes that can host Work workspaces: those accepting a non-assistant mode.
 * Without node modes (an older gateway), every node but the chat nodes
 * (`chatNodes`, those hosting top-level chats).
 */
export function workNodes(nodes: NodeSummary[], catalog: Catalog, chatNodes: Set<string>) {
  return nodes.filter((node) =>
    node.modes && catalog.length
      ? creatableModes(node, catalog).length > 0
      : !chatNodes.has(node.id),
  );
}
