// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import { i18n } from '../i18n.svelte';
import { potsApi, type PotsOverview } from '../pots';
import PotsPage from './PotsPage.svelte';

let target: HTMLDivElement;
let component: ReturnType<typeof mount> | undefined;
let state: PotsOverview;
let calls: Array<{ url: string; init: RequestInit; body?: any }>;
let handler: (url: string, init: RequestInit) => Promise<Response>;
let open: ReturnType<typeof vi.fn>;
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const posts = () => calls.filter((call) => call.init.method === 'POST');
const button = (label: string) =>
  Array.from(target.querySelectorAll<HTMLButtonElement>('button')).find(
    (item) => item.textContent?.trim() === label,
  )!;
async function flush() {
  for (let i = 0; i < 15; i++) {
    await Promise.resolve();
    await tick();
  }
}
async function click(label: string) {
  button(label).click();
  await flush();
}
async function enter(label: string, value: string) {
  const field = Array.from(target.querySelectorAll('label'))
    .find((item) => item.querySelector('span')?.textContent === label)!
    .querySelector<HTMLInputElement | HTMLTextAreaElement>('input, textarea')!;
  field.value = value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  await flush();
}
async function draft() {
  await enter('Purpose', 'Watch blocked work');
  target.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
  await enter('Observation budget', '10');
  await enter('Dispatch budget (0 disables dispatch)', '0');
  await enter('Concurrency limit', '1');
}
async function mountPage() {
  target = document.createElement('div');
  document.body.append(target);
  component = mount(PotsPage, { target, props: { onopenchat: open } });
  await flush();
}

