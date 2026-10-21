/**
 * Workers (plans/rewrite/06-workers.md): pirc hands work to a coding agent in
 * one of the household's workspaces without asking. The room shows a message
 * about it (its anchor) with a thread under it, where the worker's progress,
 * its team's talk and its questions go; how it ended comes back to the room.
 * This is the thread's API and the words the room uses for a worker.
 */
import { request } from './http';

export type WorkerStatus = 'queued' | 'running' | 'waiting_input' | 'completed' | 'failed';

/** What the anchor message says of its thread's latest worker (`body.worker`). */
export interface WorkerAnchor {
  delegationId: string;
  threadId: string;
  status: WorkerStatus;
  title: string;
  workspace: string;
  /** Workers that spoke in the thread: the worker and its team. */
  workers: number;
  readOnly: boolean;
  /** Why it waits, when queued. */
  note: string | null;
}

/** A room line or report about a worker (`body.worker`). */
export interface WorkerNote {
  delegationId: string;
  threadId: string | null;
  /** A line: `question`, `busy` or `offline`. */
  event?: 'question' | 'busy' | 'offline';
  /** The report of how it ended. */
  report?: boolean;
  status?: WorkerStatus;
}

export interface Worker {
  id: string;
  roomId: string;
  faceId: string;
  threadId: string | null;
  anchorMessageId: string | null;
  title: string;
  workspace: string;
  workspaceId: string;
  status: WorkerStatus;
  note: string | null;
  readOnly: boolean;
  follows: string | null;
  /** Whom it works for: only they add to its thread, answer it or stop it. */
  for: string;
  targetSessionId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface WorkerQuestion {
  interactionId: string;
  kind: 'select' | 'confirm' | 'input' | 'editor';
  request: {
    method?: string;
    title?: string;
    message?: string;
    options?: string[];
    placeholder?: string;
    prefill?: string;
    confirmLabel?: string;
    cancelLabel?: string;
  };
  status: 'pending' | 'answered' | 'cancelled';
  delegationId: string;
  answeredBy?: string;
  answer?: QuestionAnswer;
}

export interface ThreadMessage {
  id: string;
  threadId: string;
  seq: number;
  /** `worker:<session>`, `worker:<session>/<name>`, `user` or `face:<id>`. */
  speaker: string;
  user: string | null;
  kind: 'text' | 'line' | 'tool' | 'question';
  body: {
    text?: string;
    /** A tool call: which, and its one line. */
    tool?: string;
    summary?: string;
    /** A team record's kind (`spawn`, `message`, `post`, ...). */
    team?: string;
    to?: string;
    topic?: string;
    event?: string;
    delegationId?: string;
    followUp?: boolean;
    context?: string;
  } & Partial<WorkerQuestion>;
  /** 1: a teammate or subagent of the worker. */
  depth: 0 | 1;
  createdAt: number;
  updatedAt: number | null;
}

export interface Thread {
  id: string;
  roomId: string;
  anchorMessageId: string;
  createdAt: number;
  closedAt: number | null;
}

export type QuestionAnswer = { value: string } | { confirmed: boolean } | { cancelled: true };

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });
const threadPath = (id: string, rest = '') => `/api/threads/${encodeURIComponent(id)}${rest}`;

export const workersApi = {
  list: (status: 'active' | 'all' = 'active', room?: string) => {
    const query = new URLSearchParams({ status });
    if (room) query.set('room', room);
    return request<{ workers: Worker[] }>(`/api/workers?${query}`, { cache: 'no-store' });
  },
  thread: (id: string) =>
    request<{ thread: Thread; messages: ThreadMessage[]; workers: Worker[] }>(threadPath(id), {
      cache: 'no-store',
    }),
  /** Said in the thread and handed to its worker. */
  say: (threadId: string, text: string) =>
    request<{ message: ThreadMessage; handed: { delegation: string; as: string } }>(
      threadPath(threadId, '/messages'),
      { method: 'POST', cache: 'no-store', ...json({ text }) },
    ),
  answer: (threadId: string, interactionId: string, answer: QuestionAnswer) =>
    request<{ interactionId: string; status: string }>(threadPath(threadId, '/answer'), {
      method: 'POST',
      cache: 'no-store',
      ...json({ interactionId, answer }),
    }),
  stop: (id: string) =>
    request<{ status: string }>(`/api/delegations/${encodeURIComponent(id)}/stop`, {
      method: 'POST',
    }),
};

/** A worker's status in a few words; `count` workers in its thread. */
export function statusLabel(status: WorkerStatus, count = 1): string {
  switch (status) {
    case 'queued':
      return 'Waiting its turn';
    case 'running':
      return count > 1 ? `Working (${count})` : 'Working';
    case 'waiting_input':
      return 'Asking you';
    case 'completed':
      return 'Done';
    case 'failed':
      return 'Failed';
  }
}

/** Whether a worker in this status can still be stopped. */
export function stoppable(status: WorkerStatus): boolean {
  return status === 'queued' || status === 'running' || status === 'waiting_input';
}

/**
 * Who spoke in a thread, in words: the worker, a teammate by name, a person,
 * or the face that handed the work out.
 */
export function speakerName(message: Pick<ThreadMessage, 'speaker' | 'user'>): string {
  if (message.speaker === 'user') return message.user ?? 'someone';
  if (message.speaker.startsWith('face:')) {
    const face = message.speaker.slice(5);
    return face === 'host' ? 'pirc' : face;
  }
  const member = message.speaker.split('/')[1];
  return member ?? 'worker';
}

/** The distinct workers of a thread's messages, in the order they first spoke. */
export function threadWorkers(messages: ThreadMessage[]): { speaker: string; depth: number }[] {
  const seen = new Map<string, number>();
  for (const message of messages) {
    if (message.speaker.startsWith('worker:') && !seen.has(message.speaker))
      seen.set(message.speaker, message.depth);
  }
  return [...seen].map(([speaker, depth]) => ({ speaker, depth }));
}
