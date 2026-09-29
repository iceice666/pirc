/**
 * Scheduled tasks, held by the gateway (plans/cron.md): a prompt that runs in
 * a new session at set times. Runs the gateway could not start on time are
 * `missed` and wait for you to allow them.
 */
import { request } from './http';
import type { ThinkingLevel } from './types';

export type ScheduleStatus = 'active' | 'paused' | 'done';
export type NotifyLevel = 'all' | 'problems' | 'none';

export const NOTIFY_LABELS: Record<NotifyLevel, string> = {
  all: 'Every run',
  problems: 'Only when it fails, is missed or needs me',
  none: 'Never',
};
export type RunStatus =
  | 'missed'
  | 'skipped'
  | 'dismissed'
  | 'running'
  | 'waiting_input'
  | 'completed'
  | 'failed';

export interface ScheduleRun {
  id: string;
  scheduleId: string;
  dueAt: number;
  status: RunStatus;
  sessionId: string | null;
  /** The session's name, while it exists. */
  session: string | null;
  result: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  createdAt: number;
}

export interface Schedule {
  id: string;
  title: string;
  prompt: string;
  workspaceId: string;
  workspace: {
    id: string;
    name: string;
    kind: 'directory' | 'chat' | null;
    node: string | null;
    online: boolean;
  };
  cron: string | null;
  runAt: number | null;
  timezone: string;
  model: { provider: string; id: string } | null;
  thinking: ThinkingLevel | null;
  /** Which runs push a notification. */
  notify: NotifyLevel;
  status: ScheduleStatus;
  nextRunAt: number | null;
  /** The chat whose assistant proposed it; null when you made it. */
  createdBySession: string | null;
  lastRun: ScheduleRun | null;
  /** Runs waiting for you: missed ones and ones waiting for an answer. */
  attention: number;
  createdAt: number;
  updatedAt: number;
}

/** What the form sends. `at` is wall time in `timezone` (`2026-10-01T09:00`). */
export interface ScheduleInput {
  workspaceId?: string;
  title?: string;
  prompt?: string;
  cron?: string;
  at?: string;
  timezone?: string;
  model?: { provider: string; id: string } | null;
  thinking?: ThinkingLevel | null;
  notify?: NotifyLevel;
}

/** Schedules are personal: never from a browser cache. */
const noStore = <T>(path: string, init: RequestInit = {}) =>
  request<T>(path, { cache: 'no-store', ...init });
const send = <T>(method: string, path: string, body?: unknown) =>
  noStore<T>(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const part = encodeURIComponent;

export const schedulesApi = {
  list: () => noStore<{ schedules: Schedule[]; timezone: string }>('/api/schedules'),
  get: (id: string) =>
    noStore<{ schedule: Schedule; runs: ScheduleRun[] }>(`/api/schedules/${part(id)}`),
  create: async (input: ScheduleInput) =>
    (await send<{ schedule: Schedule }>('POST', '/api/schedules', input)).schedule,
  update: async (id: string, input: ScheduleInput & { status?: 'active' | 'paused' }) =>
    (await send<{ schedule: Schedule }>('PATCH', `/api/schedules/${part(id)}`, input)).schedule,
  remove: (id: string) => send<void>('DELETE', `/api/schedules/${part(id)}`),
  /** Run it now, or allow a missed run. */
  run: async (id: string, runId?: string) =>
    (
      await send<{ run: ScheduleRun }>(
        'POST',
        `/api/schedules/${part(id)}/run`,
        runId ? { runId } : {},
      )
    ).run,
  dismiss: async (id: string, runId: string) =>
    (
      await send<{ run: ScheduleRun }>(
        'POST',
        `/api/schedules/${part(id)}/runs/${part(runId)}/dismiss`,
      )
    ).run,
};

/** This device's time zone: the default for schedules you make here. */
export const deviceTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/** Every IANA time zone this browser knows (for the picker). */
export function timezones(): string[] {
  try {
    return (
      (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.(
        'timeZone',
      ) ?? [deviceTimezone()]
    );
  } catch {
    return [deviceTimezone()];
  }
}

function wallParts(at: number, timezone: string) {
  return Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(at))
      .map((item) => [item.type, item.value]),
  ) as Record<string, string>;
}

