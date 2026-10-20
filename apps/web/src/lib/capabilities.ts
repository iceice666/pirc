import { request } from './http';

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
