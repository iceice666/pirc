import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '../src/agent/agent.js';
import { loadAgentConfig } from '../src/agent/config.js';
import type { Feature } from '../src/agent/feature.js';
import type { AssistantMessage, CustomMessage } from '../src/agent/messages.js';
import { teamFeature } from '../src/agent/features/team/index.js';
import { RpcUi } from '../src/agent/rpc.js';
import { SessionStore } from '../src/agent/session-store.js';
import type { Tool } from '../src/agent/tools/types.js';
import { testModels } from './agent-harness.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function harness(
  options: {
    features?: Feature[];
    tools?: Tool[];
    replies?: AssistantMessage['content'][];
    timeout?: number;
    onCall?: (agent: Agent, call: number) => void;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'pirc-completion-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const config = loadAgentConfig(workspace, testModels('http://127.0.0.1:1'), {
    PIRC_CONFIG_DIR: join(root, 'config'),
  });
  config.limits.completionWaitMs = options.timeout ?? 1000;
  const events: any[] = [];
  let calls = 0;
  let agent: Agent;
  agent = new Agent({
    config,
    store: new SessionStore(join(root, 'session'), workspace),
    ui: new RpcUi((e) => events.push(e)),
    hasUI: true,
    features: options.features ?? [],
    tools: options.tools ?? [],
    emit: (e) => events.push(e),
    streamOverride: async (request) => {
      options.onCall?.(agent, calls);
      const content = options.replies?.[calls] ?? [{ type: 'text' as const, text: 'final' }];
      calls++;
      return {
        role: 'assistant',
        content,
        api: 'openai-chat',
        provider: request.providerName,
        model: request.model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
        stopReason: content.some((p) => p.type === 'toolCall') ? 'toolUse' : 'stop',
        timestamp: Date.now(),
      };
    },
  });
  cleanup.push(async () => {
    await agent.shutdown();
    rmSync(root, { recursive: true, force: true });
  });
  await agent.init();
  return { agent, events, calls: () => calls };
}

function notice(id: string): Omit<CustomMessage, 'role' | 'timestamp'> {
  return {
    customType: 'agent-team',
    content: `report ${id}`,
    display: true,
    details: { event: { id, to: 'parent', body: `report ${id}` } },
  };
}
const call = (name: string): AssistantMessage['content'] => [
  { type: 'toolCall', id: 'call', name, arguments: {} },
];

describe('completion notification admission', () => {
  it('deduplicates only fully returned direct inbox IDs, retaining omitted and truncated events', async () => {
    const feature = teamFeature();
    const original = feature.tools!;
    feature.tools = (agent) => original(agent).filter((tool) => tool.name !== 'agent_inbox');
    const h = await harness({
      features: [feature],
      replies: [call('agent_inbox')],
      tools: [
        {
          name: 'agent_inbox',
          description: 'test inbox',
          parameters: {},
          async execute() {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    items: [
                      { id: 'read', to: 'parent', body: 'report read' },
                      { id: 'preview', to: 'parent', body: 'preview', truncated: true },
                    ],
                  }),
                },
              ],
            };
          },
        },
      ],
      onCall(agent, n) {
        if (n === 0)
          for (const id of ['read', 'preview', 'other'])
            agent.deliver(notice(id), { deliverAs: 'followUp' });
      },
    });
    h.agent.prompt('go');
    await h.agent.idle();
    const admitted = h.agent.store
      .allMessages()
      .filter((m) => m.role === 'custom')
      .map((m: any) => m.details?.event?.id);
    expect(admitted).toEqual(['preview', 'other']);
    expect(h.calls()).toBe(2); // tool answer, then final with both reports already in context
  });

  it('does not acknowledge inbox data hidden inside a PTC-like outer tool result', async () => {
    const feature = teamFeature();
    const original = feature.tools!;
    feature.tools = (agent) => original(agent).filter((tool) => tool.name !== 'agent_inbox');
    const h = await harness({
      features: [feature],
      replies: [call('code')],
      tools: [
        {
          name: 'agent_inbox',
          description: 'test inbox',
          parameters: {},
          async execute() {
            return {
              content: [
                { type: 'text', text: JSON.stringify({ items: [{ id: 'unseen', to: 'parent' }] }) },
              ],
            };
          },
        },
        {
          name: 'code',
          description: 'discard nested result',
          parameters: {},
          async execute(_args, ctx) {
            await h.agent.invokeTool('agent_inbox', {}, ctx.signal);
            return { content: [{ type: 'text', text: 'discarded' }] };
          },
        },
      ],
      onCall(agent, n) {
        if (n === 0) agent.deliver(notice('unseen'), { deliverAs: 'followUp' });
      },
    });
    h.agent.prompt('go');
    await h.agent.idle();
    expect(
      h.agent.store.allMessages().some((m) => m.role === 'custom' && m.content === 'report unseen'),
    ).toBe(true);
  });
});

