/**
 * Open loops (plans/rewrite/04-open-loops.md): what is still open between pirc and
 * you, always on its mind until closed. pirc opens and closes them itself; you can
 * close one ("not needed") or open it again ("not done yet").
 */
import { request } from './http';
import { locale, t } from './i18n';

/** A time anchor: one time, or a recurrence. */
export interface LoopAnchor {
  /** One time (epoch ms); `autoClose` when the time is the thing itself. */
  at?: number;
  autoClose?: boolean;
  /** It came and the loop waits for you. */
  passed?: boolean;
  /** A cron pattern, its next time and its end. */
  cron?: string;
  nextAt?: number;
  until?: number;
  zone: string;
}

export interface OpenLoop {
  id: string;
  user: string;
  roomId: string | null;
  faceId: string | null;
  what: string;
  why: string;
  /** `user` or `tool:<source>`. */
  origin: string;
  anchor: LoopAnchor | null;
  nextCheck: string | null;
  status: 'open' | 'closed';
  /** pirc's or your words, or `elapsed`, `recurrence_ended`, `demoted`. */
  closedReason: string | null;
  closedAt: number | null;
  createdAt: number;
  lastTouchedAt: number;
  /** When its anchor comes next, while open. */
  dueAt: number | null;
}

/** What a room line says happened to a loop (`body.loop`). */
export interface LoopLine {
  id: string;
  event: 'opened' | 'closed' | 'demoted' | 'reopened';
}

const part = encodeURIComponent;
const patch = (id: string, body: Record<string, unknown>) =>
  request<{ loop: OpenLoop }>(`/api/loops/${part(id)}`, {
    method: 'PATCH',
    cache: 'no-store',
    body: JSON.stringify(body),
  });

export const loopsApi = {
  list: (status: 'open' | 'closed' | 'all' = 'open', limit?: number) => {
    const query = new URLSearchParams({ status });
    if (limit) query.set('limit', String(limit));
    return request<{ loops: OpenLoop[]; limit: number }>(`/api/loops?${query}`, {
      cache: 'no-store',
    });
  },
  /** "Not needed": closed for good, unless opened again. */
  close: (id: string, reason?: string) =>
    patch(id, reason ? { status: 'closed', reason } : { status: 'closed' }),
  /** "Not done yet": open again (one kept in memory leaves it). */
  reopen: (id: string) => patch(id, { status: 'open' }),
};

/** What a line's button does: undo an opening, or open again. */
export function lineAction(line: LoopLine): { label: string; run: () => Promise<unknown> } {
  return line.event === 'opened' || line.event === 'reopened'
    ? { label: t('settings.loops.dontKeep'), run: () => loopsApi.close(line.id) }
    : { label: t('settings.loops.notDoneYet'), run: () => loopsApi.reopen(line.id) };
}

/** `Wed 18:00` in the anchor's zone (with the date when not within a week). */
export function when(at: number, zone: string, now = Date.now()): string {
  const soon = at - now < 6 * 86_400_000 && at >= now - 86_400_000;
  try {
    return new Intl.DateTimeFormat(locale(), {
      weekday: 'short',
      ...(soon ? {} : { month: 'short', day: 'numeric' }),
      hour: '2-digit',
      minute: '2-digit',
      timeZone: zone,
    }).format(at);
  } catch {
    return new Date(at).toLocaleString(locale());
  }
}

/** "Next: Wed 18:00 · every week until …", "Due Sat 23:59", "Was due …". */
export function describeAnchor(loop: OpenLoop, now = Date.now()): string {
  const anchor = loop.anchor;
  if (!anchor) return '';
  if (anchor.cron) {
    const parts: string[] = [];
    if (loop.status === 'open' && loop.dueAt)
      parts.push(t('settings.loops.next', { when: when(loop.dueAt, anchor.zone, now) }));
    parts.push(t('settings.loops.repeats', { cron: anchor.cron }));
    if (anchor.until)
      parts.push(t('settings.loops.until', { when: when(anchor.until, anchor.zone, now) }));
    return parts.join(' · ');
  }
  if (anchor.at === undefined) return '';
  const time = when(anchor.at, anchor.zone, now);
  const due =
    loop.status === 'open' && loop.dueAt
      ? t('settings.loops.due', { when: time })
      : t('settings.loops.wasDue', { when: time });
  return anchor.autoClose ? t('settings.loops.autoClose', { due }) : due;
}

/** Why a loop was closed, for people. */
export function describeClosed(reason: string | null): string {
  if (reason === 'elapsed') return t('settings.loops.reasonElapsed');
  if (reason === 'recurrence_ended') return t('settings.loops.reasonEnded');
  if (reason === 'demoted') return t('settings.loops.reasonDemoted');
  return reason ?? '';
}
