import { afterEach, describe, expect, it } from 'bun:test';
import { formatRunResult, formatSchedules } from '../src/agent/features/schedules.js';
import { settledAfter, startAgent, type AgentProcess } from './agent-harness.js';

const agents: AgentProcess[] = [];
afterEach(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.close()));
});

const toolNames = (agent: AgentProcess) =>
  (agent.llm.requests.at(-1)!.body.tools ?? []).map(
    (tool: any) => tool.function?.name ?? tool.name,
  ) as string[];

const toolResult = (agent: AgentProcess, id: string) => {
  const messages = agent.llm.requests.at(-1)!.body.messages as any[];
  const message = messages.find((m) => m.role === 'tool' && m.tool_call_id === id);
  return String(
    typeof message?.content === 'string'
      ? message.content
      : message?.content?.map((part: any) => part.text).join(''),
  );
};

const brief = {
  id: 's1',
  title: 'CI check',
  workspace: 'Test on work',
  when: 'cron "0 9 * * 1-5" (Asia/Taipei)',
  status: 'active',
  nextRun: '2026-09-30 09:00 (Asia/Taipei)',
  prompt: 'Check the CI dashboard.',
  lastRun: {
    id: 'r1',
    status: 'completed',
    due: '2026-09-29 09:00 (Asia/Taipei)',
    result: 'All green.',
  },
};

describe('schedule', () => {
  it('proposes schedules through the gateway and reports failures', async () => {
    const agent = await startAgent({ env: { PIRC_GATEWAY: '1' } });
    agents.push(agent);
    agent.llm.push(
      {
        tool: {
          id: 'c1',
          name: 'schedule',
          args: {
            action: 'create',
            prompt: ' Check CI. ',
            cron: '0 9 * * 1-5',
            title: 'CI',
            model: 'gw/a',
          },
        },
      },
      { tool: { id: 'c2', name: 'schedule', args: { action: 'pause' } } },
      { tool: { id: 'c3', name: 'schedule', args: { action: 'update', id: 's1', cron: 'bad' } } },
      { text: 'Done.' },
    );
    const from = agent.events.length;
    await agent.send({ type: 'prompt', message: 'every weekday at 9, check CI' });
    const create = await agent.waitFor(
      (event) => event.type === 'gateway_request' && event.op === 'schedule.create',
    );
    expect(create.args).toEqual({
      prompt: 'Check CI.',
      cron: '0 9 * * 1-5',
      title: 'CI',
      model: 'gw/a',
    });
    agent.raw({
      type: 'gateway_response',
      id: create.id,
      ok: true,
      result: { proposalId: 'p1', status: 'pending_approval', title: 'CI' },
    });
    const update = await agent.waitFor(
      (event) => event.type === 'gateway_request' && event.op === 'schedule.update',
    );
    expect(update.args).toEqual({ id: 's1', cron: 'bad' });
    agent.raw({
      type: 'gateway_response',
      id: update.id,
      ok: false,
      error: { status: 400, code: 'invalid_input', message: 'Invalid cron "bad"' },
    });
    await settledAfter(agent, from);

    expect(toolNames(agent)).toContain('schedule');
    expect(toolResult(agent, 'c1')).toContain('Asked the user to approve the schedule “CI”');
    expect(toolResult(agent, 'c2')).toBe('id is required');
    expect(toolResult(agent, 'c3')).toBe('Invalid cron "bad"');
  });

  it('/cron lists and pauses without the model', async () => {
    const agent = await startAgent({ env: { PIRC_GATEWAY: '1' } });
    agents.push(agent);
    await agent.send({ type: 'prompt', message: '/cron' });
    const list = await agent.waitFor(
      (event) => event.type === 'gateway_request' && event.op === 'schedule.list',
    );
    agent.raw({
      type: 'gateway_response',
      id: list.id,
      ok: true,
      result: { schedules: [brief], timezone: 'Asia/Taipei' },
    });
    const shown = await agent.waitFor(
      (e) =>
        e.type === 'extension_ui_request' && e.method === 'notify' && /CI check/.test(e.message),
    );
    expect(shown.message).toContain('- s1 “CI check” [active] in Test on work');

    await agent.send({ type: 'prompt', message: '/cron pause s1' });
    const pause = await agent.waitFor(
      (event) => event.type === 'gateway_request' && event.op === 'schedule.pause',
    );
    expect(pause.args).toEqual({ id: 's1' });
    agent.raw({
      type: 'gateway_response',
      id: pause.id,
      ok: true,
      result: { ...brief, status: 'paused' },
    });
    await agent.waitFor(
      (e) =>
        e.type === 'extension_ui_request' &&
        e.method === 'notify' &&
        e.message === 'Paused “CI check”.',
    );
    expect(agent.llm.requests).toHaveLength(0);
  });

  it('is absent without a gateway or when disabled', async () => {
    const plain = await startAgent();
    agents.push(plain);
    plain.llm.push({ text: 'hi' });
    let from = plain.events.length;
    await plain.send({ type: 'prompt', message: 'hi' });
    await settledAfter(plain, from);
    expect(toolNames(plain)).not.toContain('schedule');

    const off = await startAgent({
      env: { PIRC_GATEWAY: '1' },
      config: { features: { schedules: { enabled: false } } },
    });
    agents.push(off);
    off.llm.push({ text: 'hi' });
    from = off.events.length;
    await off.send({ type: 'prompt', message: 'hi' });
    await settledAfter(off, from);
    expect(toolNames(off)).not.toContain('schedule');
  });

  it('formats the list', () => {
    expect(formatSchedules([], 'UTC')).toBe('No schedules. Default time zone: UTC.');
    expect(formatSchedules([brief], 'Asia/Taipei')).toBe(
      [
        'Schedules (default time zone Asia/Taipei):',
        '- s1 “CI check” [active] in Test on work: cron "0 9 * * 1-5" (Asia/Taipei); next 2026-09-30 09:00 (Asia/Taipei)',
        '  prompt: Check the CI dashboard.',
        '  last run r1 (2026-09-29 09:00 (Asia/Taipei)): completed — All green.',
      ].join('\n'),
    );
    const long = { ...brief, lastRun: { ...brief.lastRun, resultChars: 5000 } };
    expect(formatSchedules([long], 'UTC')).toContain(
      'All green. [5000 characters; read it with action result id=r1]',
    );
  });

  it('formats a run result and how to read on', () => {
    const run = { id: 'r1', schedule: 's1', status: 'completed', resultOffset: 0 };
    expect(formatRunResult({ ...run, result: 'ok', resultChars: 2 })).toBe(
      'Run r1 of s1 [completed]:\nok',
    );
    expect(formatRunResult({ ...run, result: '', resultChars: 0 })).toBe(
      'Run r1 of s1 [completed]: no result.',
    );
    expect(formatRunResult({ ...run, result: 'abc', resultChars: 9, nextOffset: 3 })).toBe(
      'Run r1 of s1 [completed]:\nabc\n[Result characters 0–3 of 9; continue with action result id=r1 offset=3]',
    );
    expect(
      formatRunResult({ ...run, result: 'ghi', resultOffset: 6, resultChars: 9, session: 'CI' }),
    ).toBe(
      'Run r1 of s1 [completed] (session “CI”):\nghi\n[Result characters 6–9 of 9; end of result]',
    );
  });
});