/** `2026-10-01 09:00`, as the clock reads in `timezone`. */
export function formatWall(at: number, timezone: string): string {
  const p = wallParts(at, timezone);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** A `datetime-local` value (`2026-10-01T09:00`) for a time in `timezone`. */
export function wallInput(at: number, timezone: string): string {
  return formatWall(at, timezone).replace(' ', 'T');
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const two = (value: string) => value.padStart(2, '0');
const plainNumber = /^\d{1,2}$/;

/**
 * A cron expression in words when it is a common shape ("Weekdays at 09:00"),
 * else the expression itself.
 */
export function describeCron(expression: string): string {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return expression;
  const [minute, hour, day, month, weekday] = fields as [string, string, string, string, string];
  const every = /^\*\/(\d+)$/;
  if (hour === '*' && day === '*' && month === '*' && weekday === '*') {
    if (minute === '*') return 'Every minute';
    const step = every.exec(minute);
    if (step) return `Every ${step[1]} minutes`;
    if (plainNumber.test(minute)) return `Every hour at :${two(minute)}`;
    return expression;
  }
  if (!plainNumber.test(minute) || month !== '*') return expression;
  const hourStep = every.exec(hour);
  if (hourStep && day === '*' && weekday === '*')
    return `Every ${hourStep[1]} hours at :${two(minute)}`;
  if (!plainNumber.test(hour)) return expression;
  const time = `${two(hour)}:${two(minute)}`;
  if (day === '*' && weekday === '*') return `Every day at ${time}`;
  if (day === '*') {
    if (weekday === '1-5') return `Weekdays at ${time}`;
    if (weekday === '0,6' || weekday === '6,0') return `Weekends at ${time}`;
    const days = weekday.split(',');
    if (days.every((d) => /^[0-7]$/.test(d)))
      return `Every ${days.map((d) => DAYS[Number(d) % 7]).join(', ')} at ${time}`;
    return expression;
  }
  if (weekday === '*' && plainNumber.test(day)) return `Monthly on day ${Number(day)} at ${time}`;
  return expression;
}

/** When a schedule runs, for people. */
export function describeWhen(schedule: Pick<Schedule, 'cron' | 'runAt' | 'timezone'>): string {
  if (schedule.cron !== null) return `${describeCron(schedule.cron)} (${schedule.timezone})`;
  return schedule.runAt !== null
    ? `Once at ${formatWall(schedule.runAt, schedule.timezone)} (${schedule.timezone})`
    : 'Never';
}

export const RUN_LABELS: Record<RunStatus, string> = {
  missed: 'Missed',
  skipped: 'Skipped',
  dismissed: 'Dismissed',
  running: 'Running',
  waiting_input: 'Waiting for you',
  completed: 'Completed',
  failed: 'Failed',
};

/** Common repeats for the form. */
export const CRON_PRESETS: Array<{ label: string; cron: string }> = [
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Every day at 09:00', cron: '0 9 * * *' },
  { label: 'Weekdays at 09:00', cron: '0 9 * * 1-5' },
  { label: 'Mondays at 09:00', cron: '0 9 * * 1' },
  { label: 'First of the month', cron: '0 9 1 * *' },
];

/** "in 5m", "in 3h", "in 2d" (the next run). */
export function until(at: number, now = Date.now()): string {
  const delta = at - now;
  if (delta < 60_000) return 'in under a minute';
  if (delta < 3_600_000) return `in ${Math.round(delta / 60_000)}m`;
  if (delta < 86_400_000) return `in ${Math.round(delta / 3_600_000)}h`;
  return `in ${Math.round(delta / 86_400_000)}d`;
}
