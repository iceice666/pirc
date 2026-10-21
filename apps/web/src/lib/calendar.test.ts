import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  addCalendarDays,
  allDayBarsForDate,
  allDayBarsForWeek,
  calendarApi,
  monthGrid,
  requestRange,
  timedSegmentsForDate,
  visibleDateRange,
  zonedDateBounds,
  zonedHourLabels,
  type CalendarRangeResponse,
  type CalendarItem,
} from './calendar';

const eventItem = (
  id: string,
  startAt: number,
  endAt: number,
  extras: Partial<CalendarItem> = {},
): CalendarItem => ({
  id,
  type: 'event',
  sourceId: id,
  title: id,
  startAt,
  endAt,
  allDay: false,
  timezone: 'UTC',
  revision: 1,
  originalStart: new Date(startAt).toISOString().slice(0, 16),
  ...extras,
});

afterEach(() => vi.unstubAllGlobals());

it('builds month grids from the chosen week start, including leap days', () => {
  expect(monthGrid('2026-02-15', 'sunday')).toHaveLength(4);
  expect(monthGrid('2026-02-15', 'monday')).toEqual([
    [
      '2026-01-26',
      '2026-01-27',
      '2026-01-28',
      '2026-01-29',
      '2026-01-30',
      '2026-01-31',
      '2026-02-01',
    ],
    [
      '2026-02-02',
      '2026-02-03',
      '2026-02-04',
      '2026-02-05',
      '2026-02-06',
      '2026-02-07',
      '2026-02-08',
    ],
    [
      '2026-02-09',
      '2026-02-10',
      '2026-02-11',
      '2026-02-12',
      '2026-02-13',
      '2026-02-14',
      '2026-02-15',
    ],
    [
      '2026-02-16',
      '2026-02-17',
      '2026-02-18',
      '2026-02-19',
      '2026-02-20',
      '2026-02-21',
      '2026-02-22',
    ],
    [
      '2026-02-23',
      '2026-02-24',
      '2026-02-25',
      '2026-02-26',
      '2026-02-27',
      '2026-02-28',
      '2026-03-01',
    ],
  ]);
  expect(addCalendarDays('2024-02-28', 1)).toBe('2024-02-29');
});

it('requests local calendar days with 23 and 25 hours across DST', () => {
  const spring = zonedDateBounds('2026-03-08', 'America/Los_Angeles');
  const autumn = zonedDateBounds('2026-11-01', 'America/Los_Angeles');
  expect(spring.end - spring.start).toBe(23 * 3_600_000);
  expect(autumn.end - autumn.start).toBe(25 * 3_600_000);
  expect(requestRange('day', '2026-03-08', 'sunday', 'America/Los_Angeles')).toEqual({
    from: spring.start,
    to: spring.end,
  });
  expect(zonedHourLabels('2026-03-08', 'America/Los_Angeles')).toHaveLength(23);
  expect(
    zonedHourLabels('2026-11-01', 'America/Los_Angeles')
      .filter(({ text }) => text.startsWith('01:00'))
      .map(({ text }) => text),
  ).toEqual(['01:00 PDT', '01:00 PST']);
});

it('keeps visible requests below the 93 day limit and uses half-open local dates', () => {
  expect(visibleDateRange('week', '2026-10-21', 'monday')).toEqual({
    startDate: '2026-10-19',
    endDate: '2026-10-26',
  });
  expect(requestRange('month', '2026-10-21', 'monday', 'Asia/Taipei').to).toBeGreaterThan(
    requestRange('month', '2026-10-21', 'monday', 'Asia/Taipei').from,
  );
});

it('allocates separate lanes for overlapping entries without changing trigger instants', () => {
  const zone = 'UTC';
  const dayStart = Date.parse('2026-10-21T00:00:00Z');
  const scheduled: CalendarItem = {
    ...eventItem('job', dayStart + 10 * 3_600_000, dayStart + 10 * 3_600_000),
    type: 'schedule',
  };
  const segments = timedSegmentsForDate(
    [
      eventItem('a', dayStart + 9 * 3_600_000, dayStart + 11 * 3_600_000),
      scheduled,
      eventItem('b', dayStart + 10 * 3_600_000, dayStart + 12 * 3_600_000),
    ],
    '2026-10-21',
    zone,
  );
  expect(segments.map(({ laneCount }) => laneCount)).toEqual([3, 3, 3]);
  expect(segments.find(({ item }) => item.id === 'job')?.startAt).toBe(scheduled.startAt);
  expect(segments.find(({ item }) => item.id === 'job')?.endAt).toBe(scheduled.startAt);
});