describe('runtime completion barrier', () => {
  it('parks without LLM polling, wakes on state change and drains a result arriving with completion', async () => {
    let active = true;
    let waiting!: () => void;
    const parked = new Promise<void>((resolve) => {
      waiting = resolve;
    });
    const h = await harness({
      features: [
        {
          name: 'worker',
          completionBlockers() {
            waiting();
            return active ? ['worker'] : [];
          },
        },
      ],
    });
    h.agent.prompt('go');
    await parked;
    expect(h.agent.isRunning).toBe(true);
    expect(h.calls()).toBe(1);
    expect(h.events.some((e) => e.type === 'agent_settled')).toBe(false);
    active = false;
    h.agent.completionChanged();
    h.agent.deliver(notice('done'), { deliverAs: 'followUp' });
    await h.agent.idle();
    expect(h.calls()).toBe(2);
    expect(h.events.filter((e) => e.type === 'agent_start')).toHaveLength(1);
    expect(h.events.filter((e) => e.type === 'agent_settled')).toHaveLength(1);
  });

  it('rechecks a state change during waiter registration without a lost wakeup', async () => {
    let active = true;
    const h = await harness({
      features: [
        {
          name: 'worker',
          completionBlockers(agent) {
            if (!active) return [];
            active = false;
            agent.completionChanged();
            return ['stale snapshot'];
          },
        },
      ],
    });
    h.agent.prompt('go');
    await h.agent.idle();
    expect(h.calls()).toBe(1);
    expect(
      h.agent.store
        .allMessages()
        .some((m) => m.role === 'custom' && m.customType === 'completion-timeout'),
    ).toBe(false);
  });

  it('retains cleared team notices across Stop and replays them before the next user model call', async () => {
    const h = await harness({
      features: [teamFeature()],
      onCall(agent, n) {
        if (n !== 0) return;
        agent.deliver(notice('retained'), { deliverAs: 'followUp' });
        agent.clearQueue();
        agent.abort();
      },
    });
    h.agent.prompt('go');
    await h.agent.idle();
    expect(h.calls()).toBe(1);
    expect(h.agent.store.allMessages().some((m) => m.role === 'custom')).toBe(false);
    h.agent.prompt('continue');
    await h.agent.idle();
    expect(h.calls()).toBe(2);
    expect(
      h.agent.store
        .allMessages()
        .filter((m) => m.role === 'custom' && (m.details as any)?.event?.id === 'retained'),
    ).toHaveLength(1);
  });

  it('keeps a report queued at maxTurns for a fresh run instead of acknowledging unseen data', async () => {
    const h = await harness({
      features: [teamFeature()],
      onCall(agent, n) {
        if (n === 0) agent.deliver(notice('limit'), { deliverAs: 'followUp' });
      },
    });
    h.agent.config.limits.maxTurns = 1;
    h.agent.prompt('go');
    await h.agent.idle();
    // settle starts the report's continuation after the first run ends.
    await h.agent.idle();
    expect(h.calls()).toBe(2);
    expect(
      h.agent.store
        .allMessages()
        .filter((m) => m.role === 'custom' && (m.details as any)?.event?.id === 'limit'),
    ).toHaveLength(1);
  });

  it('times out once, explicitly reports pending work, and does not claim worker completion', async () => {
    const h = await harness({
      timeout: 10,
      features: [{ name: 'worker', completionBlockers: () => ['unfinished'] }],
    });
    h.agent.prompt('go');
    await h.agent.idle();
    expect(h.calls()).toBe(2);
    const notices = h.agent.store
      .allMessages()
      .filter((m) => m.role === 'custom' && m.customType === 'completion-timeout');
    expect(notices).toHaveLength(1);
    expect((notices[0] as CustomMessage).content).toContain('have NOT completed');
  });
});
