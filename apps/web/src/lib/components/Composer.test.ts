// @vitest-environment jsdom
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../app.svelte';
import { seedApp, stubMatchMedia } from '../testing/app-state';
import Composer from './Composer.svelte';

let component: ReturnType<typeof mount> | undefined;
let target: HTMLDivElement;

beforeEach(() => {
  stubMatchMedia(false);
  seedApp({ run: null });
  target = document.createElement('div');
  document.body.append(target);
});
afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  target.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function render() {
  component = mount(Composer, { target });
  flushSync();
  return {
    textarea: target.querySelector('textarea')!,
    button: (label: string) => target.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`),
  };
}

function type(textarea: HTMLTextAreaElement, value: string) {
  textarea.value = value;
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
}

function enter(textarea: HTMLTextAreaElement, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', {
    key: 'Enter',
    bubbles: true,
    cancelable: true,
    ...init,
  });
  textarea.dispatchEvent(event);
  return event;
}

describe('Composer', () => {
  it('sends a prompt with Enter and keeps Shift+Enter as a newline', () => {
    const send = vi.spyOn(app, 'sendCommand').mockResolvedValue();
    const { textarea } = render();
    type(textarea, 'hello');
    expect(enter(textarea, { shiftKey: true }).defaultPrevented).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(enter(textarea).defaultPrevented).toBe(true);
    expect(send).toHaveBeenCalledWith('prompt');
  });

  it('does not send on Enter while an IME composes', () => {
    const send = vi.spyOn(app, 'sendCommand').mockResolvedValue();
    const { textarea } = render();
    type(textarea, 'こんにちは');
    enter(textarea, { isComposing: true });
    expect(send).not.toHaveBeenCalled();
  });

  it('leaves Enter as a newline on touch keyboards; the button sends', () => {
    stubMatchMedia(true);
    const send = vi.spyOn(app, 'sendCommand').mockResolvedValue();
    const { textarea, button } = render();
    type(textarea, 'line one');
    expect(enter(textarea).defaultPrevented).toBe(false);
    expect(send).not.toHaveBeenCalled();
    button('Send message')!.click();
    expect(send).toHaveBeenCalledWith('prompt');
  });

  it('cannot send without control, a connection or text', () => {
    const send = vi.spyOn(app, 'sendCommand').mockResolvedValue();
    const { textarea, button } = render();
    expect(button('Send message')!.disabled).toBe(true);
    type(textarea, 'hello');
    expect(button('Send message')!.disabled).toBe(false);
    app.connection = 'offline';
    flushSync();
    expect(button('Send message')!.disabled).toBe(true);
    expect(target.textContent).toContain('You’re offline');
    enter(textarea);
    expect(send).not.toHaveBeenCalled();
  });

  it('turns the primary button into stop during a run, and steers once text is typed', async () => {
    seedApp({ run: { id: 'run-1', status: 'running' } });
    const send = vi.spyOn(app, 'sendCommand').mockResolvedValue();
    const stop = vi.spyOn(app, 'stopRun').mockResolvedValue();
    const { textarea, button } = render();
    expect(button('Send message')).toBeNull();
    button('Stop run')!.click();
    expect(stop).toHaveBeenCalledTimes(1);

    type(textarea, 'also check the tests');
    expect(textarea.placeholder).toBe('Steer the current run…');
    // Typing brings send back; stopping stays one click away beside it.
    expect(button('Send message')).not.toBeNull();
    expect(target.querySelector('.stop-button.secondary')).not.toBeNull();
    enter(textarea);
    expect(send).toHaveBeenCalledWith('steer');
    await tick();
  });

  it('shows the stopping state and disables stop meanwhile', () => {
    seedApp({ run: { id: 'run-1', status: 'stopping' } });
    const { button } = render();
    expect(button('Stopping run')!.disabled).toBe(true);
  });

  it('attaches pasted images and keeps pasted text', () => {
    const upload = vi.spyOn(app, 'uploadImages').mockResolvedValue();
    const { textarea } = render();
    const image = new File(['x'], 'shot.png', { type: 'image/png' });
    const paste = (text: string) => {
      const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
      Object.defineProperty(event, 'clipboardData', {
        value: { files: [image], getData: () => text },
      });
      textarea.dispatchEvent(event);
      return event;
    };
    expect(paste('').defaultPrevented).toBe(true);
    expect(upload).toHaveBeenLastCalledWith([image]);
    expect(paste('caption').defaultPrevented).toBe(false);
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it('sends a queued message now', () => {
    const state = seedApp({
      run: { id: 'run-1', status: 'running' },
      queue: [{ id: 'follow-0', kind: 'follow_up', index: 0, content: 'next', createdAt: '' }],
    });
    const sendNow = vi.spyOn(app, 'sendQueuedNow').mockResolvedValue();
    const { button } = render();
    expect(target.textContent).toContain('1 queued');
    button('Send now: next')!.click();
    expect(sendNow).toHaveBeenCalledWith(state.queue[0]);
  });
});
