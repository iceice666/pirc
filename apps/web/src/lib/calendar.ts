import { request } from './http';
import type { Schedule, ScheduleRun } from './schedules';

export type CalendarView = 'month' | 'week' | 'day' | 'list';
export type CalendarWeekStart = 'sunday' | 'monday';
export type CalendarItemType = 'event' | 'schedule';
export type CalendarEditScope = 'series' | 'occurrence' | 'following';

export interface CalendarRecurrence {
  frequency: 'daily' | 'weekly' | 'monthly' | 'yearly';
  interval: number;
  weekdays?: number[];
  until?: string;
  count?: number;
}

/** Local date or local date-time fields are kept alongside the occurrence instants. */
export interface CalendarEventSpec {
  title: string;
  description: string;
  location: string;
  start: string;
  end: string;
  timezone: string;
  allDay: boolean;
  recurrence: CalendarRecurrence | null;
  reminderMinutes: number[];
}

export interface CalendarEvent extends CalendarEventSpec {
  id: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface CalendarItem {
  id: string;
  type: CalendarItemType;
  sourceId: string;
  title: string;
  startAt: number;
  endAt: number;
  allDay: boolean;
  startDate?: string;
  /** Exclusive local calendar date for all-day items. */
  endDate?: string;
  timezone: string;
  revision: number;
  /** Local start that identifies this recurrence occurrence, if applicable. */
  originalStart: string;
  event?: CalendarEvent;
  schedule?: Schedule;
  run?: ScheduleRun;
}

export interface CalendarRangeResponse {
  accountKey: string;
  items: CalendarItem[];
  from: number;
  to: number;
  timezone: string;
  limited: boolean;
  nextCursor: string | null;
  historyLimited: true;
}

export interface CalendarEditRequest {
  revision: number;
  event: CalendarEventSpec;
  scope: CalendarEditScope;
  occurrence?: string;
}

export interface CalendarPermissions {
  allowRead: boolean;
  allowPropose: boolean;
}

export interface CalendarContext {
  /** Opaque gateway-owned identity for account-scoped local display preferences. */
  accountKey: string;
  reminderDeliveryAvailable: boolean;
}

const DAY_MS = 86_400_000;
const MAX_RANGE_MS = 93 * DAY_MS;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isCalendarView(value: unknown): value is CalendarView {
  return value === 'month' || value === 'week' || value === 'day' || value === 'list';
}

export function isDateKey(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = DATE_RE.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === value;
}

export function addCalendarDays(date: string, days: number): string {
  if (!isDateKey(date)) throw new RangeError(`Invalid calendar date: ${date}`);
  const result = new Date(
    Date.UTC(
      Number(date.slice(0, 4)),
      Number(date.slice(5, 7)) - 1,
      Number(date.slice(8, 10)) + days,
    ),
  );
  return result.toISOString().slice(0, 10);
}

export function weekdayOf(date: string): number {
  if (!isDateKey(date)) throw new RangeError(`Invalid calendar date: ${date}`);
  return new Date(
    Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))),
  ).getUTCDay();
}

export function startOfWeek(date: string, weekStart: CalendarWeekStart): string {
  const offset = weekStart === 'monday' ? (weekdayOf(date) + 6) % 7 : weekdayOf(date);
  return addCalendarDays(date, -offset);
}

export function monthGrid(date: string, weekStart: CalendarWeekStart): string[][] {
  if (!isDateKey(date)) throw new RangeError(`Invalid calendar date: ${date}`);
  const monthStart = `${date.slice(0, 7)}-01`;
  const nextMonth = addCalendarDays(
    `${date.slice(0, 7)}-${new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)), 0))
      .getUTCDate()
      .toString()
      .padStart(2, '0')}`,
    1,
  );
  const gridStart = startOfWeek(monthStart, weekStart);
  const gridEnd = addCalendarDays(nextMonth, (7 - weekdayOffset(nextMonth, weekStart)) % 7);
  const days: string[] = [];
  for (let cursor = gridStart; cursor < gridEnd; cursor = addCalendarDays(cursor, 1))
    days.push(cursor);
  return Array.from({ length: days.length / 7 }, (_, index) =>
    days.slice(index * 7, index * 7 + 7),
  );
}

