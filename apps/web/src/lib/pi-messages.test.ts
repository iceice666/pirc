import { describe, expect, it } from 'vitest';
import { normalizeEvent } from './api';
import { interleave, piHistory, piNotification, piPartialMessage } from './pi-messages';
import { fromSnapshot, reduceEvent } from './state';
import type { SessionSnapshot } from './types';

describe('Pi history conversion', () => {
  const history = [
    { role: 'user', content: 'List files', timestamp: 1 },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Use ls.' },
        { type: 'text', text: 'Checking **now**.' },
        { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'ls' } },
      ],
      model: 'm',
      stopReason: 'toolUse',
      timestamp: 2,
    },
    {
      role: 'toolResult',
      toolCallId: 'c1',
      toolName: 'bash',
      content: [{ type: 'text', text: 'a.txt' }],
      isError: false,
      timestamp: 3,
    },
    { role: 'compactionSummary', summary: '## Summary', tokensBefore: 1200, timestamp: 4 },
    {
      role: 'bashExecution',
      command: 'pwd',
      output: '/x',
      exitCode: 1,
      cancelled: false,
      truncated: false,
      timestamp: 5,
    },
    { role: 'custom', customType: 'hidden', content: 'x', display: false, timestamp: 6 },
  ];

  it('folds tool results into their assistant turn and keeps thinking separate', () => {
    const messages = piHistory(history);
    expect(messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'system',
      'system',
    ]);
    const assistant = messages[1]!;
    expect(assistant.content).toBe('Checking **now**.');
    expect(assistant.thinking).toBe('Use ls.');
    expect(assistant.tools).toEqual([
      { id: 'c1', name: 'bash', status: 'succeeded', input: { command: 'ls' }, output: 'a.txt' },
    ]);
  });

  it('labels system entries by kind', () => {
    const [, , compaction, bash] = piHistory(history);
    expect(compaction).toMatchObject({ systemKind: 'compaction', content: '## Summary' });
    expect(bash).toMatchObject({
      systemKind: 'bash',
      label: 'pwd',
      meta: 'exit 1',
      level: 'warning',
    });
  });

  it('marks failed assistant turns', () => {
    const [message] = piHistory([
      {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: 'rate limited',
        timestamp: 9,
      },
    ]);
    expect(message).toMatchObject({ stopReason: 'error', errorMessage: 'rate limited' });
  });

  it('orders partial blocks by content index and parses streamed tool arguments', () => {
    const partial = piPartialMessage({
      base: { role: 'assistant', timestamp: 10 },
      content: {
        1: { type: 'text', text: 'B' },
        0: { type: 'thinking', text: 'A' },
        2: { type: 'toolCall', id: 't', toolName: 'read', arguments: '{"path":"x"}' },
      },
    });
    expect(partial).toMatchObject({ content: 'B', thinking: 'A', isPartial: true });
    expect(partial?.tools?.[0]).toMatchObject({ id: 't', name: 'read', input: { path: 'x' } });
  });

  it('interleaves notices by time', () => {
    const [user] = piHistory([{ role: 'user', content: 'hi', timestamp: 1000 }]);
    const notice = piNotification({
      id: 'n',
      message: 'careful',
      notifyType: 'warning',
      receivedAt: 500,
    });
    expect(interleave([user!], [notice]).map((message) => message.id)).toEqual([
      'notice-n',
      user!.id,
    ]);
  });
});

describe('live Pi events', () => {
  const snapshot: SessionSnapshot = {
    session: {
      id: 's',
      workspaceId: 'w',
      name: 'n',
      lastActivityAt: '2025-01-01T00:00:00Z',
      runnerStatus: 'ready',
      unreadCount: 0,
    },
    runnerStatus: 'ready',
    run: null,
    messages: [],
    interactions: [],
    queue: [],
    control: { heldByCurrentClient: true, generation: 1 },
    cursor: '1:0',
    runnerEpoch: '1',
  };
  let sequence = 0;
  const wire = (data: unknown, type = 'pi_event') =>
    normalizeEvent({
      sessionId: 's',
      epoch: 1,
      sequence: ++sequence,
      type,
      data,
      timestamp: 1_000 + sequence,
    });

  it('streams text, thinking and tool results into one assistant turn', () => {
    let state = fromSnapshot(snapshot);
    const text = (text: string) => [{ type: 'text', text }];
    const events = [
      { type: 'message_start', message: { role: 'user', content: 'go', timestamp: 1 } },
      { type: 'message_end', message: { role: 'user', content: 'go', timestamp: 1 } },
      { type: 'message_start', message: { role: 'assistant', content: [], timestamp: 2 } },
      {
        type: 'message_update',
        assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'hmm' },
      },
      {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: 'Run ' },
      },
      {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: 'it' },
      },
      {
        type: 'message_update',
        assistantMessageEvent: {
          type: 'toolcall_start',
          contentIndex: 2,
          id: 'c',
          toolName: 'bash',
        },
      },
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'hmm' },
            { type: 'text', text: 'Run it' },
            { type: 'toolCall', id: 'c', name: 'bash', arguments: { command: 'ls' } },
          ],
          stopReason: 'toolUse',
          timestamp: 2,
        },
      },
      { type: 'tool_execution_start', toolCallId: 'c', toolName: 'bash', args: { command: 'ls' } },
      {
        type: 'tool_execution_update',
        toolCallId: 'c',
        toolName: 'bash',
        partialResult: { content: text('a') },
      },
      {
        type: 'tool_execution_end',
        toolCallId: 'c',
        toolName: 'bash',
        result: { content: text('a\nb') },
        isError: false,
      },
      {
        type: 'message_end',
        message: {
          role: 'toolResult',
          toolCallId: 'c',
          toolName: 'bash',
          content: text('a\nb'),
          isError: false,
          timestamp: 3,
        },
      },
    ];
    for (const event of events) state = reduceEvent(state, wire(event));
    expect(state.needsSnapshot).toBe(false);
    expect(state.messages).toHaveLength(2);
    const assistant = state.messages[1]!;
    expect(assistant).toMatchObject({ role: 'assistant', content: 'Run it', thinking: 'hmm' });
    expect(assistant.isPartial).toBeUndefined();
    expect(assistant.tools).toHaveLength(1);
    expect(assistant.tools?.[0]).toMatchObject({
      id: 'c',
      status: 'succeeded',
      output: 'a\nb',
      input: { command: 'ls' },
    });
  });

  it('shows extension notifications as system notices and ignores stderr', () => {
    let state = fromSnapshot(snapshot);
    state = reduceEvent(
      state,
      wire(
        {
          type: 'extension_ui_request',
          method: 'notify',
          id: 'x',
          message: 'Blocked',
          notifyType: 'error',
        },
        'notification',
      ),
    );
    state = reduceEvent(state, wire({ text: 'noise' }, 'runner_stderr'));
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({
      role: 'system',
      systemKind: 'notice',
      level: 'error',
      content: 'Blocked',
    });
    expect(state.needsSnapshot).toBe(false);
  });
});
