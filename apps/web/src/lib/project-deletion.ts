/**
 * Deleting a chat project (docs/guides/chat-projects.md, "Deleting a project"):
 * what the gateway would delete, and the deletion with your decisions on
 * memory entries mixing the project's text with other chats'.
 */
import { request } from './http';
import type { MemoryEntry } from './memory';

/**
 * What deleting the project does to an entry its chats wrote: `forget` (every
 * version came from the project), `rollback` (to `restored`, the last version
 * from elsewhere), or `review` (mixed: you decide).
 */
export interface ProjectMemoryItem {
  entry: MemoryEntry;
  action: 'forget' | 'rollback' | 'review';
  restored: string | null;
  restoredRevision: number | null;
}

export interface ProjectDeletionPreview {
  project: { id: string; displayName: string };
  nodeOnline: boolean;
  /** An earlier deletion stopped part way; deleting again finishes it. */
  deleting: boolean;
  chats: Array<{ id: string; name: string }>;
  /** Schedules that run in the project: deleted with it. */
  schedules: Array<{ id: string; title: string }>;
  /** Schedules its chats created in other workspaces: kept. */
  keptSchedules: Array<{
    id: string;
    title: string;
    workspaceId: string;
    workspaceName: string | null;
  }>;
  /** Delegations started from its chats: their records are deleted, their work stays. */
  delegations: number;
  /** Workspaces it is linked to. */
  links: number;
  memory: ProjectMemoryItem[];
}

export type ProjectMemoryDecision =
  | { entryId: string; revision: number; action: 'forget' | 'keep' }
  | { entryId: string; revision: number; action: 'edit'; content: string };

const path = (workspaceId: string) => `/api/workspaces/${encodeURIComponent(workspaceId)}/deletion`;

export const projectDeletionApi = {
  preview: (workspaceId: string) =>
    request<ProjectDeletionPreview>(path(workspaceId), { cache: 'no-store' }),
  /** 409 `conflict` when memory changed since the preview: load it again. */
  delete: (workspaceId: string, decisions: ProjectMemoryDecision[]) =>
    request<void>(path(workspaceId), {
      method: 'POST',
      body: JSON.stringify({ decisions }),
    }),
};
