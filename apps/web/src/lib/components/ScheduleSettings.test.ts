// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import ScheduleSettings from './ScheduleSettings.svelte';
import { app } from '../app.svelte';
import type { Schedule, ScheduleRun } from '../schedules';
import type { Workspace } from '../types';

let component: ReturnType<typeof mount> | undefined;
let target: HTMLDivElement;
let schedules: Schedule[];
let runs: ScheduleRun[];
let calls: Array<{ url: string; method: string; body: any }>;
let failNext: { status: number; message: string } | undefined;

const response = (value: unknown, status = 200) =>
  new Response(value === undefined ? null : JSON.stringify(value), { status });
async function flush() {
  for (let i = 0; i < 12; i++) {
    await Promise.resolve();
    await tick();
  }
}
const buttons = () => Array.from(target.querySelectorAll<HTMLButtonElement>('button'));
const button = (text: string) => buttons().find((item) => item.textContent?.trim() === text)!;
async function click(text: string) {
  button(text).click();
  await flush();
}
function field(label: string) {
  return Array.from(target.querySelectorAll('label'))
    .find((item) => item.querySelector('span')?.textContent === label)
    ?.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
      'input, select, textarea',
    )!;
}
async function input(label: string, value: string) {
  const element = field(label);
  element.value = value;
  element.dispatchEvent(
    new Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }),
  );
  await flush();
}

const workspace = (id: string, displayName: string): Workspace => ({
  id,
  hostId: id.split(':')[0]!,
  displayName,
  defaults: {},
});

function schedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 's1',
    title: 'CI check',
    prompt: 'Check the CI dashboard.',
    workspaceId: 'work:test',
    workspace: { id: 'work:test', name: 'Test', kind: 'directory', node: 'work', online: true },
    cron: '0 9 * * 1-5',
    runAt: null,
    timezone: 'Asia/Taipei',
    model: null,
    thinking: null,
    status: 'active',
    nextRunAt: Date.now() + 3 * 3_600_000,
    createdBySession: null,
    lastRun: null,
    attention: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

async function setup(props: Record<string, unknown> = {}) {
  target = document.createElement('div');
  document.body.append(target);
  component = mount(ScheduleSettings, { target, props });
  await flush();
}

beforeEach(() => {
  app.workspaces = [workspace('work:test', 'Test'), workspace('home:chats', 'Chats')];
  app.scheduleAttention = 0;
  schedules = [schedule()];
  runs = [];
  calls = [];
  failNext = undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });
      if (failNext && method !== 'GET') {
        const failure = failNext;
        failNext = undefined;
        return response(
          { error: { code: 'invalid_input', message: failure.message } },
          failure.status,
        );
      }
      if (url === '/api/models')
        return response({ models: [{ provider: 'gw', id: 'model-a', name: 'Model A' }] });
      if (url === '/api/schedules' && method === 'GET')
        return response({ schedules, timezone: 'UTC' });
      if (url === '/api/schedules' && method === 'POST')
        return response({ schedule: schedule({ id: 's2' }) }, 201);
      if (/^\/api\/schedules\/[^/]+$/.test(url) && method === 'GET')
        return response({ schedule: schedules[0], runs });
      if (method === 'DELETE') return response(undefined, 204);
      if (url.endsWith('/run')) return response({ run: { id: 'r9', status: 'running' } }, 202);
      if (url.endsWith('/dismiss')) return response({ run: { id: 'r1', status: 'dismissed' } });
      return response({ schedule: schedules[0] });
    }),
  );
});

afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  target?.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ScheduleSettings', () => {
  it('lists schedules in words and counts the runs waiting for you', async () => {
    schedules = [
      schedule({
        attention: 2,
        model: { provider: 'gw', id: 'model-a' },
        createdBySession: 'chat-1',
      }),
    ];
    await setup();
    const text = target.textContent!;
    expect(text).toContain('CI check');
    expect(text).toContain('Weekdays at 09:00 (Asia/Taipei)');
    expect(text).toContain('Test · work · model-a');
    expect(text).toContain('2 waiting for you');
    expect(text).toContain('proposed by your assistant');
    expect(app.scheduleAttention).toBe(2);
  });

  it('says what demo mode cannot do and asks nothing', async () => {
    await setup({ disabled: true });
    expect(target.textContent).toContain('unavailable in demo mode');
    expect(calls).toEqual([]);
  });

  it('creates a schedule in the device time zone', async () => {
    await setup();
    await click('New schedule');
    await flush();
    expect(field('Time zone').value).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    await input('Title', 'Nightly');
    await input('Prompt', 'Run the tests.');
    await click('Weekdays at 09:00');
    await input('Model', JSON.stringify(['gw', 'model-a']));
    await input('Thinking', 'high');
    target.querySelector('form')!.requestSubmit();
    await flush();
    const created = calls.find((call) => call.method === 'POST')!;
    expect(created.url).toBe('/api/schedules');
    expect(created.body).toEqual({
      workspaceId: 'home:chats',
      title: 'Nightly',
      prompt: 'Run the tests.',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      model: { provider: 'gw', id: 'model-a' },
      thinking: 'high',
      cron: '0 9 * * 1-5',
    });
    // The form closes and the list reloads.
    expect(target.querySelector('form')).toBeNull();
  });

  it('shows why the gateway refused a schedule and keeps the form', async () => {
    await setup();
    await click('New schedule');
    await input('Prompt', 'x');
    const radio = target.querySelector<HTMLInputElement>('input[type="radio"][value="once"]')!;
    radio.click();
    flushSync();
    await flush();
    await input('Time', '2020-01-01T09:00');
    failNext = { status: 400, message: '2020-01-01 09:00 (UTC) is in the past' };
    target.querySelector('form')!.requestSubmit();
    await flush();
    expect(calls.find((call) => call.method === 'POST')!.body).toMatchObject({
      at: '2020-01-01T09:00',
    });
    expect(target.querySelector('[role="alert"]')?.textContent).toContain('is in the past');
    expect(target.querySelector('form')).not.toBeNull();
  });

  it('edits, pauses and deletes after a second click', async () => {
    await setup();
    await click('Edit');
    expect(field('Prompt').value).toBe('Check the CI dashboard.');
    expect(field('Cron (minute hour day month weekday)').value).toBe('0 9 * * 1-5');
    await input('Cron (minute hour day month weekday)', '0 10 * * *');
    target.querySelector('form')!.requestSubmit();
    await flush();
    expect(calls.find((call) => call.method === 'PATCH')).toMatchObject({
      url: '/api/schedules/s1',
      body: { cron: '0 10 * * *', timezone: 'Asia/Taipei', model: null, thinking: null },
    });

    await click('Pause');
    const patches = calls.filter((call) => call.method === 'PATCH');
    expect(patches[patches.length - 1]!.body).toEqual({
      status: 'paused',
    });

    await click('Delete');
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
    await click('Delete for good');
    expect(calls.find((call) => call.method === 'DELETE')!.url).toBe('/api/schedules/s1');
  });

  it('shows runs, allows or dismisses missed ones, and opens a run session', async () => {
    runs = [
      {
        id: 'r2',
        scheduleId: 's1',
        dueAt: Date.parse('2026-09-30T01:00:00Z'),
        status: 'missed',
        sessionId: null,
        session: null,
        result: 'work was offline. Allow the run to start it now.',
        startedAt: null,
        finishedAt: null,
        createdAt: Date.now(),
      },
      {
        id: 'r1',
        scheduleId: 's1',
        dueAt: Date.parse('2026-09-29T01:00:00Z'),
        status: 'completed',
        sessionId: 'sess-1',
        session: 'CI check',
        result: 'All green.',
        startedAt: 1,
        finishedAt: 2,
        createdAt: Date.now() - 86_400_000,
      },
    ];
    const onopenchat = vi.fn();
    await setup({ onopenchat });
    await click('Runs');
    const text = target.textContent!;
    expect(text).toContain('Missed');
    expect(text).toContain('due 2026-09-30 09:00');
    expect(text).toContain('All green.');

    await click('Allow and run now');
    expect(calls.find((call) => call.url === '/api/schedules/s1/run')!.body).toEqual({
      runId: 'r2',
    });
    await click('Dismiss');
    expect(calls.some((call) => call.url === '/api/schedules/s1/runs/r2/dismiss')).toBe(true);
    await click('Open session');
    expect(onopenchat).toHaveBeenCalledWith('sess-1');
  });

  it('runs a schedule now, but not while its node is offline', async () => {
    schedules = [
      schedule(),
      schedule({
        id: 's2',
        title: 'Offline one',
        workspace: { id: 'lab:x', name: 'X', kind: 'directory', node: 'lab', online: false },
      }),
    ];
    await setup();
    const runNow = buttons().filter((item) => item.textContent?.trim() === 'Run now');
    expect(runNow.map((item) => item.disabled)).toEqual([false, true]);
    runNow[0]!.click();
    await flush();
    expect(calls.some((call) => call.url === '/api/schedules/s1/run')).toBe(true);
  });
});
