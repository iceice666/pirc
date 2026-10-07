import { expect, test } from 'bun:test';
import { FixtureServices } from './ptc-m1/fixture-services.js';
import { FixtureOracle } from './ptc-m1/oracles.js';
import { FIXTURES } from './ptc-m1/fixtures.js';
import { startFixtureDaemon } from './ptc-m1/daemon-fixture.js';

for (const id of [
  'user-question',
  'cancel-wait',
  'approval-denial',
  'schedule',
  'chat-web-search',
  'browser-image',
])
  test(`synthetic fixture services: ${id}`, async () => {
    const fixture = FIXTURES.find((f) => f.id === id)!;
    const daemon = await startFixtureDaemon(fixture.kind);
    let aborted = 0,
      fatal = 0;
    const replies: any[] = [];
    const service = new FixtureServices(
      fixture,
      new FixtureOracle(fixture),
      daemon,
      async () => {
        aborted++;
      },
      () => {
        fatal++;
      },
      1,
    );
    try {
      const event =
        id === 'schedule'
          ? {
              type: 'gateway_request',
              op: 'schedule.create',
              args: { prompt: 'Check synthetic CI', cron: '0 9 * * *', timezone: 'UTC' },
            }
          : id === 'chat-web-search'
            ? { type: 'gateway_request', op: 'web.search', args: { query: 'synthetic' } }
            : id === 'browser-image'
              ? { type: 'browser_request', op: 'screenshot' }
              : {
                  type: 'extension_ui_request',
                  method: id === 'approval-denial' ? 'confirm' : 'select',
                  message: 'Command (bash):\n\ngit push --force nowhere\n\nReason: synthetic',
                };
      service.handle({ ...event, id: 'synthetic-request' }, (value) => replies.push(value));
      await service.drain();
      expect(fatal).toBe(0);
      expect(service.summary().serviceValid).toBe(true);
      if (id === 'cancel-wait') {
        expect(aborted).toBe(1);
        expect(replies).toHaveLength(0);
      } else expect(replies).toHaveLength(1);
      if (id === 'approval-denial') expect(replies[0].confirmed).toBe(false);
      if (id === 'schedule') expect(daemon.scheduleProof(replies[0].result.proposalId)).toBe(true);
      if (id === 'browser-image') expect(replies[0].result.title).not.toContain('Q7M2');
    } finally {
      await service.close();
      await daemon.close();
    }
  });

test('unexpected host execution is denied and invalidates the trial', async () => {
  const fixture = FIXTURES[0]!;
  const daemon = await startFixtureDaemon('coding');
  const replies: any[] = [];
  const service = new FixtureServices(
    fixture,
    new FixtureOracle(fixture),
    daemon,
    async () => {},
    () => {},
    1,
  );
  try {
    service.handle({ type: 'sandbox_request', op: 'exec', id: 'no-host' }, (value) =>
      replies.push(value),
    );
    await service.drain();
    expect(replies[0].ok).toBe(false);
    expect(service.summary().serviceValid).toBe(false);
  } finally {
    await service.close();
    await daemon.close();
  }
});

test('alternate-channel operations are denied unexecuted, fail the service gate and are not fatal', async () => {
  const fixture = FIXTURES.find((f) => f.id === 'permission-rejection')!;
  const daemon = await startFixtureDaemon('coding');
  const replies: any[] = [];
  let fatal = 0;
  const oracle = new FixtureOracle(fixture);
  const service = new FixtureServices(
    fixture,
    oracle,
    daemon,
    async () => {},
    () => {
      fatal++;
    },
    1,
  );
  try {
    for (const event of [
      { type: 'gateway_request', op: 'web.search', args: { query: 'PRIVATE_QUERY' } },
      { type: 'gateway_request', op: 'schedule.create', args: { prompt: 'x' } },
      { type: 'browser_request', op: 'navigate', args: { url: 'https://example.invalid' } },
      { type: 'extension_ui_request', method: 'select', options: ['a'] },
      { type: 'extension_ui_request', method: 'confirm', message: 'unrelated' },
    ])
      service.handle({ ...event, id: `r${replies.length}-${event.type}` }, (value) =>
        replies.push(value),
      );
    await service.drain();
    expect(fatal).toBe(0);
    expect(replies).toHaveLength(5);
    expect(replies.filter((r) => r.type !== 'extension_ui_response').every((r) => !r.ok)).toBe(
      true,
    );
    expect(replies.find((r) => r.type === 'gateway_response').error.code).toBe('denied');
    expect(replies.some((r) => r.cancelled === true)).toBe(true);
    expect(replies.some((r) => r.confirmed === false)).toBe(true);
    const summary = service.summary();
    expect(summary.serviceValid).toBe(false);
    expect(summary.unexpected).toEqual({ gateway: 2, browser: 1, interaction: 2 });
    expect(JSON.stringify(summary)).not.toContain('PRIVATE_QUERY');
    expect(daemon.scheduleProof('missing')).toBe(false);
  } finally {
    await service.close();
    await daemon.close();
  }
  // The approval-denial fixture still refuses unrelated confirmations without accepting them.
  const denial = FIXTURES.find((f) => f.id === 'approval-denial')!;
  const daemon2 = await startFixtureDaemon('coding');
  const out: any[] = [];
  const s2 = new FixtureServices(
    denial,
    new FixtureOracle(denial),
    daemon2,
    async () => {},
    () => {
      fatal++;
    },
    1,
  );
  try {
    s2.handle(
      { type: 'extension_ui_request', method: 'confirm', message: 'rm -rf', id: 'u' },
      (v) => out.push(v),
    );
    await s2.drain();
    expect(out[0].confirmed).toBe(false);
    expect(s2.summary()).toMatchObject({ serviceValid: false, denials: 0 });
    expect(fatal).toBe(0);
  } finally {
    await s2.close();
    await daemon2.close();
  }
});
