/**
 * What the engine shows of the brain (plans/rewrite/02-brain-host.md): a
 * room's latest turns, newest first. Its prompts live with the faces.
 */
import { request } from './http';
import { t } from './i18n';

export interface BrainTurn {
  id: string;
  roomId: string;
  /** `user`: people spoke; `wake`: it came back on its own; `report`: it told the room how its workers ended. */
  kind: 'user' | 'wake' | 'report';
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
  if (!count) return t('engine.tokens.none');
  return count >= 1000
    ? t('engine.tokens.k', { count: (count / 1000).toFixed(1) })
    : t('engine.tokens.count', { count });
}

/** What became of a turn, in words. */
export function turnOutcome(turn: BrainTurn): string {
  switch (turn.outcome) {
    case null:
      return t('engine.turn.running');
    case 'done':
      return t('common.status.done');
    case 'failed':
      return t('common.status.failed');
    case 'aborted':
      return t('engine.turn.stopped');
    case 'timeout':
      return t('engine.turn.timedOut');
    case 'preempted':
      return t('engine.turn.preempted');
    default:
      return turn.outcome;
  }
}
