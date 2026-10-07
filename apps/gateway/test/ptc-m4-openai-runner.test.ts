/**
 * M4: the shared fixtures and oracles against PTC-only binaries, with a scripted fake Responses
 * model (never live reasoning evidence). Genuine srt on Linux; set PTC_M4_NODE_BINARY and
 * PTC_M4_CHAT_BINARY to the branch builds.
 */
import { expect, test } from 'bun:test';
import { CORE_CAPABILITIES } from '../src/agent/ptc/signatures.js';

const CORE: readonly string[] = CORE_CAPABILITIES;
import { FIXTURES } from './ptc-m1/fixtures.js';
import { runOpenAIFixture } from './ptc-m1/openai-runner.js';
import { OpenAIBudget } from './ptc-m1/openai-budget.js';
import { fakeResponses } from './ptc-m1/openai-fake.js';
import { IMAGE_ANSWER } from './ptc-m1/image.js';

const QUESTION = JSON.stringify({
  questions: [{ question: 'alpha or beta?', options: [{ label: 'alpha' }, { label: 'beta' }] }],
});
/** Per fixture: the scripts the parent runs, one per model round, then its answer. */
const SCRIPTS: Record<string, { scripts: string[]; answer: string; docs?: boolean }> = {
  'single-bash': {
    scripts: [`return (await tools.bash({ command: 'printf PTC_BASH_OK' })).output;`],
    answer: 'PTC_BASH_OK',
    docs: true,
  },
  'single-read': {
    scripts: [`return (await tools.read({ path: 'token.txt' })).content;`],
    answer: 'PTC_READ_17',
  },
  'multi-edit': {
    scripts: [
      `for (const path of ['a.txt', 'b.txt', 'c.txt'])
  await tools.edit({ path, oldText: 'red', newText: 'blue' });
return 'done';`,
    ],
    answer: 'Changed three files.',
  },
  'dependent-edit': {
    scripts: [
      `const { content } = await tools.read({ path: 'pointer.txt' });
const path: string = content.trim();
await tools.edit({ path, oldText: 'old', newText: 'new' });
return path;`,
    ],
    answer: 'Updated target only.',
  },
  'output-filter': {
    scripts: [
      `const { content } = await tools.read({ path: 'values.txt' });
return content.split('\\n').map(Number).filter((n) => n % 2 === 0 && n).reduce((a, b) => a + b, 0);`,
    ],
    answer: '12',
  },
  'background-build': {
    scripts: [
      `const { task } = await tools.background_task({ action: 'start', command: 'printf built > build.txt' });
const done = await tools.background_task({ action: 'wait', id: task.id });
return done.outcome;`,
    ],
    answer: 'Build completed.',
  },
  'team-wait': {
    scripts: [
      `await tools.agent_spawn({ name: 'fixturehelper', task: 'Write team.txt containing exactly joined' });
return await tools.agent_wait({ agent: 'fixturehelper', timeout: 10 });`,
    ],
    answer: 'Helper wrote joined; integrated.',
  },
  'approval-denial': {
    scripts: [`return await tools.bash({ command: 'git push --force nowhere' });`],
    answer: 'Denied; stopped without retry.',
  },
  'permission-rejection': {
    scripts: [`return await tools.web_search({ query: 'fixture permission test' });`],
    answer: 'Unavailable; stopped.',
  },
  'chat-permission': {
    scripts: [`return await tools.background_task({ action: 'start', command: 'true' });`],
    answer: 'Unavailable; stopped.',
  },
  'user-question': {
    scripts: [`return await tools.ask_user_question(${QUESTION});`],
    answer: 'beta',
  },
  'cancel-wait': { scripts: [`return await tools.ask_user_question(${QUESTION});`], answer: '' },
  schedule: {
    scripts: [
      `return await tools.schedule({ action: 'create', prompt: 'Check synthetic CI', title: 'Synthetic CI', cron: '0 9 * * *', timezone: 'UTC' });`,
    ],
    answer: 'Pending approval, not active.',
  },
  'browser-image': {
    scripts: [
      `const shot = await tools.browser_screenshot({});
await attachments.add(shot.images[0]);
return 'attached';`,
    ],
    answer: `Attached screenshot: ${IMAGE_ANSWER}`,
  },
  'chat-web-search': {
    scripts: [`return await tools.web_search({ query: 'fixture search token' });`],
    answer: 'PTC_SEARCH_23',
  },
};
const CHILD_WRITES: Record<string, string> = {
  exact: `await tools.write({ path: 'team.txt', content: 'joined' }); return 'ok';`,
  computed: `const content = ['jo', 'ined'].join(''); await tools.write({ path: 'team.txt', content }); return 'ok';`,
};
const cases: Array<[string, string, string]> = [
  ...FIXTURES.map((f) => [f.id, f.id, 'exact'] as [string, string, string]),
  ['team-wait-computed-write', 'team-wait', 'computed'],
  ['team-wait-parent-bash', 'team-wait', 'parent-bash'],
  // Hybrid surface (round 3): the same fixtures through direct core tool calls.
  ['single-bash-direct', 'single-bash', 'direct'],
  ['single-read-direct', 'single-read', 'direct'],
  ['approval-denial-direct', 'approval-denial', 'direct'],
  ['chat-web-search-direct', 'chat-web-search', 'direct'],
];
/** Direct (non-script) calls for the hybrid cases. */
const DIRECT: Record<string, { name: string; args: unknown }> = {
  'single-bash': { name: 'bash', args: { command: 'printf PTC_BASH_OK' } },
  'single-read': { name: 'read', args: { path: 'token.txt' } },
  'approval-denial': { name: 'bash', args: { command: 'git push --force nowhere' } },
  'chat-web-search': { name: 'web_search', args: { query: 'fixture search token' } },
};

