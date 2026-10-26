import { request } from './http';
import { uuid } from './id';

export interface PotsBudgets {
  observations: number;
  dispatches: number;
  concurrency: number;
}
export interface PotsScope {
  workspaceId: string;
  access: 'progress';
}
export interface Responsibility {
  id: string;
  ownerUser: string;
  revision: number;
  generation: number;
  purpose: string;
  scopes: PotsScope[];
  budgets: PotsBudgets;
  enabled: boolean;
  observationPaused: boolean;
  coordinationPaused: boolean;
  observationsUsed: number;
  dispatchesUsed: number;
  createdAt: number;
  updatedAt: number;
}
export type ResponsibilityAction =
  | 'activate'
  | 'disable'
  | 'pause_observation'
  | 'resume_observation'
  | 'pause_coordination'
  | 'resume_coordination';
export interface PotsSuggestion {
  id: string;
  ownerUser: string;
  responsibilityId: string;
  conditionKey: string;
  occurrenceKey: string;
  revision: number;
  evidence: {
    workspaceId: string;
    sessionId: string;
    runnerEpoch: number;
    interactionId: string;
    expiresAt: number;
  };
  action: 'review_session_input';
  targetSessionId: string;
  disposition: 'pending' | 'snoozed' | 'dismissed' | 'linked' | 'needs_refresh' | 'superseded';
  snoozedUntil: number | null;
  taskId: string | null;
  acceptedRevision: number | null;
  createdAt: number;
  updatedAt: number;
}
export interface PotsTask {
  id: string;
  ownerUser: string;
  originSuggestionId: string;
  acceptedSuggestionRevision: number;
  action: 'review_session_input';
  targetSessionId: string;
  executionSessionId: string | null;
  status:
    | 'tracked'
    | 'starting'
    | 'queued'
    | 'running'
    | 'waiting_input'
    | 'completed'
    | 'failed'
    | 'interrupted'
    | 'stopping'
    | 'stopped';
  execution?: {
    instruction: string;
    dispatchId: string;
    generation: number;
    acceptedRevision: number;
    acceptedAt: number;
    state?: string;
  };
  outcome?: string | null;
  failure?: string | null;
  revision: number;
  controlGeneration: number;
  coordinationPaused: boolean;
  takenOver: boolean;
  createdAt: number;
  updatedAt: number;
}
export type TaskAction = 'pause_coordination' | 'resume_coordination' | 'take_over' | 'stop';
export interface PotsOverview {
  actor: { kind: 'pots'; id: 'personal' };
  accountKey: string;
  executionAvailable: boolean;
  observationMode: 'session_progress_events';
  workspaces: { id: string; name: string }[];
  responsibilities: Responsibility[];
  suggestions: PotsSuggestion[];
  tasks: PotsTask[];
}
export interface ResponsibilityInput {
  idempotencyKey: string;
  purpose: string;
  scopes: PotsScope[];
  budgets: PotsBudgets;
}

// No browser cache/persistence or automatic mutation retries. Lists are capped at
// 100 by the server; cursor pagination is a future API checkpoint.
const read = <T>(path: string, signal?: AbortSignal) =>
  request<T>(path, { cache: 'no-store', signal });
const send = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'POST', cache: 'no-store', body: JSON.stringify(body) });
const part = encodeURIComponent;
export const potsApi = {
  overview: (signal?: AbortSignal) => read<PotsOverview>('/api/pots?limit=100', signal),
  create: (input: ResponsibilityInput) =>
    send<{ responsibility: Responsibility }>('/api/pots/responsibilities', input),
  responsibility: (record: Responsibility, type: ResponsibilityAction) =>
    send<{ responsibility: Responsibility }>(
      `/api/pots/responsibilities/${part(record.id)}/control`,
      {
        expectedRevision: record.revision,
        expectedGeneration: record.generation,
        action: { type },
      },
    ),
  suggestion: (
    record: PotsSuggestion,
    action: { type: 'dismiss' } | { type: 'snooze'; until: number },
  ) =>
    send<{ suggestion: PotsSuggestion }>(`/api/pots/suggestions/${part(record.id)}/control`, {
      expectedRevision: record.revision,
      action,
    }),
  track: (record: PotsSuggestion, commandId = uuid()) =>
    send<{ task: PotsTask }>(`/api/pots/suggestions/${part(record.id)}/track`, {
      expectedRevision: record.revision,
      commandId,
    }),
  task: (record: PotsTask, type: TaskAction) =>
    send<{ task: PotsTask }>(`/api/pots/tasks/${part(record.id)}/control`, {
      expectedRevision: record.revision,
      expectedGeneration: record.controlGeneration,
      action: { type },
    }),
  start: (record: PotsTask, instruction: string, commandId = uuid()) =>
    send<{ task: PotsTask }>(`/api/pots/tasks/${part(record.id)}/start`, {
      expectedRevision: record.revision,
      expectedGeneration: record.controlGeneration,
      commandId,
      instruction,
    }),
};

export const potsTaskLabels: Record<PotsTask['status'], string> = {
  tracked: 'Tracked',
  starting: 'Starting',
  queued: 'Queued',
  running: 'Running',
  waiting_input: 'Waiting for input',
  completed: 'Completed',
  failed: 'Failed',
  interrupted: 'Interrupted',
  stopping: 'Stopping',
  stopped: 'Stopped',
};
export const potsTaskTerminal = (task: PotsTask) =>
  ['completed', 'failed', 'interrupted', 'stopped'].includes(task.status);
export const validPotsInstruction = (instruction: string) =>
  instruction.trim().length > 0 && new TextEncoder().encode(instruction).length <= 20000;