beforeEach(() => {
  i18n.setLanguage('en');
  calls = [];
  open = vi.fn();
  state = {
    actor: { kind: 'pots', id: 'personal' },
    accountKey: 'account-a',
    executionAvailable: false,
    observationMode: 'session_progress_events',
    workspaces: [{ id: 'w1', name: 'Workspace One' }],
    responsibilities: [
      {
        id: 'r1',
        ownerUser: 'a',
        revision: 4,
        generation: 7,
        purpose: 'Watch workspace',
        scopes: [{ workspaceId: 'w1', access: 'progress' }],
        budgets: { observations: 20, dispatches: 0, concurrency: 1 },
        enabled: false,
        observationPaused: false,
        coordinationPaused: true,
        observationsUsed: 0,
        dispatchesUsed: 0,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    suggestions: [
      {
        id: 's1',
        ownerUser: 'a',
        responsibilityId: 'r1',
        conditionKey: 'session_needs_input',
        occurrenceKey: 'o1',
        revision: 3,
        evidence: {
          workspaceId: 'w1',
          sessionId: 'session1',
          runnerEpoch: 2,
          interactionId: 'i1',
          expiresAt: Date.now() + 3600000,
        },
        action: 'review_session_input',
        targetSessionId: 'session1',
        disposition: 'pending',
        snoozedUntil: null,
        taskId: null,
        acceptedRevision: null,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    tasks: [
      {
        id: 't1',
        ownerUser: 'a',
        originSuggestionId: 's0',
        acceptedSuggestionRevision: 1,
        action: 'review_session_input',
        targetSessionId: 'session0',
        executionSessionId: null,
        status: 'tracked',
        revision: 2,
        controlGeneration: 5,
        coordinationPaused: true,
        takenOver: false,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  };
  handler = async (url, init) => {
    if (url === '/api/pots?limit=100' && !init.method) return response(state);
    return response({ error: { code: 'not_found', message: 'Unexpected request' } }, 404);
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
      return handler(url, init);
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

describe('pots tracking checkpoint', () => {
  it('reads without acceptance, caches nothing and never presents tracking as running', async () => {
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    await mountPage();
    expect(posts()).toHaveLength(0);
    expect(calls[0]!.init.cache).toBe('no-store');
    expect(calls[0]!.init.credentials).toBe('include');
    expect(storage).not.toHaveBeenCalled();
    expect(target.textContent).toContain('From pots');
    expect(target.textContent).toContain('No execution session. Tracking is not running.');
    expect(button('Start unavailable').disabled).toBe(true);
    await click('Review source conversation');
    expect(open).toHaveBeenCalledWith('session1');
    expect(posts()).toHaveLength(0);
  });

  it('requires explicit scopes and finite entered budgets, saves disabled and never auto-activates', async () => {
    await mountPage();
    expect(button('Save disabled responsibility').disabled).toBe(true);
    expect(target.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false);
    expect(
      Array.from(target.querySelectorAll<HTMLInputElement>('input[type="number"]')).every(
        (input) => input.value === '',
      ),
    ).toBe(true);
    await draft();
    await enter('Concurrency limit', '33');
    expect(button('Save disabled responsibility').disabled).toBe(true);
    await enter('Concurrency limit', '1');
    handler = async (url, init) =>
      init.method === 'POST'
        ? response({ responsibility: state.responsibilities[0] }, 201)
        : response(state);
    await click('Save disabled responsibility');
    expect(posts()).toHaveLength(1);
    expect(posts()[0]!.url).toBe('/api/pots/responsibilities');
    expect(posts()[0]!.body).toEqual({
      idempotencyKey: expect.any(String),
      purpose: 'Watch blocked work',
      scopes: [{ workspaceId: 'w1', access: 'progress' }],
      budgets: { observations: 10, dispatches: 0, concurrency: 1 },
    });
    expect(posts()[0]!.body).not.toHaveProperty('enabled');
  });

  it('sends activation with revision and generation, leaving coordination paused', async () => {
    await mountPage();
    handler = async (_url, init) => {
      if (init.method === 'POST') {
        state.responsibilities[0]!.enabled = true;
        return response({ responsibility: state.responsibilities[0] });
      }
      return response(state);
    };
    await click('Activate observation');
    expect(posts()[0]!.body).toEqual({
      expectedRevision: 4,
      expectedGeneration: 7,
      action: { type: 'activate' },
    });
    expect(target.textContent).toContain('Coordination paused');
    expect(button('Pause observation').disabled).toBe(false);
    expect(posts()).toHaveLength(1);
  });

  it('tracks only on click and never calls start or creates an execution session', async () => {
    await mountPage();
    handler = async (_url, init) => {
      if (init.method === 'POST') {
        state.suggestions[0]!.disposition = 'linked';
        state.suggestions[0]!.taskId = 't1';
        return response({ task: state.tasks[0] });
      }
      return response(state);
    };
    await click('Track only');
    expect(posts()).toHaveLength(1);
    expect(posts()[0]!.url).toBe('/api/pots/suggestions/s1/track');
    expect(posts()[0]!.body).toEqual({ expectedRevision: 3, commandId: expect.any(String) });
    expect(state.tasks[0]!.executionSessionId).toBeNull();
    expect(target.textContent).toContain('No execution session. Tracking is not running.');
  });

  it('snoozes and dismisses only with explicit revision-fenced requests', async () => {
    await mountPage();
    handler = async (_url, init) =>
      init.method === 'POST' ? response({ suggestion: state.suggestions[0] }) : response(state);
    const now = Date.now();
    await click('Snooze 1 hour');
    expect(posts()[0]!.body).toEqual({
      expectedRevision: 3,
      action: { type: 'snooze', until: expect.any(Number) },
    });
    expect(posts()[0]!.body.action.until).toBeGreaterThanOrEqual(now + 3600000);
    await click('Dismiss');
    expect(posts()[1]!.body).toEqual({ expectedRevision: 3, action: { type: 'dismiss' } });
  });

  it('refreshes on a conflict but never automatically retries the stale operation', async () => {
    await mountPage();
    handler = async (_url, init) => {
      if (init.method === 'POST') {
        state.suggestions[0]!.revision = 4;
        return response({ error: { code: 'revision_conflict', message: 'conflict' } }, 409);
      }
      return response(state);
    };
    await click('Track only');
    expect(posts()).toHaveLength(1);
    expect(target.querySelector('[role="alert"]')!.textContent).toContain(
      'review before trying again',
    );
    expect(calls.filter((call) => !call.init.method)).toHaveLength(2);
  });

  it('archives only finished records, with their current revision', async () => {
    const archiveButtons = (label: string) =>
      Array.from(
        target.querySelectorAll<HTMLElement>(`article[aria-label="${label}"] button`),
      ).filter((item) => item.textContent?.trim() === 'Archive');
    await mountPage();
    // Disabled responsibility: archivable. Pending suggestion and tracked task: not.
    expect(archiveButtons('Watch workspace')).toHaveLength(1);
    expect(archiveButtons('Suggestion from pots')).toHaveLength(0);
    expect(archiveButtons('t1')).toHaveLength(0);
    expect(target.textContent).toContain('It cannot be undone.');
    if (component) await unmount(component);
    target.remove();

    state.responsibilities[0]!.enabled = true;
    state.suggestions[0]!.disposition = 'dismissed';
    state.tasks[0]!.status = 'completed';
    await mountPage();
    expect(archiveButtons('Watch workspace')).toHaveLength(0);
    handler = async (url, init) => {
      if (init.method === 'POST') {
        if (url.includes('/suggestions/')) state.suggestions = [];
        else state.tasks = [];
        return response({});
      }
      return response(state);
    };
    archiveButtons('Suggestion from pots')[0]!.click();
    await flush();
    archiveButtons('t1')[0]!.click();
    await flush();
    expect(posts().map((post) => [post.url, post.body])).toEqual([
      ['/api/pots/suggestions/s1/control', { expectedRevision: 3, action: { type: 'archive' } }],
      [
        '/api/pots/tasks/t1/control',
        { expectedRevision: 2, expectedGeneration: 5, action: { type: 'archive' } },
      ],
    ]);
    expect(target.textContent).toContain('No suggestions.');
    expect(target.textContent).toContain('No tracked tasks.');
  });

  it('takes over with the control generation and fences further coordination', async () => {
    await mountPage();
    handler = async (_url, init) => {
      if (init.method === 'POST') {
        state.tasks[0]!.takenOver = true;
        state.tasks[0]!.controlGeneration++;
        return response({ task: state.tasks[0] });
      }
      return response(state);
    };
    await click('Take over');
    expect(posts()[0]!.body).toEqual({
      expectedRevision: 2,
      expectedGeneration: 5,
      action: { type: 'take_over' },
    });
    expect(target.textContent).toContain('pots coordination is fenced');
    expect(target.textContent).toContain('execution conversation accepts your input');
    expect(button('Take over').disabled).toBe(true);
    expect(button('Stop execution')).toBeUndefined();
    expect(button('Stop tracking')).toBeDefined();
  });

  it('clears records immediately on focus and clears drafts across account changes', async () => {
    await mountPage();
    await draft();
    let resolve!: (reply: Response) => void;
    handler = () =>
      new Promise((done) => {
        resolve = done;
      });
    window.dispatchEvent(new Event('focus'));
    await flush();
    expect(target.textContent).not.toContain('Watch workspace');
    expect(target.querySelector('form')).toBeNull();
    state = { ...state, accountKey: 'account-b', responsibilities: [], suggestions: [], tasks: [] };
    resolve(response(state));
    await flush();
    expect(target.querySelector('textarea')!.value).toBe('');
    expect(target.textContent).not.toContain('session1');
    expect(posts()).toHaveLength(0);
  });

  it('ignores a late response from the previous account refresh', async () => {
    await mountPage();
    let oldResolve!: (reply: Response) => void;
    let newResolve!: (reply: Response) => void;
    const old = structuredClone(state);
    handler = () =>
      new Promise((done) => {
        oldResolve = done;
      });
    window.dispatchEvent(new Event('focus'));
    await flush();
    handler = () =>
      new Promise((done) => {
        newResolve = done;
      });
    window.dispatchEvent(new Event('focus'));
    await flush();
    state = { ...state, accountKey: 'account-b', responsibilities: [], suggestions: [], tasks: [] };
    newResolve(response(state));
    await flush();
    oldResolve(response(old));
    await flush();
    expect(target.textContent).not.toContain('Watch workspace');
    expect(target.textContent).not.toContain('session1');
  });

  it.each(['superseded', 'needs_refresh', 'expired'] as const)(
    'does not assert freshness or offer acceptance for %s evidence',
    async (kind) => {
      if (kind === 'expired') state.suggestions[0]!.evidence.expiresAt = Date.now() - 1;
      else state.suggestions[0]!.disposition = kind;
      await mountPage();
      expect(target.textContent).not.toContain('Session needs your input');
      expect(button('Track only')).toBeUndefined();
      expect(button('Snooze 1 hour')).toBeUndefined();
      expect(posts()).toHaveLength(0);
    },
  );

  it('does not invent a running task when start returns not_ready', async () => {
    handler = async () => response({ error: { code: 'not_ready', message: 'No adapter' } }, 503);
    await expect(
      potsApi.start(state.tasks[0]!, 'Inspect the workspace', 'start-key'),
    ).rejects.toMatchObject({
      status: 503,
      code: 'not_ready',
    });
    expect(posts()[0]!.body).toEqual({
      expectedRevision: 2,
      expectedGeneration: 5,
      commandId: 'start-key',
      instruction: 'Inspect the workspace',
    });
    expect(state.tasks[0]!.status).toBe('tracked');
  });

  it('requires an explicit bounded instruction and dispatches once, then opens only the execution session', async () => {
    state.executionAvailable = true;
    state.tasks[0]!.coordinationPaused = false;
    await mountPage();
    expect(button('Start').disabled).toBe(true);
    expect(posts()).toHaveLength(0);
    expect(target.textContent).toContain('No source transcript or approval is copied or answered');
    await enter('Execution instruction', '界'.repeat(6667));
    expect(button('Start').disabled).toBe(true);
    await enter('Execution instruction', 'Inspect the workspace and report findings');
    expect(button('Start').disabled).toBe(false);
    handler = async (_url, init) => {
      if (init.method === 'POST') {
        state.tasks[0]!.status = 'running';
        state.tasks[0]!.executionSessionId = 'dedicated-execution';
        state.tasks[0]!.execution = {
          instruction: JSON.parse(String(init.body)).instruction,
          dispatchId: 'dispatch',
          generation: 5,
          acceptedRevision: 2,
          acceptedAt: 1,
        };
        return response({ task: state.tasks[0] });
      }
      return response(state);
    };
    await click('Start');
    expect(posts()).toHaveLength(1);
    expect(posts()[0]!.url).toBe('/api/pots/tasks/t1/start');
    expect(posts()[0]!.body).toEqual({
      expectedRevision: 2,
      expectedGeneration: 5,
      commandId: expect.any(String),
      instruction: 'Inspect the workspace and report findings',
    });
    expect(target.textContent).toContain('Running');
    expect(button('Start')).toBeUndefined();
    expect(button('Stop execution').disabled).toBe(false);
    expect(target.textContent).toContain('accepts only the pots instruction');
    await click('Open execution session');
    expect(open).toHaveBeenCalledWith('dedicated-execution');
    expect(posts()).toHaveLength(1);
  });

  it.each(['coordinationPaused', 'takenOver'] as const)('does not Start when %s', async (flag) => {
    state.executionAvailable = true;
    state.tasks[0]!.coordinationPaused = false;
    state.tasks[0]![flag] = true;
    await mountPage();
    await enter('Execution instruction', 'Inspect workspace');
    expect(button('Start').disabled).toBe(true);
    await click('Start');
    expect(posts()).toHaveLength(0);
  });

  it('never retries an uncertain Start and keeps Stop available with delivery warning', async () => {
    state.executionAvailable = true;
    state.tasks[0]!.coordinationPaused = false;
    await mountPage();
    await enter('Execution instruction', 'Inspect workspace');
    handler = async (_url, init) => {
      if (init.method === 'POST') {
        state.tasks[0]!.status = 'starting';
        state.tasks[0]!.execution = {
          instruction: 'Inspect workspace',
          dispatchId: 'd',
          generation: 5,
          acceptedRevision: 2,
          acceptedAt: 1,
        };
        state.tasks[0]!.failure = 'Delivery could not be confirmed';
        throw new TypeError('Connection lost');
      }
      return response(state);
    };
    await click('Start');
    expect(posts()).toHaveLength(1);
    expect(target.textContent).toContain('Starting');
    expect(button('Stop execution').disabled).toBe(false);
    expect(target.textContent).toContain('do not assume it is stopped');
    expect(target.textContent).toContain('Delivery could not be confirmed');
    expect(button('Start')).toBeUndefined();
  });

  it.each([
    'starting',
    'queued',
    'waiting_input',
    'completed',
    'failed',
    'stopping',
    'stopped',
  ] as const)('renders %s without offering another Start', async (status) => {
    state.executionAvailable = true;
    state.tasks[0]!.status = status;
    state.tasks[0]!.executionSessionId = 'exec';
    state.tasks[0]!.outcome = 'Result summary';
    await mountPage();
    expect(button('Start')).toBeUndefined();
    expect(target.textContent).toContain('Result summary');
    expect(button('Open execution session')).toBeDefined();
    expect(posts()).toHaveLength(0);
  });

  it('clears private execution instruction drafts on account changes', async () => {
    state.executionAvailable = true;
    state.tasks[0]!.coordinationPaused = false;
    await mountPage();
    await enter('Execution instruction', 'Private old account instruction');
    state.accountKey = 'account-b';
    await click('Refresh');
    const instruction = target.querySelectorAll('textarea')[1]!;
    expect(instruction.value).toBe('');
    expect(button('Start').disabled).toBe(true);
    expect(posts()).toHaveLength(0);
  });

  it('renders the safety boundary and controls in Traditional Chinese', async () => {
    i18n.setLanguage('zh-TW');
    await mountPage();
    expect(target.textContent).toContain('責任');
    expect(target.textContent).toContain('僅追蹤');
    expect(target.textContent).toContain('無法啟動');
  });
});