function weekdayOffset(date: string, weekStart: CalendarWeekStart): number {
  return weekStart === 'monday' ? (weekdayOf(date) + 6) % 7 : weekdayOf(date);
}

export function zonedDateParts(
  at: number,
  timezone: string,
): { date: string; hour: number; minute: number } {
  const values = Object.fromEntries(
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
      .map(({ type, value }) => [type, value]),
  ) as Record<string, string>;
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    hour: Number(values.hour),
    minute: Number(values.minute),
  };
}

export function dateInTimezone(at: number, timezone: string): string {
  return zonedDateParts(at, timezone).date;
}

export function todayInTimezone(timezone: string, now = Date.now()): string {
  return dateInTimezone(now, timezone);
}

/**
 * Find the first instant belonging to a local date. A binary search avoids
 * assuming every day is 24 hours and handles midnight offset changes.
 */
export function startOfZonedDate(date: string, timezone: string): number {
  if (!isDateKey(date)) throw new RangeError(`Invalid calendar date: ${date}`);
  const center = Date.parse(`${date}T00:00:00Z`);
  let low = center - 36 * 3_600_000;
  let high = center + 36 * 3_600_000;
  const isOnOrAfterDate = (instant: number) => dateInTimezone(instant, timezone) >= date;
  if (isOnOrAfterDate(low) || !isOnOrAfterDate(high))
    throw new RangeError(`Unable to resolve ${date} in ${timezone}`);
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (isOnOrAfterDate(middle)) high = middle;
    else low = middle;
  }
  return high;
}

export function zonedDateBounds(date: string, timezone: string): { start: number; end: number } {
  return {
    start: startOfZonedDate(date, timezone),
    end: startOfZonedDate(addCalendarDays(date, 1), timezone),
  };
}

export function visibleDateRange(
  view: CalendarView,
  anchor: string,
  weekStart: CalendarWeekStart,
): { startDate: string; endDate: string } {
  if (!isDateKey(anchor)) throw new RangeError(`Invalid calendar date: ${anchor}`);
  if (view === 'week') {
    const startDate = startOfWeek(anchor, weekStart);
    return { startDate, endDate: addCalendarDays(startDate, 7) };
  }
  if (view === 'day') return { startDate: anchor, endDate: addCalendarDays(anchor, 1) };
  if (view === 'list') {
    const startDate = `${anchor.slice(0, 7)}-01`;
    const lastDay = new Date(
      Date.UTC(Number(anchor.slice(0, 4)), Number(anchor.slice(5, 7)), 0),
    ).getUTCDate();
    return { startDate, endDate: addCalendarDays(`${anchor.slice(0, 7)}-${lastDay}`, 1) };
  }
  const rows = monthGrid(anchor, weekStart);
  return { startDate: rows[0]![0]!, endDate: addCalendarDays(rows[rows.length - 1]![6]!, 1) };
}

export function requestRange(
  view: CalendarView,
  anchor: string,
  weekStart: CalendarWeekStart,
  timezone: string,
): { from: number; to: number } {
  const dates = visibleDateRange(view, anchor, weekStart);
  const from = startOfZonedDate(dates.startDate, timezone);
  const to = startOfZonedDate(dates.endDate, timezone);
  if (to <= from || to - from > MAX_RANGE_MS)
    throw new RangeError('Calendar range must be a positive interval of at most 93 days.');
  return { from, to };
}

export function zonedTime(at: number, timezone: string, locale = 'en'): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(at));
}

