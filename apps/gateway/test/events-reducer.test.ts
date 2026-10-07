import { describe, expect, it } from 'bun:test';
import { EventHub } from '../src/events.js';
import { emptyReducedState, reducePiEvent } from '../src/node/reducer.js';

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
  it('isolates a failing subscriber from the others and from the publisher', () => {
    const hub = new EventHub(4);
    const seen: string[] = [];
    hub.subscribe('s1', () => {
      throw new Error('subscriber exploded');
    });
    hub.subscribe('s1', (event) => seen.push(`session:${event.type}`));
    hub.subscribeAll((event) => seen.push(`all:${event.type}`));
    expect(() => hub.publish('s1', 0, 'runner_ready', {})).not.toThrow();
    expect(seen).toEqual(['session:runner_ready', 'all:runner_ready']);
  });

  it('keeps running ptc operations (start, not end) for snapshots, without results', () => {
    const state = emptyReducedState();
    const op = (type: string, id: string, extra: Record<string, unknown> = {}) =>
      reducePiEvent(state, {
        type,
        toolCallId: id,
        toolName: 'edit',
        parentToolCallId: 'p',
        ...extra,
      });
    op('tool_execution_start', 'p:op1', { args: { path: 'a' } });
    op('tool_execution_start', 'p:op2', { args: { path: 'b' } });
    // A direct call (no parent) is not an operation.
    reducePiEvent(state, { type: 'tool_execution_start', toolCallId: 'p', toolName: 'ptc' });
    op('tool_execution_end', 'p:op1', { result: { content: [{ type: 'text', text: 'secret' }] } });
    expect(state.operations).toEqual([
      { toolCallId: 'p:op2', parentToolCallId: 'p', toolName: 'edit', args: { path: 'b' } },
    ]);
    // Large arguments are cut for display.
    op('tool_execution_start', 'big', { args: { path: 'a', content: 'x'.repeat(5000) } });
    expect(state.operations.at(-1)!.args).toEqual({ path: 'a', content: `${'x'.repeat(1000)}…` });
    for (let index = 0; index < 50; index++) op('tool_execution_start', `x${index}`);
    expect(state.operations.length).toBe(32);
    reducePiEvent(state, { type: 'agent_end' });
    expect(state.operations).toEqual([]);
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
