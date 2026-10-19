import { request } from './http';

export const CAPABILITY_LABELS = {
  delegation: 'Delegation',
  memory_search: 'Memory search',
  remote_recall: 'Remote recall',
  schedules: 'Schedules',
  web_search: 'Web search',
} as const;

export type Capability = keyof typeof CAPABILITY_LABELS;

/** When a delegation from this workspace's chats waits for the user's approval. */
export type DelegationApproval = 'always' | 'untrusted' | 'never';
export const DELEGATION_APPROVAL_LABELS: Record<DelegationApproval, string> = {
  always: 'Ask me every time',
  untrusted: 'Only when the chat read outside content',
  never: 'Never ask',
};

export type ProjectCapabilities = { version: 1 } & Record<Capability, boolean> & {
    /** Absent from older gateways, which always ask. */
    delegation_approval?: DelegationApproval;
  };
export type CapabilitiesUpdate = Partial<Record<Capability, boolean>> & {
  delegation_approval?: DelegationApproval;
};
type CapabilitiesResponse = { capabilities: ProjectCapabilities };
const path = (workspaceId: string) =>
  `/api/workspaces/${encodeURIComponent(workspaceId)}/capabilities`;

export const capabilitiesApi = {
  get: (workspaceId: string) => request<CapabilitiesResponse>(path(workspaceId)),
  update: (workspaceId: string, capabilities: CapabilitiesUpdate) =>
    request<CapabilitiesResponse>(path(workspaceId), {
      method: 'PATCH',
      body: JSON.stringify({ capabilities }),
    }),
};

/** A chat project's instructions, kept by its node (docs/guides/chat-projects.md). */
export interface ProjectInstructions {
  text: string;
  maxChars: number;
}
type InstructionsResponse = { instructions: ProjectInstructions };
const instructionsPath = (workspaceId: string) =>
  `/api/workspaces/${encodeURIComponent(workspaceId)}/instructions`;

export const instructionsApi = {
  get: (workspaceId: string) => request<InstructionsResponse>(instructionsPath(workspaceId)),
  update: (workspaceId: string, text: string) =>
    request<InstructionsResponse>(instructionsPath(workspaceId), {
      method: 'PATCH',
      body: JSON.stringify({ text }),
    }),
};

/**
 * A chat project's file, kept by its node and readable (never writable) by
 * the project's chats (docs/guides/chat-projects.md#project-files).
 */
export interface ProjectFile {
  name: string;
  byteSize: number;
  /** Milliseconds since the epoch. */
  modifiedAt: number;
}
export interface ProjectFiles {
  files: ProjectFile[];
  maxFiles: number;
  maxBytes: number;
}
const filesPath = (workspaceId: string) =>
  `/api/workspaces/${encodeURIComponent(workspaceId)}/files`;

export const projectFilesApi = {
  list: (workspaceId: string) => request<ProjectFiles>(filesPath(workspaceId)),
  /** Adds `file`, or replaces the project's file of the same name. */
  upload: (workspaceId: string, file: File) =>
    request<{ file: ProjectFile }>(
      `${filesPath(workspaceId)}?filename=${encodeURIComponent(file.name)}`,
      {
        method: 'POST',
        // Always raw bytes: a JSON file must not be parsed by the gateway.
        headers: { 'content-type': 'application/octet-stream' },
        body: file,
      },
    ),
  remove: (workspaceId: string, name: string) =>
    request<void>(`${filesPath(workspaceId)}?name=${encodeURIComponent(name)}`, {
      method: 'DELETE',
    }),
};

/**
 * A directory workspace a chat project is linked to
 * (docs/architecture/assistant-memory.md): a default and an ordering for its assistant, never a permission.
 */
export interface ProjectLink {
  workspaceId: string;
  /** Absent when the gateway no longer knows the workspace. */
  name?: string;
  node?: string;
  /** Its repository's normalized `origin`; a link also covers its other clones. */
  repo?: string | null;
  online: boolean;
  /** Its node is connected but no longer has it, or the gateway forgot it. */
  removed: boolean;
  createdAt: number;
}
type LinksResponse = { links: ProjectLink[] };
const linksPath = (workspaceId: string) =>
  `/api/workspaces/${encodeURIComponent(workspaceId)}/links`;

export const linksApi = {
  get: (workspaceId: string) => request<LinksResponse>(linksPath(workspaceId)),
  update: (workspaceId: string, workspaceIds: string[]) =>
    request<LinksResponse>(linksPath(workspaceId), {
      method: 'PUT',
      body: JSON.stringify({ workspaceIds }),
    }),
};

/** One project hook: a shell command, optionally for matching tools only. */
export interface ProjectHook {
  command: string;
  matcher?: string;
  timeoutMs?: number;
}

/**
 * A directory workspace's `.pirc/config.json` fields that run code, widen
 * access or pick the model, kept by its node. Agents ignore them until the user trusts exactly
 * these values (`hash`); a later change needs trust again.
 */
export type ProjectConfigSummary = {
  hash: string | null;
  trustedHash: string | null;
  trusted: boolean;
  /** No hooks, env, allowed paths or model: nothing to trust. */
  empty: boolean;
} & (
  | {
      hooks: Record<string, ProjectHook[]>;
      env: Record<string, string>;
      allowedPaths: string[];
      /** Absent from older nodes. */
      defaultModel?: { provider: string; id: string; thinking?: string } | null;
      error?: undefined;
    }
  | {
      error: string;
      hooks?: undefined;
      env?: undefined;
      allowedPaths?: undefined;
      defaultModel?: undefined;
    }
);
type ProjectConfigResponse = { project: ProjectConfigSummary };
const projectPath = (workspaceId: string, rest: string) =>
  `/api/workspaces/${encodeURIComponent(workspaceId)}/${rest}`;

export const projectTrustApi = {
  get: (workspaceId: string) =>
    request<ProjectConfigResponse>(projectPath(workspaceId, 'project-config')),
  trust: (workspaceId: string, hash: string) =>
    request<ProjectConfigResponse>(projectPath(workspaceId, 'project-trust'), {
      method: 'POST',
      body: JSON.stringify({ trusted: true, hash }),
    }),
  revoke: (workspaceId: string) =>
    request<ProjectConfigResponse>(projectPath(workspaceId, 'project-trust'), {
      method: 'POST',
      body: JSON.stringify({ trusted: false }),
    }),
};