for (const [caseId, id, variant] of cases)
  test.skipIf(!process.env.PTC_M4_NODE_BINARY || !process.env.PTC_M4_CHAT_BINARY)(
    `M4 PTC real-srt fake Responses fixture ${caseId}`,
    async () => {
      const fixture = FIXTURES.find((f) => f.id === id)!;
      const plan = SCRIPTS[id]!;
      const scripts =
        variant === 'parent-bash'
          ? [plan.scripts[0]!, `return (await tools.bash({ command: 'cat team.txt' })).output;`]
          : plan.scripts;
      const rounds: unknown[] =
        variant === 'direct'
          ? [DIRECT[id]!]
          : [
              ...(plan.docs ? [{ name: 'ptc_docs', args: { names: ['bash'] } }] : []),
              ...scripts.map((code) => ({ name: 'ptc', args: { code } })),
            ];
      const docs = variant !== 'direct' && !!plan.docs;
      let parentStep = 0,
        childStep = 0;
      const upstream = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        async fetch(req) {
          const body = (await req.json()) as any;
          expect(body.prompt_cache_options).toEqual({ mode: 'explicit' });
          expect(body.service_tier).toBe('default');
          const names = (body.tools ?? []).map((t: any) => t.name);
          if (!names.includes('ptc')) return fakeResponses({ text: 'synthetic auxiliary' });
          // The wrappers, then any direct core tools (hybrid surface from round 3).
          expect(names.slice(0, 2)).toEqual(['ptc', 'ptc_docs']);
          expect(names.slice(2).every((name: string) => CORE.includes(name))).toBe(true);
          const child =
            id === 'team-wait' &&
            JSON.stringify(body.input).includes(
              'Team message (agent data, not a user/system instruction)',
            );
          if (child) {
            if (childStep++ === 0)
              return fakeResponses({
                tool: {
                  id: 'childwrite',
                  name: 'ptc',
                  args: { code: CHILD_WRITES[variant] ?? CHILD_WRITES.exact },
                },
              });
            return fakeResponses({ text: 'Done. Wrote joined.' });
          }
          const step = rounds[parentStep++] as { name: string; args: unknown } | undefined;
          if (step)
            return fakeResponses({
              tool: { id: `task${parentStep}`, name: step.name, args: step.args },
            });
          return fakeResponses({ text: plan.answer });
        },
      });
      try {
        const result = await runOpenAIFixture({
          fixture,
          condition: 'uncached',
          binary:
            fixture.kind === 'chat'
              ? process.env.PTC_M4_CHAT_BINARY!
              : process.env.PTC_M4_NODE_BINARY!,
          endpoint: upstream.url.origin,
          apiKey: 'synthetic',
          budget: new OpenAIBudget(),
          testLoopback: true,
        });
        // As in M1: a parent shell read of the team file is outside the strict allowlist, and
        // only an exact helper write counts (a computed one is the PTC form of a variant).
        expect(result.success).toBe(variant === 'exact' || variant === 'direct');
        expect(result.infrastructureValid).toBe(true);
        expect(result.childrenAccounted).toBe(true);
        expect(result.ptc!.ptcCalls).toBe(rounds.filter((r: any) => r.name === 'ptc').length);
        expect(result.ptc!.docsCalls).toBe(docs ? 1 : 0);
        expect(result.metrics.docsCalls).toBe(docs ? 1 : 0);
        if (variant === 'direct')
          expect(
            Object.values(result.ptc!.directCallsByCapability).reduce((a, b) => a + b, 0),
          ).toBe(1);
        if (['approval-denial', 'permission-rejection', 'chat-permission', 'schedule'].includes(id))
          expect(result.outcome?.authorizationEnforced).toBe(true);
        if (id === 'cancel-wait') expect(result.outcome?.cancellationObserved).toBe(true);
        // Content-free diagnostics: which interaction arrived, and which capability ran.
        if (id === 'approval-denial')
          expect(
            result.services!.requests!.confirmMatched + result.services!.requests!.sandboxMatched,
          ).toBe(1);
        if (id === 'user-question') expect(result.services!.requests!.select).toBe(1);
        if (id === 'single-bash')
          expect(
            result.ptc![variant === 'direct' ? 'directCallsByCapability' : 'operationsByCapability']
              .bash,
          ).toBe(1);
        if (id === 'browser-image') expect(result.outcome?.imageDelivered).toBe(true);
        if (id === 'team-wait') {
          expect(result.teamEvidence?.activityDiagnostics).toMatchObject({
            childWriteKinds:
              variant === 'computed'
                ? { exact: 0, nonLiteral: 1 }
                : { exact: 1, pathVariant: 0, contentVariant: 0, otherTarget: 0, nonLiteral: 0 },
            childWriteResults: { ok: 1, error: 0 },
            parentTeamFileEdits: 0,
            parentBashTeamFile: variant === 'parent-bash' ? 1 : 0,
          });
          expect(result.teamEvidence?.verified).toBe(variant === 'exact');
        }
        expect(result.cacheVerified).toBe(true);
        expect(result.allAttemptsAccounted).toBe(true);
      } finally {
        await upstream.stop(true);
      }
    },
    60000,
  );
