/**
 * Wakes (plans/rewrite/05-self-wake.md): pirc waking up on its own — an open
 * loop's time came, it said it would come back, or a source changed. A wake
 * only reads and remembers; it says something in the room only when it is
 * worth saying, so most leave nothing there. This lists them, and cancels one
 * that has not started.
 */
import { request } from './http';
import { t } from './i18n';
import { when } from './loops';

export interface Wake {
  id: string;
  kind: 'anchor' | 'source' | 'self';
  /**
   * What woke it: `{loopId, moment, at, autoClose}`, `{at, why}`, or a
   * source's `{sourceId, name, reason, loopIds, items}`.
   */
  trigger: {
    loopId?: string;
    moment?: 'due' | 'eve' | 'next';
    at?: number | null;
    autoClose?: boolean;
    why?: string;
    sourceId?: string;
    name?: string;
    reason?: 'followed' | 'loop';
    items?: { id: string; summary: string }[];
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
  if (wake.kind === 'self') return t('settings.wakes.triggerSelf', { why: wake.trigger.why ?? '' });
  if (wake.kind === 'anchor') {
    if (wake.trigger.moment === 'eve') return t('settings.wakes.triggerEve');
    if (wake.trigger.moment === 'next') return t('settings.wakes.triggerNext');
    return t('settings.wakes.triggerDue');
  }
  const name = wake.trigger.name ?? wake.trigger.sourceId;
  if (!name) return t('settings.wakes.triggerSource');
  return wake.trigger.reason === 'loop'
    ? t('settings.wakes.triggerSourceLoop', { name })
    : t('settings.wakes.triggerSourceNew', { name });
}

/** The browser's own zone: when a wake comes, as the person reads it. */
const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** How a wake went, or when it comes. */
export function describeOutcome(wake: Wake, zone = localZone(), now = Date.now()): string {
  switch (wake.outcome) {
    case null:
      return wake.startedAt
        ? t('settings.wakes.awakeNow')
        : t('settings.wakes.at', { when: when(wake.scheduledAt, zone, now) });
    case 'spoke':
      return t('settings.wakes.spoke');
    case 'silent':
      return wake.note
        ? t('settings.wakes.silentNote', { note: wake.note })
        : t('settings.wakes.silent');
    case 'preempted':
      return t('settings.wakes.preempted');
    case 'failed':
      return wake.note
        ? t('settings.wakes.failedNote', { note: wake.note })
        : t('settings.wakes.failed');
    case 'quota':
      return t('settings.wakes.quota');
    case 'cancelled':
      return t('settings.wakes.cancelled');
  }
}
