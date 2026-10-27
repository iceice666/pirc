import type { ConversationBinding } from './types';

/** Do not mistake an unknown/new binding format for an old server. */
export function conversationBinding(
  raw: any,
  workspaceId: string,
): ConversationBinding | undefined {
  if (raw === undefined || raw === null) return undefined;
  const revision = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
  const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
  if (
    raw.version !== 1 ||
    !revision(raw.membership?.revision) ||
    raw.membership.legacyWorkspaceId !== workspaceId ||
    !text(workspaceId) ||
    !revision(raw.execution?.generation) ||
    raw.execution.workspaceId !== workspaceId ||
    !(raw.execution.nodeId === null || text(raw.execution.nodeId)) ||
    !text(raw.execution.modeId)
  )
    throw new Error('Unsupported or inconsistent conversation binding');
  return {
    version: 1,
    membership: { revision: raw.membership.revision, legacyWorkspaceId: workspaceId },
    execution: {
      generation: raw.execution.generation,
      workspaceId,
      nodeId: raw.execution.nodeId,
      modeId: raw.execution.modeId,
    },
  };
}
