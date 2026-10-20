/**
 * Wakes (plans/rewrite/05-self-wake.md): pirc waking up on its own — an open
 * loop's time came, it said it would come back, or a source changed. A wake
 * only reads and remembers; it says something in the room only when it is
 * worth saying, so most leave nothing there. This lists them, and cancels one
 * that has not started.
 */
import { request } from './http';
import { when } from './loops';

export interface Wake {
  id: string;
  kind: 'anchor' | 'source' | 'self';
  /** What woke it: `{loopId, moment, at, autoClose}` or `{at, why}`. */
  trigger: {
    loopId?: string;
    moment?: 'due' | 'eve' | 'next';
    at?: number | null;
    autoClose?: boolean;
    why?: string;
  };
  roomId: string;
  faceId: string | null;
  user: string | null;
  scheduledAt: number;
  startedAt: number | null;
  endedAt: number | null;
  outcome: 'spoke' | 'silent' | 'preempted' | 'failed' | 'quota' | 'cancelled' | null;
  note: string | null;
  attempt: number;
  turnId: string | null;
  createdAt: number;
}

/** What a room line says about a wake (`body.wake`). */
export interface WakeLine {
  id: string;
  event: 'scheduled' | 'cancelled';
}

export interface WakeList {
  wakes: Wake[];
  /** Wakes started today (in the household's zone), and how many may. */
  today: { used: number; limit: number };
}

export const wakesApi = {
  list: (status: 'pending' | 'ended' | 'all' = 'all', limit?: number, room?: string) => {
    const query = new URLSearchParams({ status });
    if (limit) query.set('limit', String(limit));
    if (room) query.set('room', room);
    return request<WakeList>(`/api/wakes?${query}`, { cache: 'no-store' });
  },
  /** Cancel one that has not started. */
  cancel: (id: string) =>
    request<{ wake: Wake }>(`/api/wakes/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      cache: 'no-store',
    }),
};

/** What woke (or will wake) pirc, for people. */
export function describeTrigger(wake: Wake): string {
  if (wake.kind === 'self') return `Coming back to look at: ${wake.trigger.why ?? ''}`;
  if (wake.kind === 'anchor') {
    if (wake.trigger.moment === 'eve') return 'The day before an open loop is due';
    if (wake.trigger.moment === 'next') return 'A recurring open loop came round';
    return "An open loop's time came";
  }
  return 'A source changed';
}

/** The browser's own zone: when a wake comes, as the person reads it. */
const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** How a wake went, or when it comes. */
export function describeOutcome(wake: Wake, zone = localZone(), now = Date.now()): string {
  switch (wake.outcome) {
    case null:
      return wake.startedAt ? 'Awake now' : `At ${when(wake.scheduledAt, zone, now)}`;
    case 'spoke':
      return 'Said something in the room';
    case 'silent':
      return wake.note ? `Nothing to say (${wake.note})` : 'Nothing to say';
    case 'preempted':
      return 'Someone spoke first; it came back after';
    case 'failed':
      return wake.note ? `Failed: ${wake.note}` : 'Failed';
    case 'quota':
      return "Skipped: today's wakes were used up";
    case 'cancelled':
      return 'Cancelled';
  }
}
