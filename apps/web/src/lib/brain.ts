/**
 * What the engine shows of the brain (plans/rewrite/02-brain-host.md): a
 * room's latest turns, newest first. Its prompts live with the faces.
 */
import { request } from './http';

export interface BrainTurn {
  id: string;
  roomId: string;
  /** `user`: people spoke; `wake`: it came back on its own. */
  kind: 'user' | 'wake';
  messageIds: string[];
  startedAt: number;
  endedAt: number | null;
  /** `done`, `failed`, `aborted`, `timeout` or `preempted`; null while it runs. */
  outcome: string | null;
  error: string | null;
  usage: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    totalTokens?: number;
  } | null;
}

export const brainApi = {
  turns: (roomId: string, limit = 20) =>
    request<{ turns: BrainTurn[] }>(
      `/api/brain/turns?${new URLSearchParams({ room: roomId, limit: String(limit) })}`,
      { cache: 'no-store' },
    ),
};

/** "1.2k tokens" */
export function tokens(count: number | undefined): string {
  if (!count) return '0 tokens';
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k tokens` : `${count} tokens`;
}

/** What became of a turn, in words. */
export function turnOutcome(turn: BrainTurn): string {
  switch (turn.outcome) {
    case null:
      return 'Running';
    case 'done':
      return 'Done';
    case 'failed':
      return 'Failed';
    case 'aborted':
      return 'Stopped';
    case 'timeout':
      return 'Timed out';
    case 'preempted':
      return 'Cut short by new messages';
    default:
      return turn.outcome;
  }
}
