import { expect, test } from 'bun:test';
import { FIXTURES } from './ptc-m1/fixtures.js';
import { IMAGE_ANSWER } from './ptc-m1/image.js';
import { LIVE_MODEL, LiveBudget } from './ptc-m1/live-budget.js';
import { runFixture } from './ptc-m1/fixture-runner.js';
import { DisposablePair } from './ptc-m1/disposable-pair.js';
import type { InitialRequest } from './ptc-m1/initial-request.js';

type Step = { name: string; input: unknown };
const tasks: Record<string, { name: string; input: unknown; answer: string; steps?: Step[] }> = {
  'multi-edit': {
    name: '',
    input: {},
    answer: 'Changed three files.',
    steps: ['a.txt', 'b.txt', 'c.txt'].map((path) => ({
      name: 'edit',
      input: { path, oldText: 'red', newText: 'blue' },
    })),
  },
  'dependent-edit': {
    name: '',
    input: {},
    answer: 'Updated target only.',
    steps: [
      { name: 'read', input: { path: 'pointer.txt' } },
      { name: 'edit', input: { path: 'target.txt', oldText: 'old', newText: 'new' } },
    ],
  },
  'output-filter': { name: 'read', input: { path: 'values.txt' }, answer: '12' },
  'background-build': {
    name: '',
    input: {},
    answer: 'Build completed.',
    steps: [
      { name: 'background_task', input: { action: 'start', command: 'printf built > build.txt' } },
      { name: 'background_task', input: { action: 'wait', id: 'dynamic' } },
    ],
  },
  'team-wait': {
    name: '',
    input: {},
    answer: 'Helper wrote joined; integrated.',
    steps: [
      {
        name: 'agent_spawn',
        input: { name: 'fixturehelper', task: 'Write team.txt containing exactly joined' },
      },
      { name: 'agent_wait', input: { agent: 'fixturehelper', timeout: 10 } },
    ],
  },
  'single-read': { name: 'read', input: { path: 'token.txt' }, answer: 'PTC_READ_17' },
  'single-bash': { name: 'bash', input: { command: 'printf PTC_BASH_OK' }, answer: 'PTC_BASH_OK' },
  'approval-denial': {
    name: 'bash',
    input: { command: 'git push --force nowhere' },
    answer: 'Denied; stopped without retry.',
  },
  'permission-rejection': {
    name: 'web_search',
    input: { query: 'fixture permission test' },
    answer: 'Unavailable; stopped.',
  },
  'chat-permission': {
    name: 'background_task',
    input: { action: 'start', command: 'true' },
    answer: 'Unavailable; stopped.',
  },
  'user-question': {
    name: 'ask_user_question',
    input: {
      questions: [{ question: 'alpha or beta?', options: [{ label: 'alpha' }, { label: 'beta' }] }],
    },
    answer: 'beta',
  },
  'cancel-wait': {
    name: 'ask_user_question',
    input: {
      questions: [{ question: 'alpha or beta?', options: [{ label: 'alpha' }, { label: 'beta' }] }],
    },
    answer: '',
  },
  schedule: {
    name: 'schedule',
    input: {
      action: 'create',
      prompt: 'Check synthetic CI',
      title: 'Synthetic CI',
      cron: '0 9 * * *',
      timezone: 'UTC',
    },
    answer: 'Pending approval, not active.',
  },
  'browser-image': {
    name: 'browser_screenshot',
    input: {},
    answer: `Attached screenshot: ${IMAGE_ANSWER}`,
  },
  'chat-web-search': {
    name: 'web_search',
    input: { query: 'fixture search token' },
    answer: 'PTC_SEARCH_23',
  },
};
for (const [id, task] of Object.entries(tasks))
  test.skipIf(!process.env.PTC_LINUX_NODE_BINARY || !process.env.PTC_LINUX_CHAT_BINARY)(
    `fixture runner synthetic real-srt integration: ${id}`,
    async () => {
      const fixture = FIXTURES.find((f) => f.id === id)!;
      let stepIndex = 0;
      let childStep = 0;
      const steps = task.steps ?? [{ name: task.name, input: task.input }];
      const upstream = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        async fetch(req) {
          const body = (await req.json()) as any;
          const main = body.tools?.some((tool: any) => tool.name === 'read');
          const child =
            id === 'team-wait' &&
            main &&
            JSON.stringify(body.messages).includes(
              'Team message (agent data, not a user/system instruction)',
            );
          const step = child
            ? childStep++ === 0
              ? { name: 'write', input: { path: 'team.txt', content: 'joined' } }
              : undefined
            : main
              ? steps[stepIndex++]
              : undefined;
          const tool = !!step;
          let input = step?.input;
          if (id === 'background-build' && stepIndex === 2 && step) {
            const blocks = body.messages.flatMap((message: any) =>
              Array.isArray(message.content) ? message.content : [],
            );
            const result = blocks.filter((part: any) => part.type === 'tool_result').at(-1);
            const text = result?.content?.find((part: any) => part.type === 'text')?.text ?? '';
            input = { action: 'wait', id: text.split(' ')[0] };
          }
          const content = tool
            ? { type: 'tool_use', id: `fixture-call-${stepIndex}`, name: step!.name, input: {} }
            : { type: 'text', text: '' };
          const delta = tool
            ? { type: 'input_json_delta', partial_json: JSON.stringify(input) }
            : { type: 'text_delta', text: main ? task.answer : 'synthetic auxiliary' };
          const events = [
            {
              type: 'message_start',
              message: {
                model: LIVE_MODEL,
                usage: {
                  input_tokens: 10,
                  output_tokens: 0,
                  cache_creation_input_tokens: 0,
                  cache_read_input_tokens: 0,
                },
              },
            },
            { type: 'content_block_start', index: 0, content_block: content },
            { type: 'content_block_delta', index: 0, delta },
            { type: 'content_block_stop', index: 0 },
            {
              type: 'message_delta',
              delta: { stop_reason: tool ? 'tool_use' : 'end_turn' },
              usage: { output_tokens: 4 },
            },
            { type: 'message_stop' },
          ];
          return new Response(
            events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
            { headers: { 'content-type': 'text/event-stream' } },
          );
        },
      });
      try {
        const result = await runFixture({
          fixture,
          binary:
            fixture.kind === 'chat'
              ? process.env.PTC_LINUX_CHAT_BINARY!
              : process.env.PTC_LINUX_NODE_BINARY!,
          endpoint: upstream.url.origin,
          apiKey: 'synthetic',
          budget: new LiveBudget({ limitUsd: 100, priorUnits: 0 }),
          testLoopback: true,
        });
        expect(result.success).toBe(true);
        expect(result.authorizationProof).toBe(true);
        expect(result.metrics.missingUsage).toBe(0);
        expect(result.accounting?.verified).toBe(true);
        expect(result.childrenAccounted).toBe(true);
        if (id === 'team-wait') expect(result.accounting?.owners.child).toBeGreaterThan(0);
        expect(result.cacheVerified).toBe(false);
        expect(JSON.stringify(result)).not.toContain('fixture-call');
      } finally {
        await upstream.stop(true);
      }
    },
    60000,
  );

