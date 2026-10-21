import type { ModeInfo, NodeSummary, Workspace } from './types';

/**
 * Workspace modes: the gateway's catalog says what a workspace can do. The UI
 * asks these capabilities (`modeOf(workspace).repository`, …), never mode ids.
 */
export type Catalog = readonly ModeInfo[];

const nothing = {
  description: '',
  features_off: [],
  features_on: [],
  tools: null,
  delegate_target: false,
  project_config: false,
  workspace_memory: false,
  repository: false,
  recap: false,
} satisfies Partial<ModeInfo>;

/** An older gateway's directory workspace: the default directory mode. */
export const LEGACY_DIRECTORY: ModeInfo = {
  ...nothing,
  id: 'directory',
  label: 'Work',
  ui: { noun: 'session' },
  workdir: 'workspace',
  delegate_target: true,
  project_config: true,
  workspace_memory: true,
  repository: true,
  recap: true,
};

/**
 * A workspace whose mode is missing from the catalog: its history stays
 * readable, but it offers nothing else and takes no new sessions.
 */
export const UNAVAILABLE: ModeInfo = {
  ...nothing,
  id: '',
  label: 'Unavailable',
  ui: { noun: 'session' },
  workdir: 'per-session',
};

/** The workspace's mode, or the default directory mode without a catalog entry. */
export function modeOf(workspace: Workspace, catalog: Catalog): ModeInfo;
export function modeOf(workspace: Workspace | undefined, catalog: Catalog): ModeInfo | undefined;
export function modeOf(workspace: Workspace | undefined, catalog: Catalog) {
  if (!workspace) return undefined;
  if (workspace.available === false) return UNAVAILABLE;
  const found = workspace.mode ? catalog.find((mode) => mode.id === workspace.mode) : undefined;
  return found ?? LEGACY_DIRECTORY;
}

/** Mode missing from the catalog: read-only, no new sessions. */
export const isReadOnly = (workspace: Workspace | undefined) => workspace?.available === false;

/** "session" → "Session". */
export const capitalized = (noun: string) => noun.charAt(0).toUpperCase() + noun.slice(1);

/**
 * The modes a new workspace on `node` can have: the node's accepted modes the
 * catalog knows. Empty with an older gateway: then a path makes a directory.
 */
export function creatableModes(node: NodeSummary | undefined, catalog: Catalog): ModeInfo[] {
  const accepted = node?.modes;
  if (!accepted || !catalog.length) return [];
  return catalog.filter((mode) => accepted.includes(mode.id));
}

/** A node's machine in a few words: "linux x86_64 · 2× nvidia · 1 of 4 running". */
export function describeNode(node: NodeSummary): string {
  const caps = node.capabilities;
  if (!caps) return '';
  const parts = [`${caps.os} ${caps.arch}`];
  const gpus = caps.gpus.map((gpu) => `${gpu.count}× ${gpu.vendor}`).join(', ');
  if (gpus) parts.push(caps.sandbox.gpu ? gpus : `${gpus} (not in the sandbox)`);
  if (caps.sandbox.status !== 'active') parts.push('no sandbox: no agents');
  if (node.load) parts.push(`${node.load.running} of ${node.load.max ?? caps.maxRunning} running`);
  return parts.join(' · ');
}

/**
 * Nodes that can host workspaces: those accepting a mode the catalog knows.
 * Without node modes (an older gateway), every node.
 */
export function workNodes(nodes: NodeSummary[], catalog: Catalog) {
  return nodes.filter((node) =>
    node.modes && catalog.length ? creatableModes(node, catalog).length > 0 : true,
  );
}
