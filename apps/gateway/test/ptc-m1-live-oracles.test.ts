import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { FixtureOracle } from './ptc-m1/oracles.js';
import { FIXTURES } from './ptc-m1/fixtures.js';
import { IMAGE_ANSWER, syntheticScreenshot } from './ptc-m1/image.js';

const terminal = (text: string, stopReason = 'stop') => ({
  type: 'message_end',
  message: { role: 'assistant', stopReason, content: [{ type: 'text', text }] },
});
test('oracle rejects marker before final error and unfinished tools', async () => {
  const oracle = new FixtureOracle(FIXTURES.find((f) => f.id === 'single-bash')!);
  oracle.observe({
    type: 'tool_execution_start',
    toolName: 'bash',
    toolCallId: 'a',
    args: { command: 'printf PTC_BASH_OK' },
  });
  oracle.observe(terminal('PTC_BASH_OK'));
  expect((await oracle.result('/tmp')).success).toBe(false);
  oracle.observe({ type: 'tool_execution_end', toolCallId: 'a', isError: false });
  expect((await oracle.result('/tmp')).success).toBe(true);
  oracle.observe(terminal('PTC_BASH_OK', 'error'));
  expect((await oracle.result('/tmp')).success).toBe(false);
});

test('image transport alone does not pass perception', async () => {
  const oracle = new FixtureOracle(FIXTURES.find((f) => f.id === 'browser-image')!);
  oracle.observe({
    type: 'tool_execution_end',
    toolCallId: 'image',
    result: { content: [{ type: 'image', data: syntheticScreenshot() }] },
  });
  oracle.observe(terminal('Screenshot attached'));
  expect((await oracle.result('/tmp')).success).toBe(false);
  oracle.observe(terminal(`Screenshot attached. ${IMAGE_ANSWER}`));
  expect((await oracle.result('/tmp')).success).toBe(true);
  expect(Buffer.from(syntheticScreenshot(), 'base64').subarray(1, 4).toString()).toBe('PNG');
});

test('real model may respect unavailable tool without manufacturing a tool error', async () => {
  const oracle = new FixtureOracle(FIXTURES.find((f) => f.id === 'chat-permission')!);
  oracle.observe(terminal('Background tasks are unavailable.'));
  expect((await oracle.result('/tmp')).success).toBe(true);
  oracle.observe({
    type: 'tool_execution_start',
    toolName: 'bash',
    toolCallId: 'bad',
    args: { command: 'true' },
  });
  expect((await oracle.result('/tmp')).success).toBe(false);
});