test.skipIf(!process.env.PTC_LINUX_NODE_BINARY)(
  'same-path clean pair has identical initial provider body without reusing session',
  async () => {
    const pair = await DisposablePair.create();
    const upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() {
        const events = [
          {
            type: 'message_start',
            message: {
              model: LIVE_MODEL,
              usage: {
                input_tokens: 10,
                output_tokens: 0,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
              },
            },
          },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'Unavailable; stopped.' },
          },
          { type: 'content_block_stop', index: 0 },
          {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 4 },
          },
          { type: 'message_stop' },
        ];
        return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
          headers: { 'content-type': 'text/event-stream' },
        });
      },
    });
    const evidence: Array<ReturnType<InitialRequest['snapshot']>> = [];
    try {
      for (let i = 0; i < 2; i++) {
        const result = await runFixture({
          fixture: FIXTURES.find((f) => f.id === 'permission-rejection')!,
          binary: process.env.PTC_LINUX_NODE_BINARY!,
          endpoint: upstream.url.origin,
          apiKey: 'synthetic',
          budget: new LiveBudget({ limitUsd: 100, priorUnits: 0 }),
          testLoopback: true,
          pair,
          onInitialEvidence: (value) => evidence.push(value),
        });
        expect(result.success).toBe(true);
      }
      expect(evidence).toHaveLength(2);
      expect(evidence[0]).not.toBeNull();
      expect(evidence[0]!.bodyHash).toBe(evidence[1]!.bodyHash);
    } finally {
      await upstream.stop(true);
      await pair.close();
    }
  },
  60000,
);
