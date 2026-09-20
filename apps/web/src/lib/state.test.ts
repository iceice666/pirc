import { describe, expect, it } from 'vitest';
import { fromSnapshot, reduceEvent } from './state';
import type { EventEnvelope, SessionSnapshot } from './types';

const snapshot: SessionSnapshot = {
  session: {
    id: 's1',
    workspaceId: 'w1',
    name: 'Test session',
    lastActivityAt: '2025-01-01T00:00:00Z',
    runnerStatus: 'ready',
    unreadCount: 0,
  },
  runnerStatus: 'ready',
  run: { id: 'r1', status: 'running' },
  messages: [],
  interactions: [],
  queue: [],
  control: { heldByCurrentClient: true, generation: 2 },
  cursor: '1',
  runnerEpoch: 'epoch-a',
};

function envelope(event: EventEnvelope['event'], cursor = '2'): EventEnvelope {
  return { sessionId: 's1', runnerEpoch: 'epoch-a', sequence: Number(cursor), cursor, event };
}

describe('session event reducer', () => {
  it('streams into a partial message and replaces it on completion', () => {
    let state = fromSnapshot(snapshot);
    state = reduceEvent(
      state,
      envelope({
        type: 'message_started',
        message: {
          id: 'm1',
          role: 'assistant',
          content: 'Hello',
          createdAt: '2025-01-01T00:00:01Z',
          isPartial: true,
        },
      }),
    );
    state = reduceEvent(
      state,
      envelope({ type: 'message_delta', messageId: 'm1', delta: ' world' }, '3'),
    );
    expect(state.messages[0]?.content).toBe('Hello world');
    expect(state.messages[0]?.isPartial).toBe(true);

    state = reduceEvent(
      state,
      envelope(
        {
          type: 'message_completed',
          message: {
            id: 'm1',
            role: 'assistant',
            content: 'Hello world!',
            createdAt: '2025-01-01T00:00:01Z',
          },
        },
        '4',
      ),
    );
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.content).toBe('Hello world!');
    expect(state.messages[0]?.isPartial).toBeUndefined();
  });

  it('upserts tool updates without duplicating tools', () => {
    let state = fromSnapshot({
      ...snapshot,
      messages: [{ id: 'm1', role: 'assistant', content: '', createdAt: '2025-01-01T00:00:01Z' }],
    });
    state = reduceEvent(
      state,
      envelope({
        type: 'tool_updated',
        messageId: 'm1',
        tool: { id: 't1', name: 'bash', status: 'running' },
      }),
    );
    state = reduceEvent(
      state,
      envelope({
        type: 'tool_updated',
        messageId: 'm1',
        tool: { id: 't1', name: 'bash', status: 'succeeded', output: 'ok' },
      }),
    );
    expect(state.messages[0]?.tools).toEqual([
      { id: 't1', name: 'bash', status: 'succeeded', output: 'ok' },
    ]);
  });

  it('requires a fresh snapshot after reset or epoch mismatch', () => {
    const state = fromSnapshot(snapshot);
    expect(
      reduceEvent(state, envelope({ type: 'reset', reason: 'cursor_expired' })).needsSnapshot,
    ).toBe(true);
    expect(
      reduceEvent(state, {
        ...envelope({ type: 'queue_updated', queue: [] }),
        runnerEpoch: 'epoch-b',
      }).needsSnapshot,
    ).toBe(true);
  });
});
