import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';
import { settledAfter, startAgent, type AgentProcess } from './agent-harness.js';
import { startFakeLlm } from './fixtures/fake-llm.js';

const agents: AgentProcess[] = [];
afterEach(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.close()));
});
const start = async (options: Parameters<typeof startAgent>[0] = {}) => {
  // These tests cover the default LLM summarizer; memory has its own tests.
  const config = options.config ?? {};
  const features = (config.features ?? {}) as Record<string, unknown>;
  const agent = await startAgent({
    ...options,
    config: { ...config, features: { ...features, observationalMemory: { enabled: false } } },
  });
  agents.push(agent);
  return agent;
};
const prompt = async (agent: AgentProcess, message: string) => {
  const from = agent.events.length;
  await agent.send({ type: 'prompt', message });
  await settledAfter(agent, from);
};

describe('compaction', () => {
  it('compacts manually, keeps the cache prefix and replaces history for the model', async () => {
    const agent = await start({ config: { features: { compaction: { keepRecentTokens: 1 } } } });
    agent.llm.push({ text: 'answer one' }, { text: 'answer two' });
    await prompt(agent, 'first question');
    await prompt(agent, 'second question');
    agent.llm.push({ text: '## Goal\nSUMMARY-TEXT' });
    const response = await agent.send({
      type: 'compact',
      customInstructions: 'focus on questions',
    });
    expect(response.success).toBe(true);
    expect(response.data.summary).toContain('SUMMARY-TEXT');
    const summarize = agent.llm.requests[2]!.body;
    // Same prefix as a normal turn (system prompt + history), then the instruction.
    expect(summarize.messages[0]).toEqual(agent.llm.requests[1]!.body.messages[0]);
    expect(summarize.tools.length).toBe(agent.llm.requests[1]!.body.tools.length);
    expect(summarize.tool_choice).toBe('none');
    expect(summarize.messages.at(-1).content).toContain('focus on questions');
    expect(summarize.messages.map((m: any) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
    ]);
    expect(agent.events.some((e) => e.type === 'compaction_start')).toBe(true);
    agent.llm.push({ text: 'third' });
    await prompt(agent, 'third question');
    const after = agent.llm.requests[3]!.body.messages;
    expect(after[1].content).toContain('SUMMARY-TEXT');
    expect(after.map((m: any) => m.content)).not.toContain('first question');
    expect(after.map((m: any) => m.content)).toContain('second question');
    // UI history still has everything plus the summary marker.
    const messages = await agent.send({ type: 'get_messages' });
    expect(messages.data.messages.map((m: any) => m.role)).toContain('compactionSummary');
    expect(JSON.stringify(messages.data.messages)).toContain('first question');
  });

  it('compacts automatically when usage approaches the context window', async () => {
    const agent = await start({
      config: { features: { compaction: { reserveTokens: 10_000, keepRecentTokens: 1 } } },
    });
    agent.llm.push(
      { text: 'big answer', promptTokens: 95_000 },
      { text: 'AUTO-SUMMARY' },
      { text: 'after compaction' },
    );
    await prompt(agent, 'fill context');
    await prompt(agent, 'next');
    expect(agent.llm.requests).toHaveLength(3);
    expect(agent.llm.requests[1]!.body.tool_choice).toBe('none');
    expect(agent.llm.requests[2]!.body.messages[1].content).toContain('AUTO-SUMMARY');
    const end = agent.events.find((e) => e.type === 'compaction_end');
    expect(end!.reason).toBe('threshold');
  });

  it('recovers from a context overflow error by compacting and retrying', async () => {
    const agent = await start();
    agent.llm.push({ text: 'ok' });
    await prompt(agent, 'setup');
    agent.llm.push(
      {
        status: 400,
        body: '{"error":{"message":"This model\'s maximum context length is 1000 tokens"}}',
      },
      { text: 'OVERFLOW-SUMMARY' },
      { text: 'recovered' },
    );
    await prompt(agent, 'huge');
    const final = agent.events.findLast(
      (e) => e.type === 'message_end' && e.message.role === 'assistant',
    );
    expect(final!.message.content[0].text).toBe('recovered');
    const retried = agent.llm.requests.at(-1)!.body.messages;
    expect(retried[1].content).toContain('OVERFLOW-SUMMARY');
    // The failed reply was not persisted.
    const lines = readFileSync(path.join(agent.sessionDir, 'session.jsonl'), 'utf8');
    expect(lines).not.toContain('maximum context length');
  });

  it('supports /compact as a slash command', async () => {
    const agent = await start();
    agent.llm.push({ text: 'a' }, { text: 'b' });
    await prompt(agent, 'one');
    await prompt(agent, 'two');
    agent.llm.push({ text: 'SLASH-SUMMARY' });
    await agent.send({ type: 'prompt', message: '/compact' });
    const notice = await agent.waitFor(
      (e) =>
        e.type === 'extension_ui_request' && e.method === 'notify' && /Compacted/.test(e.message),
    );
    expect(notice).toBeTruthy();
  });

  it('warms the prompt cache after compaction for long-retention providers', async () => {
    const llm = startFakeLlm();
    const warm = await start({
      llm,
      config: {
        providers: {
          fake: {
            api: 'openai-chat',
            baseUrl: `${llm.url}/v1`,
            apiKey: 'k',
            compat: { supportsLongCacheRetention: true, sendSessionAffinityHeaders: true },
            models: [{ id: 'fake-model', contextWindow: 100_000, maxTokens: 1000 }],
          },
        },
      },
    });
    llm.push({ text: 'a' }, { text: 'b' }, { text: 'WARM-SUMMARY' }, { text: 'x' });
    await prompt(warm, 'one');
    await prompt(warm, 'two');
    await warm.send({ type: 'compact' });
    const deadline = Date.now() + 3000;
    while (llm.requests.length < 4 && Date.now() < deadline) await Bun.sleep(20);
    const body = llm.requests[3]!.body;
    expect(body.max_completion_tokens).toBe(16);
    expect(body.prompt_cache_retention).toBe('24h');
    expect(body.prompt_cache_key).toBe(llm.requests[0]!.body.prompt_cache_key);
    expect(body.messages[1].content).toContain('WARM-SUMMARY');
    await warm.close();
    agents.splice(agents.indexOf(warm), 1);
    llm.stop();
  });
});
