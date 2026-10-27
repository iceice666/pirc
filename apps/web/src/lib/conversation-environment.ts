import { conversationBinding } from './conversation-binding';
import type { ConversationBinding } from './types';

/** Configuration snapshots, never an acknowledgement of active sandbox grants. */
export interface ConversationEnvironment {
  version: 1;
  sessionId: string;
  binding: ConversationBinding;
  project: {
    revision: number;
    workspaceId: string | null;
    resolution: 'unresolved' | 'none' | 'member' | 'mode_unavailable';
  };
  modePolicy: { revision: number; definition: Record<string, unknown> | null } | null;
  workspacePolicy: { revision: number; capabilities: Record<string, unknown> };
  enforcement: 'not_tracked';
}

export function conversationEnvironment(raw: any, sessionId: string): ConversationEnvironment {
  const revision = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
  const object = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v);
  const text = (v: unknown) => typeof v === 'string' && v.length > 0;
  const project = raw?.project;
  const mode = raw?.modePolicy;
  const capabilities = raw?.workspacePolicy?.capabilities;
  if (
    raw?.version !== 1 ||
    !text(sessionId) ||
    raw.sessionId !== sessionId ||
    raw.enforcement !== 'not_tracked' ||
    !revision(project?.revision) ||
    !['unresolved', 'none', 'member', 'mode_unavailable'].includes(project?.resolution) ||
    !(project.workspaceId === null || text(project.workspaceId)) ||
    (project.resolution === 'none' && project.workspaceId !== null) ||
    (project.resolution === 'member' && !text(project.workspaceId)) ||
    !(
      mode === null ||
      (revision(mode?.revision) && (mode.definition === null || object(mode.definition)))
    ) ||
    !revision(raw?.workspacePolicy?.revision) ||
    !object(capabilities) ||
    capabilities.version !== 1 ||
    !['delegation', 'memory_search', 'remote_recall', 'schedules', 'web_search'].every(
      (key) => typeof capabilities[key] === 'boolean',
    ) ||
    !['always', 'untrusted', 'never'].includes(capabilities.delegation_approval as string)
  ) {
    throw new Error('Unsupported or inconsistent conversation environment');
  }
  const binding = conversationBinding(raw.binding, raw.binding?.execution?.workspaceId);
  if (
    !binding ||
    (project.workspaceId !== null &&
      project.workspaceId !== binding.membership.legacyWorkspaceId) ||
    (mode?.definition && mode.definition.id !== binding.execution.modeId) ||
    (project.resolution === 'mode_unavailable' && mode?.definition != null) ||
    (['member', 'none'].includes(project.resolution) && !mode?.definition)
  ) {
    throw new Error('Unsupported or inconsistent conversation environment');
  }
  return {
    version: 1,
    sessionId,
    binding,
    project,
    modePolicy: mode,
    workspacePolicy: raw.workspacePolicy,
    enforcement: 'not_tracked',
  };
}
