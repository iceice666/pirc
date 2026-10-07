import { CORE_CAPABILITIES } from '../src/agent/ptc/signatures.js';
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startAgent, settledAfter } from './agent-harness.js';
import { ptcCall, type Reply } from './fixtures/fake-llm.js';
import { FIXTURES } from './ptc-m1/fixtures.js';
import { syntheticScreenshot } from './ptc-m1/image.js';
import { roleCapabilities, validateDocsRequest } from './ptc-m1/contracts.js';

// Deliberately scripted, local-only protocol smoke; NEVER a model performance baseline.
// Every step is a ptc script running one capability: the only model-facing tools are ptc and ptc_docs.
const CORE: readonly string[] = CORE_CAPABILITIES;
const call = (name: string, args: Record<string, unknown>, id = name): Reply => ({
  tool: ptcCall(id, name, args),
});
const scripts: Record<string, Reply[]> = {
  'single-bash': [call('bash', { command: 'printf PTC_BASH_OK' })],
  'single-read': [call('read', { path: 'token.txt' })],
  'multi-edit': ['a.txt', 'b.txt', 'c.txt'].map((file) =>
    call('edit', { path: file, oldText: 'red', newText: 'blue' }, file),
  ),
  'dependent-edit': [
    call('read', { path: 'pointer.txt' }),
    call('edit', { path: 'target.txt', oldText: 'old', newText: 'new' }),
  ],
  'output-filter': [call('read', { path: 'values.txt' })],
  // The script gets the screenshot as a host-held image descriptor, never its bytes.
  'browser-image': [
    {
      tool: {
        id: 'browser_screenshot',
        name: 'ptc',
        args: {
          code: `const r = await tools.call("browser_screenshot", {});
if (!r.ok) throw new PtcError(r.error);
return { url: r.data.url, images: r.data.images.map((i) => i.mimeType), attachments: r.attachments.length };`,
        },
      },
    },
  ],
  'user-question': [
    call('ask_user_question', {
      questions: [{ question: 'alpha or beta?', options: [{ label: 'alpha' }, { label: 'beta' }] }],
    }),
  ],
  'approval-denial': [call('bash', { command: 'git push --force nowhere' })],
  'background-build': [
    call('background_task', { action: 'start', command: 'printf built > build.txt' }),
    {
      dynamic: (body) =>
        call(
          'background_task',
          { action: 'wait', id: String(body.messages.at(-1).content).split(' ')[0] },
          'wait',
        ),
    },
  ],
  'team-wait': [
    call('agent_spawn', {
      name: 'fixturehelper',
      task: 'write team.txt containing exactly joined',
    }),
    call('agent_wait', { agent: 'fixturehelper', timeout: 10 }),
  ],
  schedule: [
    call('schedule', {
      action: 'create',
      prompt: 'Check synthetic CI',
      title: 'fixture',
      cron: '0 9 * * *',
      timezone: 'UTC',
    }),
  ],
  'permission-rejection': [call('web_search', { query: 'fixture permission test' })],
  'cancel-wait': [
    call('ask_user_question', {
      questions: [{ question: 'alpha or beta?', options: [{ label: 'alpha' }, { label: 'beta' }] }],
    }),
  ],
  'chat-web-search': [call('web_search', { query: 'fixture search token' })],
  'chat-permission': [call('background_task', { action: 'start', command: 'true' })],
};

