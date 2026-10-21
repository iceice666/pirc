// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import SourceSettings from './SourceSettings.svelte';
import type { Source } from '../sources';

let component: ReturnType<typeof mount> | undefined;
let target: HTMLDivElement;
let sources: Source[];
let calls: Array<{ url: string; method: string; body: any }>;

const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
async function flush() {
  for (let i = 0; i < 12; i++) {
    await Promise.resolve();
    await tick();
  }
}
const button = (text: string) =>
  Array.from(target.querySelectorAll<HTMLButtonElement>('button')).find(
    (item) => item.textContent?.trim() === text,
  )!;
function field(label: string) {
  return Array.from(target.querySelectorAll('label'))
    .find((item) => item.querySelector('span')?.textContent === label)
    ?.querySelector<HTMLInputElement | HTMLSelectElement>('input, select')!;
}
async function input(label: string, value: string) {
  const element = field(label);
  element.value = value;
  element.dispatchEvent(
    new Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }),
  );
  await flush();
}

const gmail: Source = {
  id: 'email:gmail',
  kind: 'email',
  name: 'Gmail',
  user: 'me',
  config: { host: 'imap.gmail.com', username: 'me@gmail.com', mailbox: 'INBOX', port: 993 },
  pausedAt: null,
  lastPolledAt: null,
  lastError: null,
  failures: 0,
  createdAt: 1,
  updatedAt: 1,
  rooms: ['general'],
  cadenceMs: 300_000,
};

beforeEach(() => {
  sources = [];
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });
      if (url === '/api/sources' && method === 'POST') {
        if (body.secret.password !== 'app pass') {
          return response(
            {
              error: { code: 'source_login_failed', message: 'the mail server refused the login' },
            },
            400,
          );
        }
        sources = [gmail];
        return response({ source: gmail, test: 'INBOX holds 3 messages' }, 201);
      }
      if (url.endsWith('/poll'))
        return response({
          source: gmail,
          baseline: false,
          changed: [{}],
          wake: { id: 'wake_1' },
          error: null,
        });
      if (url.endsWith('/pause')) {
        sources = [{ ...gmail, pausedAt: 5 }];
        return response({ source: sources[0] });
      }
      return response({ sources, kinds: ['email'], webSearch: { available: false } });
    }),
  );
});

afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  target?.remove();
  vi.unstubAllGlobals();
});

async function setup() {
  target = document.createElement('div');
  document.body.append(target);
  component = mount(SourceSettings, { target, props: {} });
  await flush();
}

describe('SourceSettings', () => {
  it('adds a Gmail mailbox with an app password, tried first', async () => {
    await setup();
    expect(target.textContent).toContain('Add source');
    button('Add source').click();
    await flush();
    expect(target.textContent).toContain('myaccount.google.com/apppasswords');
    await input('Name', 'Gmail');
    await input('Email address', 'me@gmail.com');
    await input('App password', 'wrong');
    target.querySelector('form')!.requestSubmit();
    await flush();
    expect(target.querySelector('[role="alert"]')?.textContent).toContain('refused the login');
    await input('App password', 'app pass');
    target.querySelector('form')!.requestSubmit();
    await flush();
    const created = calls.filter((call) => call.method === 'POST' && call.url === '/api/sources');
    expect(created[created.length - 1]?.body).toEqual({
      kind: 'email',
      name: 'Gmail',
      config: { host: 'imap.gmail.com', port: 993, username: 'me@gmail.com', mailbox: 'INBOX' },
      secret: { password: 'app pass' },
    });
    expect(target.textContent).toContain('Added: INBOX holds 3 messages');
    expect(target.textContent).toContain('me@gmail.com · imap.gmail.com · INBOX');
    expect(target.textContent).toContain('Followed in #general');
    // The password is not kept in the page.
    expect(target.innerHTML).not.toContain('app pass');
  });

  it('reads now and pauses', async () => {
    sources = [gmail];
    await setup();
    button('Read now').click();
    await flush();
    expect(target.textContent).toContain('Gmail: 1 new or changed, and pirc woke up for it.');
    button('Pause').click();
    await flush();
    expect(target.textContent).toContain('Paused');
    expect(button('Resume')).toBeTruthy();
  });
});
