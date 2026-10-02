import { afterEach, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Agent } from '../src/agent/agent.js';
import { loadAgentConfig } from '../src/agent/config.js';
import {
  captureContext,
  joinPrompt,
  readContext,
  trimSections,
  withReportedUsage,
  type ContextSnapshot,
} from '../src/agent/context.js';
import { RpcUi } from '../src/agent/rpc.js';
import { SessionStore } from '../src/agent/session-store.js';
import type { StreamRequest } from '../src/agent/providers/types.js';
import { settledAfter, startAgent, testModels, type AgentProcess } from './agent-harness.js';
const roots: string[] = [];
const agents: AgentProcess[] = [];
afterEach(async () => {
  await Promise.all(agents.splice(0).map((a) => a.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const section = (text: string) => ({ id: 'test', title: 'Test', source: 'built-in', text });
it('keeps feature joining byte-identical including interior whitespace', () => {
  for (const strings of [
    ['  first ', ' second  '],
    ['', '\n ', 'third', '\t'],
    ['  ', '\n'],
    ['a', ' ', 'b'],
  ])
    expect(joinPrompt(trimSections(strings.map(section)))).toBe(
      strings
        .filter(Boolean)
        .map((s) => '\n\n' + s)
        .join('')
        .trim(),
    );
});
it('accounts for memory within messages and scales input including cache without counting output', () => {
  const snapshot = captureContext({
    sections: [section('system')],
    tools: [],
    messages: [
      { role: 'compactionSummary', summary: 'x'.repeat(400), tokensBefore: 1000, timestamp: 1 },
    ],
    model: { provider: 'p', id: 'm', contextWindow: 1000 },
    memoryTokens: 30,
  });
  expect(snapshot.usage.buckets).toMatchObject({ messages: 70, memory: 30 });
  const scaled = withReportedUsage(snapshot, {
    input: 100,
    cacheRead: 200,
    cacheWrite: 50,
    output: 999,
    totalTokens: 1349,
  });
  expect(scaled.usage.reportedInput).toBe(350);
  expect(scaled.usage.remaining).toBe(650);
  expect(scaled.usage.scale * scaled.usage.estimatedInput).toBe(350);
  expect(snapshot.usage.reportedInput).toBeUndefined();
});
it('captures the exact last turn request and persists only public snapshot fields, mode 0600', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pirc-context-'));
  roots.push(root);
  const store = new SessionStore(path.join(root, 'session'), root);
  const requests: StreamRequest[] = [];
  let done!: () => void;
  const settled = new Promise<void>((resolve) => (done = resolve));
  const agent = new Agent({
    config: loadAgentConfig(root, testModels('http://127.0.0.1:1'), {
      PIRC_CONFIG_DIR: path.join(root, 'config'),
    }),
    store,
    ui: new RpcUi(() => {}),
    hasUI: false,
    tools: [
      {
        name: 'echo',
        description: 'Echo tool',
        parameters: { type: 'object' },
        execute: async () => ({ content: [{ type: 'text', text: 'tool response' }] }),
      },
    ],
    features: [
      {
        name: 'custom-section',
        beforeAgentStart: async () => ({ systemPrompt: '  exact feature\n' }),
      },
    ],
    emit: (event) => {
      if (event.type === 'agent_settled') done();
    },
    streamOverride: async (request) => {
      requests.push(request);
      expect(
        readContext(store.dir)
          ?.sections.map((s) => s.text)
          .join('\n\n'),
      ).toBe(request.systemPrompt);
      return {
        role: 'assistant',
        content:
          requests.length === 1
            ? [{ type: 'toolCall', id: 'call', name: 'echo', arguments: {} }]
            : [{ type: 'text', text: 'final output not input' }],
        api: 'openai-chat',
        provider: request.providerName,
        model: request.model.id,
        usage: { input: 42, cacheRead: 8, cacheWrite: 0, output: 5, totalTokens: 55 },
        stopReason: requests.length === 1 ? 'toolUse' : 'stop',
        timestamp: Date.now(),
      };
    },
  });
  try {
    await agent.init();
    agent.prompt('user input');
    await settled;
    expect(requests).toHaveLength(2);
    const last = agent.lastContext!;
    expect(joinPrompt(last.sections)).toBe(requests[1]!.systemPrompt);
    expect(last.sections.find((s) => s.id === 'custom-section')?.source).toBe(
      'feature:custom-section',
    );
    expect(last.tools.map(({ estimatedTokens, ...tool }) => tool)).toEqual(requests[1]!.tools);
    expect(last.usage.reportedInput).toBe(50);
    expect(readContext(store.dir)).toEqual(last);
    expect(statSync(path.join(store.dir, 'context.json')).mode & 0o777).toBe(0o600);
    const raw = readFileSync(path.join(store.dir, 'context.json'), 'utf8');
    expect(raw).not.toContain('test-key');
    expect(raw).not.toContain('final output not input');
    expect(raw).not.toContain('user input');
    expect(readFileSync(store.file, 'utf8')).not.toContain('estimatedInput');
  } finally {
    await agent.shutdown();
  }
});
it('exposes get_context through real agent RPC and leaves a stopped snapshot', async () => {
  const agent = await startAgent();
  agents.push(agent);
  expect((await agent.send({ type: 'get_context' })).data).toBeNull();
  agent.llm.push({ text: 'Hello' });
  await agent.send({ type: 'prompt', message: 'hello' });
  await settledAfter(agent, 0);
  const snapshot = (await agent.send({ type: 'get_context' })).data as ContextSnapshot;
  expect((await agent.send({ type: 'get_context', maxBytes: 1024 })).data).toBeNull();
  expect((await agent.send({ type: 'get_state' })).success).toBe(true);
  expect(snapshot.version).toBe(1);
  expect(snapshot.sections.some((s) => s.id === 'cwd')).toBe(true);
  expect(snapshot.tools.length).toBeGreaterThan(0);
  expect(readContext(agent.sessionDir)?.id).toBe(snapshot.id);
});
