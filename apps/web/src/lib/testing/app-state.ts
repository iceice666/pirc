import { vi } from 'vitest';
import { app } from '../app.svelte';
import { demoSnapshot } from '../mock';
import { fromSnapshot } from '../state';
import type { ClientSessionState } from '../types';

/**
 * Put the `app` singleton into a connected session this browser controls
 * (the demo snapshot unless overridden), without a gateway.
 */
export function seedApp(overrides: Partial<ClientSessionState> = {}): ClientSessionState {
  const base = fromSnapshot({
    ...demoSnapshot,
    control: { heldByCurrentClient: true, generation: 1 },
  });
  const state = { ...base, ...overrides };
  app.demo = undefined;
  app.activeSessionId = state.session.id;
  app.sessions = [state.session];
  app.sessionState = state;
  app.connection = 'connected';
  app.commandBusy = false;
  app.draft = '';
  app.uploads = [];
  app.hiddenMessages = 0;
  return state;
}

/**
 * `matchMedia` for jsdom (which has none): `touch` answers the touch-screen
 * query, `reducedMotion` makes Svelte transitions instant (jsdom has no Web
 * Animations).
 */
export function stubMatchMedia(touch = false, reducedMotion = false) {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches:
          (touch && query.includes('hover: none')) ||
          (reducedMotion && query.includes('prefers-reduced-motion')),
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }) as unknown as MediaQueryList,
  );
}
