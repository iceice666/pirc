import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';
import { Agent } from '../src/agent/agent.js';
import { capabilities } from '../src/agent/capabilities.js';
import { loadAgentConfig } from '../src/agent/config.js';
import { presentSection } from '../src/agent/features/assistant/index.js';
import { RpcUi } from '../src/agent/rpc.js';
import { SessionStore } from '../src/agent/session-store.js';
import { builtinTools } from '../src/agent/tools/index.js';
import { text, type Tool } from '../src/agent/tools/types.js';
import { settledAfter, startAgent, testModels, type AgentProcess } from './agent-harness.js';

const agents: AgentProcess[] = [];
afterEach(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.close()));
});

const CHAT = { PIRC_GATEWAY: '1', PIRC_WORKSPACE_KIND: 'chat' };
const ALL_OFF = {
  version: 1,
  delegation: false,
  memory_search: false,
  remote_recall: false,
  schedules: false,
  web_search: false,
};
const context = (extra: Record<string, unknown> = {}) => ({
  enabled: true,
  user: [],
  notes: [],
  usage: { user: { used: 0, max: 2000 }, note: { used: 0, max: 8000 } },
  pendingProposals: 0,
  workspaces: [{ id: 'work:repo', name: 'repo', node: 'work', online: true }],
  ...extra,
});
const GATED = ['delegate', 'delegation_status', 'memory_search', 'schedule', 'web_search'];

async function chat(options: Parameters<typeof startAgent>[0] = {}) {
  const agent = await startAgent({ env: CHAT, ...options });
  agents.push(agent);
  const answered = new Set<string>();
  const next = async (op: string) => {
    const request = await agent.waitFor(
      (event) => event.type === 'gateway_request' && event.op === op && !answered.has(event.id),
    );
    answered.add(request.id);
    return request;
  };
  const ok = (request: Record<string, any>, result: unknown) =>
    agent.raw({ type: 'gateway_response', id: request.id, ok: true, result });
  const tools = () =>
    (agent.llm.requests.at(-1)!.body.tools ?? []).map(
      (tool: any) => tool.function?.name ?? tool.name,
    ) as string[];
  const system = () => String(agent.llm.requests.at(-1)!.body.messages[0].content);
  const prompt = async (message: string, result: unknown) => {
    const from = agent.events.length;
    await agent.send({ type: 'prompt', message });
    ok(await next('assistant.context'), result);
    await settledAfter(agent, from);
  };
  return { agent, next, ok, tools, system, prompt };
}

describe('project capabilities in the agent', () => {
  it('allows everything by default, and follows the gateway policy on the next run', async () => {
    const { agent, tools, system, prompt } = await chat();
    // No policy in the context (an older gateway) means everything is allowed.
    await prompt('hi', context());
    for (const name of GATED) expect(tools()).toContain(name);
    expect(system()).toContain('## Workspaces');
    expect(system()).toContain('search them with memory_search');

    await prompt('again', context({ capabilities: ALL_OFF }));
    for (const name of GATED) expect(tools()).not.toContain(name);
    // Local recall stays; its description no longer points at memory_search.
    expect(tools()).toContain('recall');
    const recall = (agent.llm.requests.at(-1)!.body.tools as any[]).find(
      (tool) => (tool.function?.name ?? tool.name) === 'recall',
    );
    expect(JSON.stringify(recall)).not.toContain('memory_search');
    // The frozen snapshot still has the workspaces, but they are no longer shown.
    expect(system()).not.toContain('## Workspaces');
    expect(system()).not.toContain('memory_search');
  }, 20_000);

  it('blocks /cron when schedules are disabled, checking the gateway first', async () => {
    const { agent, next, ok } = await chat();
    await agent.send({ type: 'prompt', message: '/cron' });
    ok(await next('assistant.context'), context({ capabilities: ALL_OFF }));
    const shown = await agent.waitFor(
      (e) =>
        e.type === 'extension_ui_request' &&
        e.method === 'notify' &&
        /schedules capability is disabled/.test(e.message),
    );
    expect(shown.notifyType).toBe('error');
    await Bun.sleep(100);
    expect(
      agent.events.some((e) => e.type === 'gateway_request' && e.op.startsWith('schedule.')),
    ).toBe(false);
  });

  it('blocks /cron from the configured policy outside chats', async () => {
    const agent = await startAgent({
      env: { PIRC_GATEWAY: '1' },
      capabilities: { schedules: false },
    });
    agents.push(agent);
    await agent.send({ type: 'prompt', message: '/cron' });
    await agent.waitFor(
      (e) =>
        e.type === 'extension_ui_request' &&
        e.method === 'notify' &&
        /schedules capability is disabled/.test(e.message),
    );
    expect(agent.events.some((e) => e.type === 'gateway_request')).toBe(false);
  });

  it('strips guidance for disabled capabilities from a frozen memory section', () => {
    const section = [
      '## Memory',
      '',
      'notes',
      '',
      '## Workspaces',
      '',
      "The user's repositories you can hand tasks to with delegate. Online status is as of this chat's start. Their coding sessions keep notes there (workspace memory): search them with memory_search, and open a note's sources with recall.",
      '[work:repo] repo on work',
    ].join('\n');
    const all = capabilities();
    expect(presentSection(section, all)).toBe(section);
    expect(presentSection(section, { ...all, delegation: false })).toBe('## Memory\n\nnotes');
    const noSearch = presentSection(section, { ...all, memory_search: false });
    expect(noSearch).toContain('hand tasks to with delegate');
    expect(noSearch).not.toContain('memory_search');
    expect(noSearch).not.toContain('recall');
    const noRecall = presentSection(section, { ...all, remote_recall: false });
    expect(noRecall).toContain('search them with memory_search.');
    expect(noRecall).not.toContain('recall');
  });
});

describe('subagent capabilities', () => {
  const fake = (name: string): Tool => ({
    name,
    description: name,
    parameters: { type: 'object', properties: {} },
    execute: async () => text(`${name} ran`),
  });
  const make = (options: { allowedTools?: string[]; capabilities?: unknown }) => {
    const root = mkdtempSync(path.join(tmpdir(), 'pirc-caps-'));
    const workspace = path.join(root, 'workspace');
    mkdirSync(workspace);
    return new Agent({
      config: loadAgentConfig(workspace, testModels('http://127.0.0.1:1'), {
        PIRC_CONFIG_DIR: path.join(root, 'config'),
      }),
      store: new SessionStore(path.join(root, 'session'), workspace),
      ui: new RpcUi(() => {}),
      hasUI: false,
      tools: [...builtinTools(), fake('web_search'), fake('schedule')],
      emit: () => {},
      ...(options.allowedTools ? { allowedTools: options.allowedTools } : {}),
      capabilities: capabilities(options.capabilities),
    });
  };

  it("is the intersection of the parent's policy and the kind's allowlist", async () => {
    // The kind allows web_search and schedule, but the parent project disabled web_search.
    const child = make({
      allowedTools: ['read', 'web_search', 'schedule'],
      capabilities: { web_search: false },
    });
    await child.init();
    expect(child.toolList.map((tool) => tool.name).sort()).toEqual(['read', 'schedule']);
    const result = await child.invokeTool('web_search', {}, new AbortController().signal);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('web_search capability is disabled');
    // A kind allowlist cannot add back what it does not list, even if the parent allows it.
    const narrow = make({ allowedTools: ['read'], capabilities: {} });
    await narrow.init();
    expect(narrow.toolList.map((tool) => tool.name)).toEqual(['read']);
  });
});