export function zonedHourLabels(
  date: string,
  timezone: string,
  hourHeight = 56,
): Array<{ top: number; text: string }> {
  const bounds = zonedDateBounds(date, timezone);
  const count = Math.ceil((bounds.end - bounds.start) / 3_600_000);
  const labels = Array.from({ length: count }, (_, hour) => {
    const at = bounds.start + hour * 3_600_000;
    return { at, top: hour * hourHeight, text: zonedTime(at, timezone) };
  });
  const frequencies = new Map<string, number>();
  for (const item of labels) frequencies.set(item.text, (frequencies.get(item.text) ?? 0) + 1);
  return labels.map(({ at, top, text }) => {
    if ((frequencies.get(text) ?? 0) < 2) return { top, text };
    const zone = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'short' })
      .formatToParts(new Date(at))
      .find((part) => part.type === 'timeZoneName')?.value;
    return { top, text: zone ? `${text} ${zone}` : text };
  });
}

export function formatDateKey(
  date: string,
  locale = 'en',
  options: Intl.DateTimeFormatOptions = {},
) {
  if (!isDateKey(date)) return date;
  return new Intl.DateTimeFormat(locale, { timeZone: 'UTC', ...options }).format(
    new Date(`${date}T12:00:00Z`),
  );
}

export function itemOccursOnDate(item: CalendarItem, date: string, timezone: string): boolean {
  if (item.allDay && item.startDate && item.endDate)
    return item.startDate <= date && date < item.endDate;
  const { start, end } = zonedDateBounds(date, timezone);
  return item.type === 'schedule'
    ? item.startAt >= start && item.startAt < end
    : item.startAt < end && item.endAt > start;
}

export interface TimedSegment {
  item: CalendarItem;
  startAt: number;
  endAt: number;
  lane: number;
  laneCount: number;
  visualEndAt: number;
}

/**
 * Assign adjacent lanes to visually intersecting entries. Schedule entries
 * stay point triggers; visualEndAt is used only to keep their compact chips
 * from covering a nearby chip and is never shown as a task duration.
 */
export function timedSegmentsForDate(
  items: CalendarItem[],
  date: string,
  timezone: string,
  triggerLaneMinutes = 28,
): TimedSegment[] {
  const { start, end } = zonedDateBounds(date, timezone);
  const segments = items
    .flatMap((item) => {
      if (item.allDay || !itemOccursOnDate(item, date, timezone)) return [];
      const startAt = item.type === 'schedule' ? item.startAt : Math.max(item.startAt, start);
      const eventEnd = item.type === 'schedule' ? item.startAt : Math.min(item.endAt, end);
      const visualEndAt =
        item.type === 'schedule'
          ? Math.min(end, item.startAt + triggerLaneMinutes * 60_000)
          : eventEnd;
      return [
        {
          item,
          startAt,
          endAt: eventEnd,
          visualEndAt: Math.max(startAt + 1, visualEndAt),
          lane: 0,
          laneCount: 1,
        },
      ];
    })
    .sort(
      (a, b) =>
        a.startAt - b.startAt ||
        a.visualEndAt - b.visualEndAt ||
        a.item.id.localeCompare(b.item.id),
    );

  let cluster: typeof segments = [];
  let clusterEnd = -Infinity;
  const flush = () => {
    if (!cluster.length) return;
    const laneEnds: number[] = [];
    for (const segment of cluster) {
      let lane = laneEnds.findIndex((laneEnd) => laneEnd <= segment.startAt);
      if (lane < 0) lane = laneEnds.length;
      laneEnds[lane] = segment.visualEndAt;
      segment.lane = lane;
    }
    for (const segment of cluster) segment.laneCount = laneEnds.length;
    cluster = [];
    clusterEnd = -Infinity;
  };
  for (const segment of segments) {
    if (segment.startAt >= clusterEnd) flush();
    cluster.push(segment);
    clusterEnd = Math.max(clusterEnd, segment.visualEndAt);
  }
  flush();
  return segments;
}

export interface AllDayBar {
  item: CalendarItem;
  startColumn: number;
  endColumn: number;
  lane: number;
}

