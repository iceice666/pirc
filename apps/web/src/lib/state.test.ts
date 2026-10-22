import { describe, expect, it } from 'vitest';
import { normalizeEvent } from './api';
import { fromSnapshot, reduceEvent } from './state';
import type { EventEnvelope, SessionSnapshot } from './types';

const snapshot: SessionSnapshot = {
  session: {
    id: 's1',
    workspaceId: 'w1',
    name: 'Test session',
    lastActivityAt: '2025-01-01T00:00:00Z',
    runnerStatus: 'ready',
  },
  runnerStatus: 'ready',
  run: { id: 'r1', status: 'running' },
  control: { heldByCurrentClient: true, generation: 2 },
  cursor: '1',
  runnerEpoch: 'epoch-a',
};

function envelope(event: EventEnvelope['event'], cursor = '2'): EventEnvelope {
  return { sessionId: 's1', runnerEpoch: 'epoch-a', sequence: Number(cursor), cursor, event };
}

describe('session event reducer', () => {
  it('requires a fresh snapshot after reset or epoch mismatch', () => {
    const state = fromSnapshot(snapshot);
    expect(
      reduceEvent(state, envelope({ type: 'reset', reason: 'cursor_expired' })).needsSnapshot,
    ).toBe(true);
    expect(
      reduceEvent(state, {
        ...envelope({ type: 'noop' }),
        runnerEpoch: 'epoch-b',
      }).needsSnapshot,
    ).toBe(true);
  });

  it('applies a generated session title from the gateway', () => {
    const wire = normalizeEvent({
      sessionId: 's1',
      epoch: 'epoch-a',
      sequence: 2,
      type: 'session_renamed',
      data: { name: 'Fix login button', source: 'auto' },
    });
    expect(wire.event).toEqual({ type: 'session_renamed', name: 'Fix login button' });
    const state = reduceEvent(fromSnapshot(snapshot), wire);
    expect(state.session.name).toBe('Fix login button');
    expect(state.needsSnapshot).toBe(false);
  });

  it('passes side-panel change notices through without a resync', () => {
    const wire = normalizeEvent({
      sessionId: 's1',
      epoch: 'epoch-a',
      sequence: 2,
      type: 'pi_event',
      data: { type: 'panel_changed', sections: ['memory', 'background'] },
    });
    expect(wire.event).toEqual({ type: 'panel_changed', sections: ['memory', 'background'] });
    const state = reduceEvent(fromSnapshot(snapshot), wire);
    expect(state.needsSnapshot).toBe(false);
    expect(state.cursor).toBe(wire.cursor);
  });
});
