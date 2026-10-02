import { request } from './http';

export const CAPABILITY_LABELS = {
  delegation: 'Delegation',
  memory_search: 'Memory search',
  remote_recall: 'Remote recall',
  schedules: 'Schedules',
  web_search: 'Web search',
} as const;

export type Capability = keyof typeof CAPABILITY_LABELS;
export type ProjectCapabilities = { version: 1 } & Record<Capability, boolean>;
type CapabilitiesResponse = { capabilities: ProjectCapabilities };
const path = (workspaceId: string) =>
  `/api/workspaces/${encodeURIComponent(workspaceId)}/capabilities`;

export const capabilitiesApi = {
  get: (workspaceId: string) => request<CapabilitiesResponse>(path(workspaceId)),
  update: (workspaceId: string, capabilities: Partial<Record<Capability, boolean>>) =>
    request<CapabilitiesResponse>(path(workspaceId), {
      method: 'PATCH',
      body: JSON.stringify({ capabilities }),
    }),
};

/** A chat project's instructions, kept by its node (plans/assistant.md §5). */
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

/** One project hook: a shell command, optionally for matching tools only. */
export interface ProjectHook {
  command: string;
  matcher?: string;
  timeoutMs?: number;
}

/**
 * A directory workspace's `.pirc/config.json` fields that run code or widen
 * access, kept by its node. Agents ignore them until the user trusts exactly
 * these values (`hash`); a later change needs trust again.
 */
export type ProjectConfigSummary = {
  hash: string | null;
  trustedHash: string | null;
  trusted: boolean;
  /** No hooks, env or allowed paths: nothing to trust. */
  empty: boolean;
} & (
  | {
      hooks: Record<string, ProjectHook[]>;
      env: Record<string, string>;
      allowedPaths: string[];
      error?: undefined;
    }
  | { error: string; hooks?: undefined; env?: undefined; allowedPaths?: undefined }
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