it('clips multi-day all-day bars at a week boundary and keeps overlaps in separate lanes', () => {
  const first = eventItem('first', 0, 0, {
    allDay: true,
    startDate: '2026-10-31',
    endDate: '2026-11-03',
  });
  const second = eventItem('second', 0, 0, {
    allDay: true,
    startDate: '2026-11-01',
    endDate: '2026-11-02',
  });
  expect(allDayBarsForWeek([first, second], '2026-11-01')).toEqual([
    { item: first, startColumn: 0, endColumn: 2, lane: 0 },
    { item: second, startColumn: 0, endColumn: 1, lane: 1 },
  ]);
});

it('shows a multi-day all-day event on its selected day in the day timeline', () => {
  const retreat = eventItem('retreat', 0, 0, {
    allDay: true,
    startDate: '2026-10-20',
    endDate: '2026-10-23',
  });
  expect(allDayBarsForDate([retreat], '2026-10-19', '2026-10-21')).toEqual([
    { item: retreat, startColumn: 0, endColumn: 1, lane: 0 },
  ]);
  expect(allDayBarsForDate([retreat], '2026-10-19', '2026-10-23')).toEqual([]);
});

it('lays out the shared Taipei projection without turning a trigger into a duration', () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL('../../../../fixtures/mobile-parity/calendar.json', import.meta.url),
      'utf8',
    ),
  ) as CalendarRangeResponse;
  const date = '2026-10-21';
  const timed = timedSegmentsForDate(fixture.items, date, fixture.timezone);
  const overlapping = timed.filter(({ item }) => item.type === 'event');
  const trigger = timed.find(({ item }) => item.type === 'schedule')!;

  expect(overlapping.map(({ laneCount }) => laneCount)).toEqual([2, 2]);
  expect(trigger.startAt).toBe(Date.parse('2026-10-21T11:00:00+08:00'));
  expect(trigger.endAt).toBe(trigger.startAt);
  expect(
    allDayBarsForWeek(fixture.items, '2026-10-18').map(({ startColumn, endColumn }) => [
      startColumn,
      endColumn,
    ]),
  ).toEqual([[2, 5]]);
});

it('sends real range and event mutations with the calendar contract', async () => {
  const contextFetch = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(
        JSON.stringify({ accountKey: 'opaque-account-key', reminderDeliveryAvailable: false }),
      ),
  );
  vi.stubGlobal('fetch', contextFetch);
  expect(await calendarApi.context()).toEqual({
    accountKey: 'opaque-account-key',
    reminderDeliveryAvailable: false,
  });
  expect(contextFetch.mock.calls[0]?.[0]).toBe('/api/calendar/context');

  const fetch = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          accountKey: 'opaque-account-key',
          items: [],
          from: 1,
          to: 2,
          timezone: 'UTC',
          limited: false,
          nextCursor: null,
          historyLimited: true,
        }),
      ),
  );
  vi.stubGlobal('fetch', fetch);
  await calendarApi.range({ from: 1, to: 2, timezone: 'UTC', cursor: 'next page' });
  const [url, init] = fetch.mock.calls[0]!;
  expect(url).toBe('/api/calendar?from=1&to=2&timezone=UTC&cursor=next+page');
  expect(init?.cache).toBe('no-store');

  const createFetch = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ event: { id: 'e1' } }), { status: 201 }),
  );
  vi.stubGlobal('fetch', createFetch);
  await calendarApi.create('stable-key', {
    title: 'Meet',
    description: '',
    location: '',
    start: '2026-10-21T10:00',
    end: '2026-10-21T11:00',
    timezone: 'UTC',
    allDay: false,
    recurrence: null,
    reminderMinutes: [],
  });
  const createBody = JSON.parse(String(createFetch.mock.calls[0]?.[1]?.body));
  expect(createBody.idempotencyKey).toBe('stable-key');
  expect(createBody.event.start).toBe('2026-10-21T10:00');

  const permissionFetch = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ allowRead: true, allowPropose: false })),
  );
  vi.stubGlobal('fetch', permissionFetch);
  await calendarApi.permissions();
  expect(permissionFetch.mock.calls[0]?.[0]).toBe('/api/calendar/permissions');
  await calendarApi.setPermissions({ allowRead: false, allowPropose: true });
  expect(permissionFetch.mock.calls[1]?.[1]?.method).toBe('PATCH');
  expect(JSON.parse(String(permissionFetch.mock.calls[1]?.[1]?.body))).toEqual({
    allowRead: false,
    allowPropose: true,
  });
});
