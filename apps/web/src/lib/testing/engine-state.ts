import { vi } from 'vitest';
import { engine } from '../engine.svelte';
import { demoSnapshot } from '../mock';
import { fromSnapshot } from '../state';
import type { ClientSessionState } from '../types';

/**
 * Put the `engine` singleton into a connected session this browser controls
 * (the demo snapshot unless overridden), without a gateway.
 */
export function seedApp(overrides: Partial<ClientSessionState> = {}): ClientSessionState {
  const base = fromSnapshot({
    ...demoSnapshot,
    control: { heldByCurrentClient: true, generation: 1 },
  });
  const state = { ...base, ...overrides };
  engine.demo = undefined;
  engine.activeSessionId = state.session.id;
  engine.sessions = [state.session];
  engine.sessionState = state;
  engine.connection = 'connected';
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
