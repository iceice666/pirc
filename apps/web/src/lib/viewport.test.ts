// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { trackViewportHeight } from './viewport';

class FakeViewport extends EventTarget {
  height = 800;
  scale = 1;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('sizes the app to the visible viewport above the soft keyboard', () => {
  const viewport = new FakeViewport();
  vi.stubGlobal('visualViewport', viewport);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    // Ran synchronously: no frame is left pending.
    return 0;
  });
  const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
  const root = document.createElement('div');
  const stop = trackViewportHeight(root);
  expect(root.style.getPropertyValue('--app-height')).toBe('800px');

  // The keyboard opens and iOS scrolled the page to reveal the field.
  viewport.height = 460;
  vi.spyOn(window, 'scrollY', 'get').mockReturnValue(120);
  viewport.dispatchEvent(new Event('resize'));
  expect(root.style.getPropertyValue('--app-height')).toBe('460px');
  expect(scrollTo).toHaveBeenCalledWith(0, 0);

  // Pinch zoom shrinks the visual viewport but not the app.
  viewport.height = 400;
  viewport.scale = 2;
  viewport.dispatchEvent(new Event('resize'));
  expect(root.style.getPropertyValue('--app-height')).toBe('800px');

  stop();
  expect(root.style.getPropertyValue('--app-height')).toBe('');
});

it('does nothing without visualViewport', () => {
  vi.stubGlobal('visualViewport', undefined);
  const root = document.createElement('div');
  trackViewportHeight(root)();
  expect(root.style.getPropertyValue('--app-height')).toBe('');
});