for (const fixture of FIXTURES) {
  test(`PTC M1 disposable RPC smoke: ${fixture.id}`, async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'pirc-ptc-fixture-'));
    const workspace = path.join(root, 'workspace');
    mkdirSync(workspace);
    for (const [name, content] of Object.entries(fixture.files))
      writeFileSync(path.join(workspace, name), content);
    const binary =
      fixture.kind === 'chat' ? process.env.PTC_CHAT_BINARY : process.env.PTC_NODE_BINARY;
    const agent = await startAgent({
      ...(binary ? { executable: path.resolve(binary) } : {}),
      role: fixture.kind === 'chat' ? 'chat' : 'node',
      workspace,
      // Never pass the invoking agent/node environment or credentials to a fixture.
      baseEnv: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, TMPDIR: root },
      env: {
        PIRC_GATEWAY: '1',
        PIRC_BROWSER: '1',
        PIRC_WORKSPACE_KIND: fixture.kind === 'chat' ? 'chat' : 'coding',
      },
      capabilities: fixture.id === 'permission-rejection' ? { web_search: false } : {},
    });
    const harnessRoot = path.dirname(agent.configDir);
    try {
      if (fixture.id === 'team-wait') {
        const parent = [...scripts[fixture.id]!, { text: 'joined' } as Reply];
        const child: Reply[] = [
          call('write', { path: 'team.txt', content: 'joined' }),
          { text: 'joined' },
        ];
        agent.llm.route = (body) => {
          const isChild = JSON.stringify(body.messages).includes('Team message (agent data');
          return (isChild ? child.shift() : parent.shift()) ?? { text: 'joined' };
        };
      } else agent.llm.push(...scripts[fixture.id]!, { text: fixture.answer ?? 'done' });
      const from = agent.events.length;
      const started = performance.now();
      await agent.send({ type: 'prompt', message: fixture.prompt });
      if (fixture.kind === 'chat') {
        const context = await agent.waitFor(
          (event) => event.type === 'gateway_request' && event.op === 'assistant.context',
        );
        agent.raw({ type: 'gateway_response', id: context.id, ok: true, result: {} });
      }
      if (fixture.service === 'question' || fixture.service === 'cancel') {
        const dialog = await agent.waitFor(
          (event) => event.type === 'extension_ui_request' && event.method === 'select',
        );
        if (fixture.service === 'cancel') await agent.send({ type: 'abort' });
        else agent.raw({ type: 'extension_ui_response', id: dialog.id, value: 'beta' });
      } else if (fixture.service === 'denial') {
        const dialog = await agent.waitFor((event) => event.method === 'confirm');
        agent.raw({ type: 'extension_ui_response', id: dialog.id, confirmed: false });
      } else if (fixture.service === 'schedule' || fixture.service === 'search') {
        const request = await agent.waitFor(
          (event) => event.type === 'gateway_request' && event.op !== 'assistant.context',
        );
        expect(request.op).toBe(fixture.service === 'schedule' ? 'schedule.create' : 'web.search');
        agent.raw({
          type: 'gateway_response',
          id: request.id,
          ok: true,
          result:
            fixture.service === 'schedule'
              ? { proposalId: 'fixture-proposal', status: 'pending_approval', title: 'fixture' }
              : {
                  cached: false,
                  results: [
                    {
                      title: 'PTC_SEARCH_23',
                      url: 'https://example.invalid/fixture',
                      highlights: ['synthetic'],
                    },
                  ],
                },
        });
      } else if (fixture.service === 'browser') {
        const request = await agent.waitFor((event) => event.type === 'browser_request');
        expect(request.op).toBe('screenshot');
        agent.raw({
          type: 'browser_response',
          id: request.id,
          ok: true,
          result: {
            image: syntheticScreenshot(),
            mimeType: 'image/png',
            url: 'https://example.invalid/fixture',
            title: 'synthetic',
          },
        });
      }
      await settledAfter(agent, from);
      expect(performance.now() - started).toBeGreaterThan(0);
      const all = agent.events.slice(from).filter((event) => event.type === 'tool_execution_end');
      // The model calls only ptc; its capabilities run inside it and are observed
      // under their own names, linked to the ptc call.
      const ends = all.filter((event) => !event.parentToolCallId);
      const inner = all.filter((event) => event.parentToolCallId);
      expect(ends.length).toBeGreaterThan(0);
      expect(ends.every((event) => event.toolName === 'ptc')).toBe(true);
      const outerIds = new Set(ends.map((event) => event.toolCallId));
      expect(inner.every((event) => outerIds.has(event.parentToolCallId))).toBe(true);
      expect(inner.every((event) => event.toolName !== 'ptc')).toBe(true);
      const toolNames = (agent.llm.requests[0]!.body.tools ?? []).map(
        (tool: any) => tool.function?.name ?? tool.name,
      );
      // Hybrid surface: the wrappers, then whichever core capabilities are direct tools here.
      expect(toolNames.slice(0, 2)).toEqual(['ptc', 'ptc_docs']);
      expect(toolNames.slice(2).every((name: string) => CORE.includes(name))).toBe(true);
      if (fixture.service === 'permission' || fixture.service === 'denial') {
        expect(ends.some((event) => event.isError)).toBe(true);
        // Refused before anything ran (unavailable capability) or by the user (declined).
        expect(JSON.stringify(ends)).toContain(
          fixture.service === 'denial' ? 'ApprovalDenied' : 'CapabilityUnavailable',
        );
        expect(
          agent.events.some(
            (event) => event.type === 'gateway_request' && event.op !== 'assistant.context',
          ),
        ).toBe(false);
      } else if (fixture.service !== 'cancel')
        expect(ends.every((event) => !event.isError)).toBe(true);
      if (fixture.service === 'browser') {
        const end = ends[0]!;
        // The script read a page: its result comes fenced as untrusted web content.
        const fenced = /<<<PTC_RESULT id=\w+>>>\n([\s\S]*)\n<<<END_PTC_RESULT/.exec(
          end.result.content[0].text,
        )!;
        expect(JSON.parse(fenced[1]!)).toEqual({
          url: 'https://example.invalid/fixture',
          images: ['image/png'],
          attachments: 1,
        });
        // The screenshot itself is in the operation's own result, as for a direct call.
        expect(inner[0]).toMatchObject({ toolName: 'browser_screenshot', isError: false });
        expect(inner[0]!.result.content.some((part: any) => part.type === 'image')).toBe(true);
        expect(end.result.details.operations).toMatchObject([
          { capability: 'browser_screenshot', outcome: 'completed' },
        ]);
        // Not attached by the script: the model gets no image.
        expect(
          ends.some((event) => event.result.content.some((part: any) => part.type === 'image')),
        ).toBe(false);
      }
      if (fixture.service === 'question') expect(JSON.stringify(ends)).toContain('beta');
      if (fixture.service === 'schedule') expect(JSON.stringify(ends)).toContain('approve');
      if (fixture.service === 'cancel')
        expect(
          agent.events.some(
            (event) => event.type === 'extension_ui_request' && event.method === 'cancel',
          ),
        ).toBe(true);
      for (const [name, content] of Object.entries(fixture.expectedFiles ?? {}))
        expect(readFileSync(path.join(workspace, name), 'utf8')).toBe(content);
      if (fixture.id === 'single-bash' || fixture.id === 'single-read')
        expect(JSON.stringify(ends)).toContain(fixture.answer!);
      // Fake usage is intentionally not emitted as performance evidence.
      expect(agent.llm.requests.length).toBeGreaterThan(0);
    } finally {
      await agent.close();
      rmSync(harnessRoot, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
}

test('M1 role and discovery contract examples fail closed', () => {
  expect(
    roleCapabilities(['read', 'code', 'ptc', 'ptc_docs', 'unknown'], new Set(['read'])),
  ).toEqual({
    capabilities: ['read'],
    warnings: [
      'Ignored wrapper name: code',
      'Ignored wrapper name: ptc',
      'Ignored wrapper name: ptc_docs',
      'Unknown or unavailable capability: unknown',
    ],
    modelTools: ['ptc', 'ptc_docs'],
  });
  expect(roleCapabilities(['unknown'], new Set()).modelTools).toEqual([]);
  expect(() => validateDocsRequest({ names: ['read'], category: 'files' })).toThrow(
    'InvalidArguments',
  );
  expect(() => validateDocsRequest({ cursor: 'not-bound-to-category' })).toThrow(
    'InvalidArguments',
  );
  expect(() => validateDocsRequest({ names: Array(9).fill('read') })).toThrow('InvalidArguments');
  expect(() => validateDocsRequest({ category: 'files' })).not.toThrow();
});
