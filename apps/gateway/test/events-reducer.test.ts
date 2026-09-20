import { describe, expect, it } from 'vitest';
import { EventHub } from '../src/events.js';
import { emptyReducedState, reducePiEvent } from '../src/reducer.js';

describe('events and reducer', () => {
  it('replays cursors and resets evicted or old epochs', () => {
    const hub = new EventHub(2);
    hub.publish('s', 1, 'a', 1);
    hub.publish('s', 1, 'b', 2);
    hub.publish('s', 1, 'c', 3);
    expect(hub.replay('s', { epoch: 1, sequence: 1 }, 1).events.map((event) => event.type)).toEqual(
      ['b', 'c'],
    );
    expect(hub.replay('s', { epoch: 1, sequence: 0 }, 1).reset).toBe(true);
    expect(hub.replay('s', { epoch: 0, sequence: 0 }, 1).reset).toBe(true);
  });
  it('assembles deltas but trusts message_end', () => {
    const state = emptyReducedState();
    reducePiEvent(state, { type: 'message_start', message: { role: 'assistant' } });
    reducePiEvent(state, {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'partial' },
    });
    expect(state.partialMessage?.content[0]?.text).toBe('partial');
    const authoritative = { role: 'assistant', content: [{ type: 'text', text: 'final' }] };
    reducePiEvent(state, { type: 'message_end', message: authoritative });
    expect(state.partialMessage).toBeNull();
    expect(state.history).toEqual([authoritative]);
  });
});