export function allDayBarsForWeek(items: CalendarItem[], weekStartDate: string): AllDayBar[] {
  const weekEnd = addCalendarDays(weekStartDate, 7);
  const candidates = items
    .flatMap((item) => {
      if (!item.allDay || !item.startDate || !item.endDate) return [];
      if (item.startDate >= weekEnd || item.endDate <= weekStartDate) return [];
      return [
        {
          item,
          startColumn: Math.max(
            0,
            Math.round(
              (Date.parse(`${item.startDate}T00:00:00Z`) -
                Date.parse(`${weekStartDate}T00:00:00Z`)) /
                DAY_MS,
            ),
          ),
          endColumn: Math.min(
            7,
            Math.round(
              (Date.parse(`${item.endDate}T00:00:00Z`) - Date.parse(`${weekStartDate}T00:00:00Z`)) /
                DAY_MS,
            ),
          ),
          lane: 0,
        },
      ];
    })
    .sort(
      (a, b) =>
        a.startColumn - b.startColumn ||
        b.endColumn - a.endColumn ||
        a.item.id.localeCompare(b.item.id),
    );
  const laneEnds: number[] = [];
  for (const bar of candidates) {
    let lane = laneEnds.findIndex((end) => end <= bar.startColumn);
    if (lane < 0) lane = laneEnds.length;
    laneEnds[lane] = bar.endColumn;
    bar.lane = lane;
  }
  return candidates;
}

export function allDayBarsForDate(
  items: CalendarItem[],
  weekStartDate: string,
  date: string,
): AllDayBar[] {
  if (!isDateKey(weekStartDate) || !isDateKey(date))
    throw new RangeError('All-day layout requires valid calendar dates.');
  const dayColumn = Math.round(
    (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${weekStartDate}T00:00:00Z`)) / DAY_MS,
  );
  if (dayColumn < 0 || dayColumn >= 7) return [];
  return allDayBarsForWeek(items, weekStartDate)
    .filter((bar) => bar.startColumn <= dayColumn && bar.endColumn > dayColumn)
    .map((bar) => ({ ...bar, startColumn: 0, endColumn: 1 }));
}

const noStore = <T>(path: string, init: RequestInit = {}) =>
  request<T>(path, { cache: 'no-store', ...init });
const send = <T>(method: string, path: string, body?: unknown, signal?: AbortSignal) =>
  noStore<T>(path, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(signal ? { signal } : {}),
  });
const part = encodeURIComponent;

export const calendarApi = {
  context: (signal?: AbortSignal) =>
    noStore<CalendarContext>('/api/calendar/context', signal ? { signal } : {}),
  range: (
    input: { from: number; to: number; timezone: string; cursor?: string },
    signal?: AbortSignal,
  ) => {
    const query = new URLSearchParams({
      from: String(input.from),
      to: String(input.to),
      timezone: input.timezone,
    });
    if (input.cursor) query.set('cursor', input.cursor);
    return noStore<CalendarRangeResponse>(`/api/calendar?${query}`, signal ? { signal } : {});
  },
  event: (id: string, signal?: AbortSignal) =>
    noStore<{ event: CalendarEvent }>(`/api/calendar/events/${part(id)}`, signal ? { signal } : {}),
  permissions: (signal?: AbortSignal) =>
    noStore<CalendarPermissions>('/api/calendar/permissions', signal ? { signal } : {}),
  setPermissions: (permissions: CalendarPermissions) =>
    send<CalendarPermissions>('PATCH', '/api/calendar/permissions', permissions),
  create: async (idempotencyKey: string, event: CalendarEventSpec) =>
    (
      await send<{ event: CalendarEvent }>('POST', '/api/calendar/events', {
        idempotencyKey,
        event,
      })
    ).event,
  update: async (id: string, change: CalendarEditRequest) =>
    (await send<{ event: CalendarEvent }>('PATCH', `/api/calendar/events/${part(id)}`, change))
      .event,
  remove: (id: string, revision: number, scope: CalendarEditScope, occurrence?: string) =>
    send<void>('DELETE', `/api/calendar/events/${part(id)}`, {
      revision,
      scope,
      ...(occurrence ? { occurrence } : {}),
    }),
};
