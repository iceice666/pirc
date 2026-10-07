import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { LiveBudget, LIVE_MODEL } from './ptc-m1/live-budget.js';
import { startLiveProvider, type AttemptSummary } from './ptc-m1/live-provider.js';
import { startMeasuredAgent } from './ptc-m1/live-driver.js';
import { FIXTURES } from './ptc-m1/fixtures.js';

// This is genuine Linux/srt/cgroup transport smoke, never real-model success evidence.
for (const kind of ['coding', 'chat'] as const)
  test.skipIf(!process.env.PTC_LINUX_NODE_BINARY || !process.env.PTC_LINUX_CHAT_BINARY)(
    `real srt/cgroup JSONL smoke (${kind})`,
    async () => {
      const root = await mkdtemp('/tmp/ptc-i-');
      await writeFile(`${root}/private-sentinel`, 'PROVIDER_PRIVATE_SENTINEL');
      let privateSocket = '';
      let probed = false;
      let confinementResult = '';
      const upstream = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        async fetch(request) {
          const body = (await request.json()) as any;
          const probe =
            !probed &&
            Array.isArray(body.tools) &&
            body.tools.some((tool: any) => tool.name === 'bash');
          if (probe) probed = true;
          const command = `cat '${root}/private-sentinel'; mv '${privateSocket}' '${privateSocket}.stolen'`;
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
            {
              type: 'content_block_start',
              index: 0,
              content_block: probe
                ? { type: 'tool_use', id: 'probe-private', name: 'bash', input: {} }
                : { type: 'text', text: '' },
            },
            {
              type: 'content_block_delta',
              index: 0,
              delta: probe
                ? { type: 'input_json_delta', partial_json: JSON.stringify({ command }) }
                : { type: 'text_delta', text: 'synthetic ready' },
            },
            { type: 'content_block_stop', index: 0 },
            {
              type: 'message_delta',
              delta: { stop_reason: probe ? 'tool_use' : 'end_turn' },
              usage: { output_tokens: 4 },
            },
            { type: 'message_stop' },
          ];
          return new Response(
            events
              .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
              .join(''),
            { headers: { 'content-type': 'text/event-stream' } },
          );
        },
      });
      const summaries: AttemptSummary[] = [];
      let provider: Awaited<ReturnType<typeof startLiveProvider>> | undefined;
      let agent: Awaited<ReturnType<typeof startMeasuredAgent>> | undefined;
      try {
        provider = await startLiveProvider({
          stateDir: root,
          endpoint: upstream.url.origin,
          apiKey: 'synthetic',
          budget: new LiveBudget({ limitUsd: 100, priorUnits: 0 }),
          onAttempt: (value) => summaries.push(value),
          testLoopback: true,
        });
        privateSocket = `${root}/${(await readdir(root)).find((name) => name.startsWith('i-'))}/socket`;
        agent = await startMeasuredAgent({
          binary:
            kind === 'coding'
              ? process.env.PTC_LINUX_NODE_BINARY!
              : process.env.PTC_LINUX_CHAT_BINARY!,
          fixture: FIXTURES.find((f) => f.kind === kind)!,
          models: provider.models,
          providerStateDir: root,
          onEvent({ value }, reply) {
            if (value.type === 'tool_execution_end' && value.toolCallId === 'probe-private')
              confinementResult = JSON.stringify(value.result);
            if (value.type === 'extension_ui_request' && value.method === 'confirm')
              reply({ type: 'extension_ui_response', id: value.id, confirmed: true });
            if (value.type === 'gateway_request')
              reply({
                type: 'gateway_response',
                id: value.id,
                ok: value.op === 'assistant.context',
                result: {},
                error: 'Synthetic capability unavailable',
              });
          },
        });
        const result = await agent.prompt();
        const drain = await provider.waitForQuiet({ quietMs: 100, timeoutMs: 5000 });
        expect(drain.waitMs).toBeGreaterThanOrEqual(95);
        expect(result.wallMs).toBeGreaterThan(0);
        expect(result.startupMs).toBeGreaterThan(0);
        expect(result.cpuMs).toBeGreaterThanOrEqual(0);
        expect(result.cgroupMemoryPeakBytes).toBeGreaterThan(0);
        expect(result.memoryWindow).toBe('unit-start-through-post-settled-sample');
        expect(result.resourceEndLagMs).toBeGreaterThanOrEqual(0);
        expect(probed).toBe(true);
        expect(confinementResult).not.toContain('PROVIDER_PRIVATE_SENTINEL');
        expect(confinementResult).toMatch(/No such file|Permission denied|Read-only/);
        expect(await Bun.file(`${privateSocket}.stolen`).exists()).toBe(false);
      } finally {
        const agentResult = await Promise.allSettled([agent?.close()]);
        const services = await Promise.allSettled([provider?.close(), upstream.stop(true)]);
        await rm(root, { recursive: true, force: true });
        expect([...agentResult, ...services].every((result) => result.status === 'fulfilled')).toBe(
          true,
        );
      }
      expect(summaries.length).toBeGreaterThan(0);
      expect(summaries.every((s) => s.usage !== null)).toBe(true);
    },
    60000,
  );
