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
