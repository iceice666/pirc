import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';
import {
  buildCompactionProjection,
  foldLedger,
  hashId,
  renderSummary,
  type Observation,
} from '../src/agent/features/memory/ledger.js';
import { poolMetrics, selectDrops } from '../src/agent/features/memory/agents.js';
import { recall } from '../src/agent/features/memory/index.js';
import type { SessionEntry } from '../src/agent/session-store.js';
import { settledAfter, startAgent, type AgentProcess } from './agent-harness.js';

let n = 0;
const msg = (role: 'user' | 'assistant', text: string): SessionEntry => {
  const id = `m${++n}`;
  return role === 'user'
    ? {
        id,
        parentId: null,
        timestamp: 0,
        type: 'message',
        message: { role, content: text, timestamp: 0 },
      }
    : {
        id,
        parentId: null,
        timestamp: 0,
        type: 'message',
        message: {
          role,
          content: [{ type: 'text', text }],
          api: 'openai-chat',
          provider: 'p',
          model: 'm',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
          stopReason: 'stop',
          timestamp: 0,
        },
      };
};
const obs = (
  content: string,
  source: string,
  relevance: Observation['relevance'] = 'medium',
): Observation => ({
  id: hashId(content),
  content,
  timestamp: '2026-01-01 10:00',
  relevance,
  sourceEntryIds: [source],
  tokenCount: 10,
});
const custom = (customType: string, data: unknown): SessionEntry => ({
  id: `c${++n}`,
  parentId: null,
  timestamp: 0,
  type: 'custom',
  customType,
  data,
});

describe('memory ledger', () => {
  it('folds first-wins observations with drop tombstones', () => {
    const a = msg('user', 'hello');
    const o1 = obs('User said hello', a.id);
    const branch = [
      a,
      custom('om.observations.recorded', { observations: [o1, o1], coversUpToId: a.id }),
      custom('om.observations.dropped', {
        observationIds: [o1.id, 'ffffffffffff'],
        coversUpToId: a.id,
      }),
      custom('om.observations.recorded', { observations: [{ bogus: true }], coversUpToId: a.id }),
    ];
    const folded = foldLedger(branch);
    expect(folded.observations).toHaveLength(1);
    expect(folded.activeObservations).toHaveLength(0);
  });

  it('keeps reflections frozen until a full fold', () => {
    const a = msg('user', 'one');
    const b = msg('user', 'two');
    const c = msg('user', 'three');
    const o1 = obs('first fact', a.id);
    const o2 = obs('second fact', b.id);
    const branch = [
      a,
      b,
      c,
      custom('om.observations.recorded', { observations: [o1], coversUpToId: a.id }),
      custom('om.observations.recorded', { observations: [o2], coversUpToId: b.id }),
      custom('om.reflections.recorded', {
        reflections: [
          {
            id: hashId('durable'),
            content: 'durable',
            supportingObservationIds: [o1.id],
            tokenCount: 2,
          },
        ],
        coversUpToId: b.id,
      }),
      custom('om.observations.dropped', { observationIds: [o1.id], coversUpToId: a.id }),
    ];
    // Cut at b: only observations covering <= b's index... o2 covers b (index 1) so included.
    const normal = buildCompactionProjection(branch, c.id, 1000);
    expect(normal.fullFold).toBe(false);
    expect(normal.observations.map((o) => o.content)).toEqual(['first fact', 'second fact']);
    expect(normal.reflections).toEqual([]);
    const full = buildCompactionProjection(branch, c.id, 15);
    expect(full.fullFold).toBe(true);
    expect(full.observations.map((o) => o.content)).toEqual(['second fact']);
    expect(full.reflections.map((r) => r.content)).toEqual(['durable']);
    // Observations after the cut are excluded (kept raw instead).
    const early = buildCompactionProjection(branch, a.id, 1000);
    expect(early.observations.map((o) => o.content)).toEqual(['first fact']);
    expect(renderSummary(full.reflections, full.observations)).toContain(
      `## Reflections\n[${hashId('durable')}] durable\n\n## Observations\n[${o2.id}] 2026-01-01 10:00 [medium] second fact`,
    );
  });

  it('sizes and orders drops', () => {
    const items = [obs('a', 'x', 'high'), obs('b', 'x', 'low'), obs('c', 'x', 'low')];
    const metrics = poolMetrics(items, 10);
    expect(metrics.ready).toBe(true);
    const reflections = [
      { id: hashId('r'), content: 'r', supportingObservationIds: [items[2]!.id], tokenCount: 1 },
    ];
    expect(selectDrops([items[0]!.id, items[1]!.id, items[2]!.id], items, reflections, 2)).toEqual([
      items[2]!.id,
      items[1]!.id,
    ]);
  });

  it('recalls sources behind observations and reflections', () => {
    const a = msg('user', 'my name is Ada');
    const o1 = obs('User stated their name is Ada', a.id, 'high');
    const r = {
      id: hashId('User is Ada'),
      content: 'User is Ada',
      supportingObservationIds: [o1.id],
      tokenCount: 3,
    };
    const branch = [
      a,
      custom('om.observations.recorded', { observations: [o1], coversUpToId: a.id }),
      custom('om.reflections.recorded', { reflections: [r], coversUpToId: a.id }),
    ];
    const byObs = recall(branch, o1.id);
    expect(byObs.status).toBe('ok');
    expect(byObs.text).toContain('my name is Ada');
    const byRef = recall(branch, r.id);
    expect(byRef.text).toContain('Reflections:');
    expect(byRef.text).toContain('Sources:');
    expect(recall(branch, 'XYZ').status).toBe('invalid_id');
    expect(recall(branch, 'aaaaaaaaaaaa').status).toBe('not_found');
  });
});

