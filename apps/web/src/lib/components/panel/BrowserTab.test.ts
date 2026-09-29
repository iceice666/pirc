// @vitest-environment jsdom
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import BrowserTab from './BrowserTab.svelte';

/** A WebSocket double: records what the tab sends and lets the test push frames. */
class FakeSocket extends EventTarget {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 1;
  sent: any[] = [];
  constructor(readonly url: string) {
    super();
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
  push(message: unknown) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }));
    flushSync();
  }
}

const last = <T>(items: T[]): T => items[items.length - 1]!;

const state = (overrides: Record<string, unknown> = {}) => ({
  type: 'state',
  state: {
    active: true,
    url: 'https://example.com/',
    title: 'Example',
    mode: 'agent',
    handoff: null,
    agentWaiting: false,
    action: null,
    recording: null,
    tabs: [{ index: 0, url: 'https://example.com/', title: 'Example', active: true }],
    viewport: { width: 800, height: 600 },
    ...overrides,
  },
});

let component: ReturnType<typeof mount> | undefined;
let target: HTMLDivElement;
beforeEach(() => {
  FakeSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  target = document.createElement('div');
  document.body.append(target);
});
afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  target.remove();
  vi.unstubAllGlobals();
});

function render(props: Record<string, unknown> = {}) {
  component = mount(BrowserTab, {
    target,
    props: { sessionId: 's1', generation: 3, hasControl: true, active: true, ...props },
  });
  flushSync();
  return last(FakeSocket.instances);
}
const button = (label: string) =>
  Array.from(target.querySelectorAll('button')).find((b) => b.textContent?.includes(label));

it('connects only while shown and renders what the agent is doing', async () => {
  const socket = render();
  expect(socket.url).toMatch(/\/api\/sessions\/s1\/browser\/stream$/);
  socket.push(state({ action: 'Click e3' }));
  socket.push({ type: 'frame', data: '/9j/', width: 800, height: 600 });
  expect(target.querySelector('.chip')?.textContent).toContain('Click e3');
  expect(target.querySelector('img.screen')?.getAttribute('src')).toBe(
    'data:image/jpeg;base64,/9j/',
  );
});

it('takes over with the control lease and forwards input as viewport coordinates', () => {
  const socket = render();
  socket.push(state());
  socket.push({ type: 'frame', data: '/9j/', width: 800, height: 600 });
  button('Take over')!.click();
  expect(last(socket.sent)).toMatchObject({ type: 'takeover', generation: 3 });
  expect(last(socket.sent).clientId).toBeTruthy();

  socket.push(state({ mode: 'user', handoff: '請登入', agentWaiting: true }));
  expect(target.textContent).toContain('請登入');
  expect(target.textContent).toContain('Agent is waiting for you');
  const img = target.querySelector('img.screen') as HTMLImageElement;
  img.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 300 }) as DOMRect;
  img.setPointerCapture = () => {};
  img.dispatchEvent(
    new MouseEvent('pointerdown', {
      clientX: 100,
      clientY: 150,
      button: 0,
      detail: 1,
      bubbles: true,
    }),
  );
  expect(last(socket.sent)).toMatchObject({ type: 'mouse', action: 'down', x: 200, y: 300 });

  const keys = target.querySelector('textarea') as HTMLTextAreaElement;
  keys.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  expect(last(socket.sent)).toMatchObject({ type: 'key', key: 'Enter' });
  keys.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }));
  expect(last(socket.sent)).toMatchObject({ type: 'key', key: 'Control+a' });
  keys.value = '你好';
  keys.dispatchEvent(new Event('input', { bubbles: true }));
  expect(last(socket.sent)).toMatchObject({ type: 'text', text: '你好' });

  button('Return control')!.click();
  expect(last(socket.sent)).toMatchObject({ type: 'release' });
});

it('refuses to act without the control lease', () => {
  const socket = render({ hasControl: false });
  socket.push(state());
  expect(button('Take over')!.disabled).toBe(true);
});

it('replays logged steps and lists recordings', () => {
  const socket = render();
  socket.push(state());
  socket.push({
    type: 'log',
    entries: [
      {
        index: 0,
        at: 0,
        actor: 'agent',
        action: 'Navigate to https://example.com/',
        url: '',
        image: true,
      },
      {
        index: 1,
        at: 1,
        actor: 'user',
        action: 'Saved recording .pirc/recordings/r-1.webm',
        url: '',
        image: false,
      },
    ],
  });
  (target.querySelector('[aria-label="Activity and replay"]') as HTMLButtonElement).click();
  flushSync();
  expect(target.querySelector('video')?.getAttribute('src')).toBe(
    '/api/sessions/s1/browser/recording?path=.pirc%2Frecordings%2Fr-1.webm',
  );
  button('Navigate to')!.click();
  expect(last(socket.sent)).toMatchObject({ type: 'log_image', index: 0 });
  socket.push({ type: 'log_image', index: 0, data: 'AAAA' });
  expect(target.querySelector('img.screen')?.getAttribute('src')).toBe(
    'data:image/jpeg;base64,AAAA',
  );
  button('Live')!.click();
  flushSync();
  expect(target.querySelector('img.screen')).toBeNull();
});