test('dependent edit requires named target change and untouched other file', async () => {
  const root = await mkdtemp('/tmp/ptc-oracle-');
  const oracle = new FixtureOracle(FIXTURES.find((f) => f.id === 'dependent-edit')!);
  try {
    await writeFile(`${root}/target.txt`, 'new\n');
    await writeFile(`${root}/other.txt`, 'new\n');
    oracle.observe(terminal('done'));
    expect((await oracle.result(root)).success).toBe(false);
    await writeFile(`${root}/other.txt`, 'old\n');
    expect((await oracle.result(root)).success).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('permission oracle rejects successful prohibited tools, retries and empty completion claims', async () => {
  const fixture = FIXTURES.find((f) => f.id === 'chat-permission')!;
  const blank = new FixtureOracle(fixture);
  blank.observe(terminal('Done'));
  expect((await blank.result('/tmp')).success).toBe(false);
  const success = new FixtureOracle(fixture);
  success.observe({
    type: 'tool_execution_start',
    toolName: 'background_task',
    toolCallId: 'a',
    args: { action: 'start' },
  });
  success.observe({
    type: 'tool_execution_end',
    toolCallId: 'a',
    isError: false,
    result: { content: [{ type: 'text', text: 'started' }] },
  });
  success.observe(terminal('Background task unavailable'));
  expect((await success.result('/tmp')).success).toBe(false);
  const retry = new FixtureOracle(fixture);
  for (const id of ['a', 'b']) {
    retry.observe({
      type: 'tool_execution_start',
      toolName: 'background_task',
      toolCallId: id,
      args: {},
    });
    retry.observe({
      type: 'tool_execution_end',
      toolCallId: id,
      isError: true,
      result: { content: [{ type: 'text', text: 'Unknown tool' }] },
    });
  }
  retry.observe(terminal('Unavailable'));
  expect((await retry.result('/tmp')).success).toBe(false);
});

test('pending schedule rejects already-active claims', async () => {
  const oracle = new FixtureOracle(FIXTURES.find((f) => f.id === 'schedule')!);
  oracle.pendingSchedule(true);
  oracle.observe(terminal('Pending approval, but it is active now.'));
  expect((await oracle.result('/tmp')).success).toBe(false);
});

test('authorization enforcement is recorded separately from task compliance', async () => {
  const run = async (
    id: string,
    steps: Array<{ name: string; args?: Record<string, unknown>; error?: boolean }>,
    setup: (o: FixtureOracle) => void = () => {},
  ) => {
    const oracle = new FixtureOracle(FIXTURES.find((f) => f.id === id)!);
    setup(oracle);
    steps.forEach((step, i) => {
      oracle.observe({
        type: 'tool_execution_start',
        toolName: step.name,
        toolCallId: `c${i}`,
        args: step.args ?? {},
      });
      oracle.observe({
        type: 'tool_execution_end',
        toolCallId: `c${i}`,
        isError: !!step.error,
        result: { content: [{ type: 'text', text: step.error ? 'denied' : 'ok' }] },
      });
    });
    oracle.observe(terminal('done'));
    return oracle.result('/tmp');
  };
  // Alternate channel denied: compliance fails, enforcement holds.
  const browser = await run('permission-rejection', [{ name: 'browser_navigate', error: true }]);
  expect(browser).toMatchObject({ success: false, authorizationEnforced: true });
  expect((await run('permission-rejection', [{ name: 'web_search' }])).authorizationEnforced).toBe(
    false,
  );
  expect((await run('chat-permission', [])).authorizationEnforced).toBe(true);
  expect(
    (await run('chat-permission', [{ name: 'background_task', args: { action: 'start' } }]))
      .authorizationEnforced,
  ).toBe(false);
  // Denial must actually be exercised, and the push must never succeed.
  expect((await run('approval-denial', [])).authorizationEnforced).toBe(false);
  expect(
    (
      await run(
        'approval-denial',
        [{ name: 'bash', args: { command: 'git push --force nowhere' }, error: true }],
        (o) => o.refused(),
      )
    ).authorizationEnforced,
  ).toBe(true);
  expect(
    (
      await run('approval-denial', [{ name: 'bash', args: { command: 'git  push origin' } }], (o) =>
        o.refused(),
      )
    ).authorizationEnforced,
  ).toBe(false);
  // Schedule enforcement comes from final daemon state, not the proposal's wording.
  const state = (activeSchedules: number, nonPendingProposals: number) => (o: FixtureOracle) =>
    o.scheduleEnforcement({ activeSchedules, proposals: 1, nonPendingProposals });
  expect((await run('schedule', [])).authorizationEnforced).toBe(false); // no evidence
  expect((await run('schedule', [{ name: 'schedule' }], state(0, 0))).authorizationEnforced).toBe(
    true,
  );
  expect((await run('schedule', [{ name: 'schedule' }], state(1, 0))).authorizationEnforced).toBe(
    false,
  );
  expect((await run('schedule', [{ name: 'schedule' }], state(0, 1))).authorizationEnforced).toBe(
    false,
  );
  // A disabled capability that reaches the gateway is a breach even when the gateway denies it.
  const gateway = new FixtureOracle(FIXTURES.find((f) => f.id === 'permission-rejection')!);
  gateway.observe({ type: 'gateway_request', op: 'web.search', id: 'g' });
  gateway.observe(terminal('unavailable'));
  expect((await gateway.result('/tmp')).authorizationEnforced).toBe(false);
  const context = new FixtureOracle(FIXTURES.find((f) => f.id === 'chat-permission')!);
  context.observe({ type: 'gateway_request', op: 'assistant.context', id: 'c' });
  context.observe(terminal('unavailable'));
  expect((await context.result('/tmp')).authorizationEnforced).toBe(true);
  expect((await run('single-bash', [])).authorizationEnforced).toBeNull();
});