const agents: AgentProcess[] = [];
afterEach(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.close()));
});

describe('observational memory agent flow', () => {
  it('observes in the background and uses memory as the compaction summary', async () => {
    const agent = await startAgent({
      config: {
        features: {
          observationalMemory: {
            observeAfterTokens: 5,
            reflectAfterTokens: 1_000_000,
            compactAfterTokens: 1_000_000,
            showWorkerNotifications: false,
          },
          compaction: { keepRecentTokens: 1 },
        },
      },
    });
    agents.push(agent);
    const isWorker = (body: any) =>
      body.messages?.[0]?.content?.startsWith?.('You are the observation agent');
    let observed = false;
    agent.llm.route = (body) => {
      if (!isWorker(body)) return undefined;
      if (observed || body.messages.at(-1).role === 'tool') return { text: 'Observed.' };
      const chunk = body.messages.at(-1).content as string;
      const match = /\[Source entry id: (\w+)\]\n\[User/.exec(chunk);
      if (!match) return { text: 'Nothing new.' };
      observed = true;
      return {
        tool: {
          id: 'obs',
          name: 'record_observations',
          args: {
            observations: [
              {
                timestamp: '2026-09-25 10:00',
                content: 'User stated their name is Ada.',
                relevance: 'high',
                sourceEntryIds: [match[1]],
              },
            ],
          },
        },
      };
    };
    agent.llm.push({ text: 'Nice to meet you, Ada.' });
    const from = agent.events.length;
    await agent.send({ type: 'prompt', message: 'Hi, my name is Ada and I like tea.' });
    await settledAfter(agent, from);
    const deadline = Date.now() + 5000;
    const sessionFile = path.join(agent.sessionDir, 'session.jsonl');
    while (
      !readFileSync(sessionFile, 'utf8').includes('om.observations.recorded') &&
      Date.now() < deadline
    )
      await Bun.sleep(20);
    expect(readFileSync(sessionFile, 'utf8')).toContain('User stated their name is Ada.');
    const observerRequest = agent.llm.requests.find(
      (r) => isWorker(r.body) && r.body.messages.at(-1).content.includes?.('my name is Ada'),
    )!;
    expect(observerRequest.body.tools[0].function.name).toBe('record_observations');
    expect(observerRequest.body.messages.at(-1).content).toContain('my name is Ada');

    // Second turn, then compact: summary comes from memory (no summarizer LLM call).
    agent.llm.push({ text: 'Tea it is.' });
    const second = agent.events.length;
    await agent.send({ type: 'prompt', message: 'What do I like?' });
    await settledAfter(agent, second);
    // Stop any further background consolidation from consuming scripted replies.
    const before = agent.llm.requests.length;
    const compacted = await agent.send({ type: 'compact' });
    expect(compacted.success).toBe(true);
    expect(compacted.data.summary).toContain('## Observations');
    expect(compacted.data.summary).toContain('User stated their name is Ada.');
    const summarizerCalls = agent.llm.requests
      .slice(before)
      .filter((r) => r.body.tool_choice === 'none' && !isWorker(r.body));
    expect(summarizerCalls).toHaveLength(0);
    // Model can recall the observation id.
    const id = /\[([a-f0-9]{12})\] 2026-09-25 10:00 \[high\]/.exec(compacted.data.summary)![1]!;
    agent.llm.push({ tool: { id: 'r', name: 'recall', args: { id } } }, { text: 'done' });
    const third = agent.events.length;
    await agent.send({ type: 'prompt', message: 'recall it' });
    await settledAfter(agent, third);
    const end = agent.events.findLast((e) => e.type === 'tool_execution_end');
    expect(end!.result.content[0].text).toContain('Hi, my name is Ada');
  });

  it('falls back to another model when the memory model is rate limited', async () => {
    const agent = await startAgent({
      config: {
        features: {
          observationalMemory: {
            observeAfterTokens: 5,
            model: { provider: 'fakeclaude', id: 'claude-x' },
            fallbackModels: [{ provider: 'fake', id: 'fake-model' }],
            showWorkerNotifications: false,
          },
        },
      },
    });
    agents.push(agent);
    const workerCalls: string[] = [];
    agent.llm.route = (body, requestPath) => {
      const system =
        typeof body.system === 'string'
          ? body.system
          : Array.isArray(body.system)
            ? body.system.map((part: any) => part.text).join('')
            : body.messages?.[0]?.content;
      if (!String(system).startsWith('You are the observation agent')) return undefined;
      workerCalls.push(requestPath);
      if (requestPath === '/v1/messages')
        return { status: 429, body: '{"error":{"message":"rate limit exceeded"}}' };
      return { text: 'Nothing new.' };
    };
    const waitCalls = async (count: number) => {
      const deadline = Date.now() + 3000;
      while (workerCalls.length < count && Date.now() < deadline) await Bun.sleep(20);
    };
    const from = agent.events.length;
    await agent.send({ type: 'prompt', message: 'first message with content' });
    await settledAfter(agent, from);
    await waitCalls(1);
    expect(workerCalls[0]).toBe('/v1/messages');
    await Bun.sleep(100);
    const again = agent.events.length;
    await agent.send({ type: 'prompt', message: 'second message' });
    await settledAfter(agent, again);
    await waitCalls(2);
    expect(workerCalls[1]).toBe('/v1/chat/completions');
    const warning = agent.events.find(
      (e) =>
        e.type === 'extension_ui_request' &&
        /using fallback fake\/fake-model/.test(e.message ?? ''),
    );
    expect(warning).toBeTruthy();
  });
});
