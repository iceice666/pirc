/** Client for the side-panel endpoints (files, Git, memory, background, terminals). */
import { getClientId } from './storage';

export type PanelTab = 'overview' | 'files' | 'git' | 'memory' | 'tasks' | 'terminal';

export class PanelError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code = 'unknown_error',
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set('content-type', 'application/json');
  headers.set('accept', 'application/json');
  const response = await fetch(path, { ...init, headers, credentials: 'include' });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new PanelError(
      body?.error?.message ?? `Request failed (${response.status})`,
      response.status,
      body?.error?.code,
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

const base = (sessionId: string) => `/api/sessions/${encodeURIComponent(sessionId)}`;
const qs = (params: Record<string, string | number | boolean | undefined>) => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params))
    if (value !== undefined && value !== false && value !== '')
      query.set(key, value === true ? '1' : String(value));
  const text = query.toString();
  return text ? `?${text}` : '';
};

export interface GitFile {
  path: string;
  origPath?: string;
  index: string;
  worktree: string;
}
export type GitStatus =
  | { repo: false }
  | {
      repo: true;
      root: string;
      branch: string | null;
      upstream: string | null;
      ahead: number;
      behind: number;
      files: GitFile[];
      truncated: boolean;
    };
export interface Commit {
  sha: string;
  short: string;
  author: string;
  email: string;
  time: number;
  refs: string[];
  subject: string;
}
export interface CommitDetail {
  sha: string;
  author: string;
  email: string;
  time: number;
  refs: string[];
  message: string;
  diff: string;
  truncated: boolean;
}
export interface DirEntry {
  name: string;
  kind: 'dir' | 'file' | 'symlink' | 'other';
  size?: number;
}
export interface FileContent {
  path: string;
  size: number;
  modifiedAt: number;
  binary: boolean;
  truncated: boolean;
  content?: string;
}
export interface Meter {
  value: number;
  max: number;
}
export type Relevance = 'low' | 'medium' | 'high' | 'critical';
export interface MemoryPanel {
  enabled: boolean;
  passive: boolean;
  thresholds: {
    observation: Meter;
    reflection: Meter;
    compaction: Meter;
    visiblePool: Meter;
    activePool: Meter;
  };
  counts: {
    observations: number;
    active: number;
    dropped: number;
    visibleObservations: number;
    reflections: number;
    visibleReflections: number;
    compactions: number;
  };
  observations: Array<{
    id: string;
    content: string;
    timestamp: string;
    relevance: Relevance;
    tokenCount: number;
    dropped: boolean;
    visible: boolean;
  }>;
  reflections: Array<{
    id: string;
    content: string;
    supportingObservationIds: string[];
    tokenCount: number;
    visible: boolean;
  }>;
  lastCompactionAt?: number;
}
export interface MemoryRuntime {
  phase: string | null;
  autoCompacting: boolean;
  rateLimited: Array<{ model: string; until: number }>;
  lastErrors: Record<string, string>;
}
export interface BackgroundTask {
  id: string;
  command: string;
  cwd: string;
  status: 'running' | 'stopping' | 'completed' | 'failed' | 'stopped' | 'timed_out';
  pid?: number;
  exitCode?: number | null;
  signal?: string | null;
  startedAt: string;
  endedAt?: string;
  error?: string;
}
export interface TeamMember {
  name: string;
  kind?: string;
  status?: string;
  cwd?: string;
  model?: string;
  thinking?: string;
  lastError?: string;
  task?: string;
  pid?: number;
  startedAt?: number | string;
  lastActivity?: number | string;
  activity?: unknown;
}
export interface PanelState {
  agentRunning: boolean;
  memory: MemoryPanel | null;
  memoryRuntime: MemoryRuntime | null;
  backgroundTasks: BackgroundTask[];
  team: {
    agents: TeamMember[];
    events?: Array<{
      id: string;
      time: string;
      kind: string;
      from?: string;
      to?: string;
      name?: string;
      body?: string;
    }>;
  };
}
export interface TerminalInfo {
  id: string;
  sessionId: string;
  title: string;
  cwd: string;
  cols: number;
  rows: number;
  createdAt: number;
  exitCode: number | null;
  exited: boolean;
}

export const panelApi = {
  gitStatus: (sessionId: string) => request<GitStatus>(`${base(sessionId)}/git/status`),
  gitDiff: (sessionId: string, options: { path?: string; staged?: boolean; untracked?: boolean }) =>
    request<{ diff: string; truncated: boolean }>(`${base(sessionId)}/git/diff${qs(options)}`),
  gitLog: (sessionId: string, skip = 0, limit = 50) =>
    request<{ commits: Commit[]; more: boolean }>(
      `${base(sessionId)}/git/log${qs({ skip, limit })}`,
    ),
  gitShow: (sessionId: string, sha: string) =>
    request<CommitDetail>(`${base(sessionId)}/git/commits/${encodeURIComponent(sha)}`),
  files: (sessionId: string, path = '') =>
    request<{ path: string; entries: DirEntry[]; truncated: boolean }>(
      `${base(sessionId)}/files${qs({ path })}`,
    ),
  file: (sessionId: string, path: string) =>
    request<FileContent>(`${base(sessionId)}/files/content${qs({ path })}`),
  state: (sessionId: string) => request<PanelState>(`${base(sessionId)}/panel/state`),
  backgroundOutput: (sessionId: string, taskId: string, lines = 400) =>
    request<{ task: BackgroundTask; output: string }>(
      `${base(sessionId)}/panel/background/${encodeURIComponent(taskId)}${qs({ lines })}`,
    ),
  terminals: (sessionId: string) =>
    request<{ terminals: TerminalInfo[] }>(`${base(sessionId)}/terminals`),
  createTerminal: (sessionId: string, generation: number, cols: number, rows: number) =>
    request<{ terminal: TerminalInfo }>(`${base(sessionId)}/terminals`, {
      method: 'POST',
      body: JSON.stringify({ clientId: getClientId(), generation, cols, rows }),
    }),
  closeTerminal: (sessionId: string, terminalId: string, generation: number) =>
    request<void>(`${base(sessionId)}/terminals/${encodeURIComponent(terminalId)}/close`, {
      method: 'POST',
      body: JSON.stringify({ clientId: getClientId(), generation }),
    }),
  terminalUrl: (sessionId: string, terminalId: string) => {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${location.host}${base(sessionId)}/terminals/${encodeURIComponent(terminalId)}/stream`;
  },
};
