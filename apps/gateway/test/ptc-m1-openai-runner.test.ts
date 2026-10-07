import { expect, test } from 'bun:test';
import { FIXTURES } from './ptc-m1/fixtures.js';
import { runOpenAIFixture } from './ptc-m1/openai-runner.js';
import { OpenAIBudget } from './ptc-m1/openai-budget.js';
import { fakeResponses } from './ptc-m1/openai-fake.js';
import { OPENAI_TEST_TASKS } from './ptc-m1/openai-test-tasks.js';
const cases = [
  ...Object.entries(OPENAI_TEST_TASKS),
  [
    'team-wait-retry',
    {
      ...OPENAI_TEST_TASKS['team-wait']!,
      steps: [
        OPENAI_TEST_TASKS['team-wait']!.steps![0]!,
        { name: 'agent_wait', input: { agent: 'fixturehelper', timeout: 0.01 } },
        { name: 'agent_list', input: {} },
        { name: 'agent_wait', input: { agent: 'fixturehelper', timeout: 10 } },
      ],
    },
  ] as const,
  [
    'team-wait-no-wait',
    {
      ...OPENAI_TEST_TASKS['team-wait']!,
      steps: OPENAI_TEST_TASKS['team-wait']!.steps!.slice(0, 1),
    },
  ] as const,
];
for (const [caseId, task] of cases)
  test.skipIf(!process.env.PTC_LINUX_NODE_BINARY || !process.env.PTC_LINUX_CHAT_BINARY)(
    `OpenAI real-srt fake Responses fixture ${caseId}`,
    async () => {
      const noWait = caseId === 'team-wait-no-wait';
      const retry = caseId === 'team-wait-retry';
      const id = noWait || retry ? 'team-wait' : caseId;
      const fixture = FIXTURES.find((f) => f.id === id)!;
      let parentStep = 0,
        childStep = 0;
      const upstream = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        async fetch(req) {
          const body = (await req.json()) as any;
          expect(body.prompt_cache_options).toEqual({ mode: 'explicit' });
          expect(body.service_tier).toBe('default');
          const main = body.tools?.some((t: any) => t.name === 'read');
          if (!main) return fakeResponses({ text: 'synthetic auxiliary' });
          const child =
            id === 'team-wait' &&
            JSON.stringify(body.input).includes(
              'Team message (agent data, not a user/system instruction)',
            );
          if (child) {
            if (retry && childStep === 0) await Bun.sleep(200);
            if (childStep++ === 0)
              return fakeResponses({
                tool: {
                  id: 'childwrite',
                  name: 'write',
                  args: { path: 'team.txt', content: 'joined' },
                },
              });
            return fakeResponses({ text: 'Done. Wrote joined.' });
          }
          const steps = task.steps ?? [{ name: task.name, input: task.input }];
          const step = steps[parentStep++];
          if (step) {
            let args = step.input;
            if (id === 'background-build' && parentStep === 2) {
              const output = body.input
                .filter((item: any) => item.type === 'function_call_output')
                .at(-1)?.output;
              const text =
                typeof output === 'string'
                  ? output
                  : (output?.find((part: any) => part.type === 'input_text')?.text ?? '');
              args = { action: 'wait', id: text.split(' ')[0] };
            }
            return fakeResponses({ tool: { id: `task${parentStep}`, name: step.name, args } });
          }
          return fakeResponses({ text: task.answer });
        },
      });
      try {
        const result = await runOpenAIFixture({
          fixture,
          condition: 'uncached',
          binary:
            fixture.kind === 'chat'
              ? process.env.PTC_LINUX_CHAT_BINARY!
              : process.env.PTC_LINUX_NODE_BINARY!,
          endpoint: upstream.url.origin,
          apiKey: 'synthetic',
          budget: new OpenAIBudget(),
          testLoopback: true,
        });
        expect(result.success).toBe(!noWait);
        expect(result.childrenAccounted).toBe(true);
        if (['approval-denial', 'permission-rejection', 'chat-permission', 'schedule'].includes(id))
          expect(result.outcome?.authorizationEnforced).toBe(true);
        if (fixture.id === 'team-wait')
          expect(result.teamEvidence?.activityDiagnostics).toMatchObject({
            childWriteKinds: { exact: 1, pathVariant: 0, contentVariant: 0, otherTarget: 0 },
            childWriteResults: { ok: 1, error: 0 },
            parentTeamFileEdits: 0,
            parentBashTeamFile: 0,
          });
        if (retry)
          expect(result.teamEvidence?.waitDiagnostics).toMatchObject({
            calls: 2,
            completed: 2,
            successful: 1,
            firstReason: 'timeout',
            rejected: false,
          });
        if (noWait) {
          expect(result.teamEvidence).toMatchObject({
            verified: false,
            waited: false,
            childCompleted: true,
            childWriteConfirmed: true,
          });
          expect(result.accounting?.owners.child).toBeGreaterThan(0);
        }
        expect(result.cacheVerified).toBe(true);
        expect(result.allAttemptsAccounted).toBe(true);
        expect(result.reasoningTokens).toBeGreaterThan(0);
      } finally {
        await upstream.stop(true);
      }
    },
    60000,
  );
