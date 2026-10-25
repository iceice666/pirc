// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import { app } from '../app.svelte';
import { i18n } from '../i18n.svelte';
import type { CalendarEvent, CalendarRangeResponse } from '../calendar';
import SchedulesPage from './SchedulesPage.svelte';

const fixture = {
  ...JSON.parse(
    readFileSync(resolve(process.cwd(), '../../fixtures/mobile-parity/calendar.json'), 'utf8'),
  ),
  accountKey: 'test-account-a',
} as CalendarRangeResponse;
const preferenceKey = (account: string) =>
  `pirc.calendar.preferences.v1:${encodeURIComponent(account)}`;
const response = (value: unknown, status = 200) =>
  new Response(value === undefined ? null : JSON.stringify(value), { status });

let component: ReturnType<typeof mount> | undefined;
let target: HTMLDivElement;
let calls: Array<{ url: string; method: string; body?: any; signal?: AbortSignal }>;
let contextResponse: { accountKey: string; reminderDeliveryAvailable: boolean };
let testStorage: Storage;

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, String(value));
    },
  } as Storage;
}

async function flush() {
  for (let index = 0; index < 12; index++) {
    await Promise.resolve();
    await tick();
  }
}

function button(label: string) {
  return Array.from(target.querySelectorAll<HTMLButtonElement>('button')).find(
    (item) => item.textContent?.trim() === label,
  )!;
}

async function click(label: string) {
  button(label).click();
  await flush();
}

function field(label: string) {
  return Array.from(target.querySelectorAll('label'))
    .find((item) => item.querySelector('span')?.textContent === label)
    ?.querySelector<HTMLInputElement>('input')!;
}

async function enter(label: string, value: string) {
  const input = field(label);
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await flush();
}

async function choose(label: string, value: string) {
  const select = Array.from(target.querySelectorAll<HTMLLabelElement>('label.field'))
    .find((item) => item.querySelector('span')?.textContent === label)
    ?.querySelector<HTMLSelectElement>('select')!;
  select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await flush();
}

function pointer(target: Element, type: 'pointerdown' | 'pointerup', id: number, y: number) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerId: { value: id },
    pointerType: { value: 'mouse' },
    button: { value: 0 },
    clientX: { value: 120 },
    clientY: { value: y },
  });
  target.dispatchEvent(event);
}

function mountPage() {
  target = document.createElement('div');
  document.body.append(target);
  component = mount(SchedulesPage, {
    target,
    props: { onopenchat: vi.fn() },
  });
}

function setFetch(handler: (url: string, init: RequestInit) => Promise<Response>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      calls.push({
        url,
        method,
        ...(init.body ? { body: JSON.parse(String(init.body)) } : {}),
        ...(init.signal ? { signal: init.signal as AbortSignal } : {}),
      });
      if (url === '/api/calendar/context' && method === 'GET') return response(contextResponse);
      return handler(url, init);
    }),
  );
}

beforeEach(() => {
  calls = [];
  app.loading = false;
  app.demo = undefined;
  app.view = 'schedules';
  app.calendarFocus = undefined;
  app.calendarNavigationRevision = 0;
  app.scheduleFocus = undefined;
  app.scheduleRevision = 0;
  contextResponse = { accountKey: 'test-account-a', reminderDeliveryAvailable: true };
  i18n.setLanguage('en');
  testStorage = memoryStorage();
  vi.stubGlobal('localStorage', testStorage);
  testStorage.setItem(
    preferenceKey('test-account-a'),
    JSON.stringify({
      view: 'month',
      timezone: 'Asia/Taipei',
      weekStart: 'monday',
    }),
  );
  history.replaceState({}, '', '/?open=calendar&view=month&date=2026-10-21');
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value() {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value() {
      this.open = false;
      this.dispatchEvent(new Event('close'));
    },
  });
});

afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  target?.remove();
  app.loading = true;
  app.calendarFocus = undefined;
  app.calendarNavigationRevision = 0;
  app.scheduleFocus = undefined;
  app.view = 'session';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Calendar page', () => {
  it('opens a moved reminder on its effective date and keeps the original occurrence identity', async () => {
    const movedStartAt = Date.parse('2026-10-31T17:00:00Z');
    setFetch(async (url) =>
      url.startsWith('/api/calendar?')
        ? response(fixture)
        : response({ error: { message: `Unexpected request ${url}` } }, 404),
    );
    app.showCalendar('trip', '2026-10-22T09:00', '2026-11-01', movedStartAt);

    mountPage();
    await flush();

    const route = new URL(location.href);
    expect(route.searchParams.get('view')).toBe('day');
    expect(route.searchParams.get('date')).toBe('2026-11-01');
    expect(route.searchParams.get('item')).toBe('event:trip:2026-10-22T09:00');
    expect(target.querySelector('.period-title')?.textContent).toContain('November 1, 2026');
    const rangeRequest = calls.find((call) => call.url.startsWith('/api/calendar?'))!;
    const range = new URL(rangeRequest.url, 'http://calendar.test').searchParams;
    expect(range.get('from')).toBe(String(Date.parse('2026-10-31T16:00:00Z')));
  });

  it('returns from schedule management to the Calendar and clears management route state', async () => {
    setFetch(async (url) => {
      if (url.startsWith('/api/calendar?')) return response(fixture);
      if (url === '/api/schedules') return response({ schedules: [], timezone: 'UTC' });
      if (url === '/api/models') return response({ models: [] });
      return response({ error: { message: `Unexpected request ${url}` } }, 404);
    });

    mountPage();
    await flush();
    await click('Manage schedules');
    expect(target.querySelector('.schedule-management')).not.toBeNull();
    expect(new URL(location.href).searchParams.get('manage')).toBe('schedules');

    app.showCalendar();
    await flush();

    expect(target.querySelector('.schedule-management')).toBeNull();
    expect(target.querySelector('.list-view')).not.toBeNull();
    const route = new URL(location.href);
    expect(route.searchParams.get('open')).toBe('calendar');
    expect(route.searchParams.has('manage')).toBe(false);
    expect(route.searchParams.has('schedule')).toBe(false);
    expect(route.searchParams.has('item')).toBe(false);
  });

  it('keeps an ambiguous create draft and reuses its idempotency key when retried', async () => {
    let rejectFirstCreate = true;
    const created = {
      ...(fixture.items[0]!.event as CalendarEvent),
      id: 'created-event',
      revision: 1,
    };
    setFetch(async (url, init) => {
      if (url.startsWith('/api/calendar?')) return response(fixture);
      if (url === '/api/calendar/events' && init.method === 'POST') {
        if (rejectFirstCreate) {
          rejectFirstCreate = false;
          return response(
            { error: { code: 'temporarily_unavailable', message: 'Try again' } },
            503,
          );
        }
        return response({ event: created }, 201);
      }
      return response({ error: { message: 'Unexpected request' } }, 404);
    });

    mountPage();
    await flush();
    expect(target.textContent).toContain('Design review');
    await click('New event');
    await enter('Title', 'Follow-up');
    target.querySelector<HTMLFormElement>('.event-editor-form')!.requestSubmit();
    await flush();
    expect(target.querySelector('[role="alert"]')?.textContent).toContain('request key are kept');
    expect(target.querySelector('.event-editor-form')).not.toBeNull();

    target.querySelector<HTMLFormElement>('.event-editor-form')!.requestSubmit();
    await flush();
    const attempts = calls.filter(
      (call) => call.url === '/api/calendar/events' && call.method === 'POST',
    );
    expect(attempts).toHaveLength(2);
    expect(attempts[0]!.body.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i);
    expect(attempts[1]!.body.idempotencyKey).toBe(attempts[0]!.body.idempotencyKey);
    expect(attempts[1]!.body.event).toMatchObject({ title: 'Follow-up', timezone: 'Asia/Taipei' });
    expect(target.querySelector('.event-editor-form')).toBeNull();
  });

  it('shows and saves both recurrence end date and occurrence count', async () => {
    setFetch(async (url, init) => {
      if (url.startsWith('/api/calendar?')) return response(fixture);
      if (url === '/api/calendar/events' && init.method === 'POST') {
        const event = JSON.parse(String(init.body)).event as CalendarEvent;
        return response(
          {
            event: {
              ...event,
              id: `saved-${calls.length}`,
              revision: 1,
              createdAt: 1,
              updatedAt: 1,
            },
          },
          201,
        );
      }
      return response({ error: { message: `Unexpected request ${url}` } }, 404);
    });

    mountPage();
    await flush();
    await click('New event');
    await enter('Title', 'Date-limited series');
    await choose('Repeat', 'daily');
    await choose('End repeat', 'until');
    expect(field('Repeat until')).toBeTruthy();
    await enter('Repeat until', '2026-11-03');
    target.querySelector<HTMLFormElement>('.event-editor-form')!.requestSubmit();
    await flush();

    let saved = calls.filter(
      (call) => call.url === '/api/calendar/events' && call.method === 'POST',
    )[0]!;
    expect(saved.body.event.recurrence).toMatchObject({ frequency: 'daily', until: '2026-11-03' });
    expect(saved.body.event.recurrence).not.toHaveProperty('count');

    await click('New event');
    await enter('Title', 'Count-limited series');
    await choose('Repeat', 'weekly');
    await choose('End repeat', 'count');
    expect(field('Number of occurrences').value).toBe('1');
    await enter('Number of occurrences', '4');
    target.querySelector<HTMLFormElement>('.event-editor-form')!.requestSubmit();
    await flush();

    saved = calls.filter(
      (call) => call.url === '/api/calendar/events' && call.method === 'POST',
    )[1]!;
    expect(saved.body.event.recurrence).toMatchObject({ frequency: 'weekly', count: 4 });
    expect(saved.body.event.recurrence).not.toHaveProperty('until');
  });

  it('uses the projected revision when an occurrence projection is older than its detail', async () => {
    const projected = fixture.items.find((item) => item.sourceId === 'planning')!;
    const current = {
      ...(projected.event as CalendarEvent),
      revision: 2,
      start: '2026-10-21T09:45',
      end: '2026-10-21T11:15',
    };
    setFetch(async (url, init) => {
      if (url.startsWith('/api/calendar?')) return response(fixture);
      if (url === '/api/calendar/events/planning' && init.method === 'PATCH')
        return response(
          { error: { code: 'revision_conflict', message: 'Changed elsewhere' } },
          409,
        );
      if (url === '/api/calendar/events/planning') return response({ event: current });
      return response({ error: { message: `Unexpected request ${url}` } }, 404);
    });

    mountPage();
    await flush();
    const planningButton = Array.from(
      target.querySelectorAll<HTMLButtonElement>('.month-item'),
    ).find((item) => item.textContent?.includes('Weekly planning'))!;
    planningButton.click();
    await flush();
    expect(target.querySelector('.detail-title')?.textContent).toContain('Weekly planning');
    await click('Edit');
    await choose('Apply to', 'occurrence');
    target.querySelector<HTMLFormElement>('.event-editor-form')!.requestSubmit();
    await flush();

    const patch = calls.find(
      (call) => call.url === '/api/calendar/events/planning' && call.method === 'PATCH',
    )!;
    expect(patch.body.revision).toBe(projected.revision);
    expect(patch.body.revision).toBe(1);
    expect(patch.body.event.start).toBe('2026-10-21T09:30');
    expect(target.querySelector('.event-editor-form')).not.toBeNull();
    expect(target.querySelector('.conflict-card')?.textContent).toContain('Weekly planning');
  });

  it('paginates with the returned cursor and keeps the current page when the next page fails', async () => {
    let failNextPage = true;
    setFetch(async (url) => {
      if (url.startsWith('/api/calendar?')) {
        const query = new URLSearchParams(url.split('?')[1]);
        if (query.has('cursor') && failNextPage) {
          failNextPage = false;
          return response({ error: { message: 'Page unavailable' } }, 503);
        }
        return response({ ...fixture, nextCursor: 'cursor-1', limited: true });
      }
      return response({ error: { message: 'Unexpected request' } }, 404);
    });

    mountPage();
    await flush();
    await click('Load more');
    expect(target.querySelector('[role="alert"]')?.textContent).toContain('Page unavailable');
    expect(target.textContent).toContain('Design review');
    expect(
      calls.some(
        (call) => new URLSearchParams(call.url.split('?')[1]).get('cursor') === 'cursor-1',
      ),
    ).toBe(true);

    await click('Retry');
    const rangeCalls = calls.filter((call) => call.url.startsWith('/api/calendar?'));
    const lastRange = rangeCalls[rangeCalls.length - 1]!;
    expect(new URLSearchParams(lastRange.url.split('?')[1]).has('cursor')).toBe(false);
    expect(target.textContent).toContain('Design review');
  });

  it('keeps the last successful same-range entries visible when a schedule refresh fails', async () => {
    let rejectRefresh!: (value: Response) => void;
    let requestNumber = 0;
    setFetch(async (url) => {
      if (!url.startsWith('/api/calendar?'))
        return response({ error: { message: 'Unexpected request' } }, 404);
      requestNumber++;
      if (requestNumber === 1) return response(fixture);
      return new Promise<Response>((resolve) => {
        rejectRefresh = resolve;
      });
    });

    mountPage();
    await flush();
    expect(target.textContent).toContain('Design review');

    app.scheduleRevision++;
    await flush();
    expect(requestNumber).toBe(2);
    expect(target.textContent).toContain('Design review');
    expect(target.textContent).toContain('Syncing');

    rejectRefresh(response({ error: { message: 'Gateway temporarily unavailable' } }, 503));
    await flush();
    expect(target.textContent).toContain('Design review');
    expect(target.querySelector('[role="alert"]')?.textContent).toContain(
      'Gateway temporarily unavailable',
    );
  });

  it('keeps week-view move and resize changes as drafts until explicit save', async () => {
    history.replaceState({}, '', '/?open=calendar&view=week&date=2026-10-21');
    const recurring = fixture.items.find((item) => item.sourceId === 'planning')!
      .event as CalendarEvent;
    const ordinary = fixture.items.find((item) => item.sourceId === 'review')!
      .event as CalendarEvent;
    setFetch(async (url, init) => {
      if (url.startsWith('/api/calendar?')) return response(fixture);
      if (url === '/api/calendar/events/planning' && !init.method)
        return response({ event: recurring });
      if (url === '/api/calendar/events/review' && !init.method)
        return response({ event: ordinary });
      if (init.method === 'PATCH') return response({ event: recurring });
      return response({ error: { message: 'Unexpected request' } }, 404);
    });

    mountPage();
    await flush();
    const review = Array.from(target.querySelectorAll<HTMLButtonElement>('.time-entry')).find(
      (item) => item.textContent?.includes('Design review'),
    )!;
    const reviewTop = Number.parseFloat(review.style.top);
    vi.spyOn(review, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: reviewTop,
      top: reviewTop,
      right: 100,
      bottom: reviewTop + 84,
      left: 0,
      width: 100,
      height: 84,
      toJSON: () => ({}),
    });
    vi.spyOn(review.closest('.time-day-column')!, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      right: 100,
      bottom: 1344,
      left: 0,
      width: 100,
      height: 1344,
      toJSON: () => ({}),
    });
    pointer(review.querySelector('.resize-handle')!, 'pointerdown', 1, reviewTop + 80);
    pointer(review, 'pointerup', 1, reviewTop + 136);
    await flush();
    expect(field('End time').value).toBe('11:30');
    expect(target.textContent).toContain('The resized time is a draft. Save changes to apply it.');
    expect(calls.some((call) => call.method === 'PATCH')).toBe(false);
    await click('Cancel');

    const planning = Array.from(target.querySelectorAll<HTMLButtonElement>('.time-entry')).find(
      (item) => item.textContent?.includes('Weekly planning'),
    )!;
    const planningTop = Number.parseFloat(planning.style.top);
    vi.spyOn(planning, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: planningTop,
      top: planningTop,
      right: 100,
      bottom: planningTop + 84,
      left: 0,
      width: 100,
      height: 84,
      toJSON: () => ({}),
    });
    vi.spyOn(planning.closest('.time-day-column')!, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      right: 100,
      bottom: 1344,
      left: 0,
      width: 100,
      height: 1344,
      toJSON: () => ({}),
    });
    pointer(planning, 'pointerdown', 2, planningTop + 10);
    pointer(planning, 'pointerup', 2, planningTop + 66);
    await flush();
    expect(field('Start time').value).toBe('10:30');
    expect(target.textContent).toContain('Choose the recurrence scope and save');
    expect(calls.some((call) => call.method === 'PATCH')).toBe(false);
    target.querySelector<HTMLFormElement>('.event-editor-form')!.requestSubmit();
    await flush();
    const patch = calls.find((call) => call.method === 'PATCH')!;
    expect(patch.body).toMatchObject({
      scope: 'occurrence',
      occurrence: '2026-10-21T09:30',
      event: { start: '2026-10-21T10:30', timezone: 'Asia/Taipei' },
    });
  });

  it('shows and refreshes the independent agent read and proposal permissions', async () => {
    let current = { allowRead: false, allowPropose: false };
    setFetch(async (url, init) => {
      if (url.startsWith('/api/calendar?')) return response(fixture);
      if (url === '/api/calendar/permissions' && init.method === 'PATCH') {
        current = JSON.parse(String(init.body));
        return response(current);
      }
      if (url === '/api/calendar/permissions') return response(current);
      return response({ error: { message: 'Unexpected request' } }, 404);
    });

    mountPage();
    await flush();
    await click('Agent access');
    const toggles = target.querySelectorAll<HTMLInputElement>('.permission-toggle input');
    expect(toggles).toHaveLength(2);
    toggles[0]!.checked = true;
    toggles[0]!.dispatchEvent(new Event('change', { bubbles: true }));
    toggles[1]!.checked = true;
    toggles[1]!.dispatchEvent(new Event('change', { bubbles: true }));
    await click('Save permissions');
    expect(current).toEqual({ allowRead: true, allowPropose: true });
    expect(
      calls.some((call) => call.url === '/api/calendar/permissions' && call.method === 'PATCH'),
    ).toBe(true);
    expect(
      calls.filter((call) => call.url === '/api/calendar/permissions' && call.method === 'GET')
        .length,
    ).toBeGreaterThanOrEqual(2);
    expect(target.querySelector('.permissions-form')).not.toBeNull();
    expect(
      Array.from(target.querySelectorAll<HTMLInputElement>('.permission-toggle input')).map(
        (input) => input.checked,
      ),
    ).toEqual([true, true]);
  });

  it('aborts and ignores a previous account response while a new account loads', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-21T04:00:00Z'));
    let resolveOld!: (value: Response) => void;
    let rangeNumber = 0;
    const newAccount = {
      ...fixture,
      accountKey: 'test-account-b',
      items: [{ ...fixture.items[0]!, id: 'event:new-account', title: 'Account B private event' }],
    };
    setFetch(async (url) => {
      if (!url.startsWith('/api/calendar?'))
        return response({ error: { message: 'Unexpected request' } }, 404);
      rangeNumber++;
      if (rangeNumber === 1)
        return new Promise<Response>((resolve) => {
          resolveOld = resolve;
        });
      return response(newAccount);
    });

    mountPage();
    await flush();
    expect(rangeNumber).toBe(1);
    const oldRequest = calls.find((call) => call.url.startsWith('/api/calendar?'))!;
    app.loading = true;
    await flush();
    expect(oldRequest.signal?.aborted).toBe(true);

    testStorage.setItem(
      preferenceKey('test-account-b'),
      JSON.stringify({
        view: 'week',
        timezone: 'UTC',
        weekStart: 'sunday',
      }),
    );
    app.workspaces = [
      { id: 'account-b:workspace', hostId: 'account-b', displayName: 'Account B' } as never,
    ];
    contextResponse = { accountKey: 'test-account-b', reminderDeliveryAvailable: false };
    app.loading = false;
    await flush();
    expect(target.textContent).toContain('Account B private event');
    expect((target.querySelector('.header-zone input') as HTMLInputElement).value).toBe('UTC');
    expect(target.querySelector('.view-tabs button[aria-pressed="true"]')?.textContent).toContain(
      'Week',
    );

    resolveOld(response(fixture));
    await flush();
    expect(target.textContent).toContain('Account B private event');
    expect(target.textContent).not.toContain('Design review');
  });
});
