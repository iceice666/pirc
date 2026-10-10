/**
 * Records what the TS gateway's inference (GatewayInference + pi-adapter +
 * pi-ai 0.73.1, or a native transport) does for scripted provider
 * responses: the HTTP requests it sends, the deltas it reports and the
 * final assistant message. `cargo test -p pirc-providers --test parity`
 * replays the same responses against the Rust port and compares.
 *
 * Each `groups/<name>.ts` exports its `scenarios`; they are recorded into
 * `fixtures/<name>.json`.
 *
 * Re-record (from the repository root):
 *   bun crates/pirc-providers/tests/parity/record.ts           every group
 *   bun crates/pirc-providers/tests/parity/record.ts anthropic  one group
 */
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { GatewayInference } from '../../../../apps/gateway/src/backends/inference.ts';
import { modelsSchema } from '../../../../apps/gateway/src/models.ts';
import type { Json, Scenario } from './common.ts';

let current: Scenario | undefined;
let recorded: Json[] = [];
let responseIndex = 0;

const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url);
    const headers: Record<string, string> = {};
    req.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const text = await req.text();
    let body: Json;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    recorded.push({ method: req.method, path: url.pathname + url.search, headers, body });
    const response = current!.responses[responseIndex++];
    if (!response) return new Response('no scripted response', { status: 599 });
    if ('status' in response)
      return new Response(response.body, {
        status: response.status,
        headers: {
          ...(response.contentType ? { 'content-type': response.contentType } : {}),
          ...(response.headers ?? {}),
        },
      });
    const { chunks, hang } = response;
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        for (const part of chunks) {
          await Bun.sleep(5);
          controller.enqueue(encoder.encode(part));
        }
        if (!hang) {
          controller.close();
          return;
        }
        await new Promise<void>((resolve) =>
          req.signal.aborted ? resolve() : req.signal.addEventListener('abort', () => resolve()),
        );
      },
    });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
  },
});
const root = `http://127.0.0.1:${server.port}`;
const base = `${root}/v1`;

const substitute = (value: Json): Json =>
  JSON.parse(JSON.stringify(value).replaceAll('{BASE}', base).replaceAll('{ROOT}', root));
const unsubstitute = (value: Json): Json =>
  JSON.parse(JSON.stringify(value).replaceAll(base, '{BASE}').replaceAll(root, '{ROOT}'));

async function record(scenarios: Scenario[]): Promise<Json[]> {
  const results: Json[] = [];
  for (const scenario of scenarios) {
    current = scenario;
    recorded = [];
    responseIndex = 0;
    if (scenario.longCacheRetention) process.env.PI_CACHE_RETENTION = 'long';
    else delete process.env.PI_CACHE_RETENTION;
    const models = modelsSchema.parse(substitute(scenario.models));
    const inference = new GatewayInference({
      async resolve(providerName, modelId) {
        const provider = Object.hasOwn(models.providers, providerName)
          ? models.providers[providerName]
          : undefined;
        const model = provider?.models.find((entry) => entry.id === modelId);
        if (!provider || !model) throw new Error('Backend or authorization session not found');
        return {
          provider: structuredClone(provider),
          model: structuredClone(model),
          apiKey: provider.apiKey,
        };
      },
    });
    const deltas: Json[] = [];
    const message = await inference.run(
      substitute(scenario.request),
      new AbortController().signal,
      (delta) => {
        deltas.push(structuredClone(delta));
        if (deltas.length === scenario.cancelAfterDeltas) inference.cancelAll();
      },
      scenario.nodeId ?? 'node-1',
    );
    results.push({
      ...unsubstitute(scenario),
      expected: {
        requests: unsubstitute(recorded),
        deltas: unsubstitute(deltas),
        message: unsubstitute({ ...message, timestamp: 0 }),
      },
    });
  }
  return results;
}

const groupsDir = path.join(import.meta.dir, 'groups');
const fixturesDir = path.join(import.meta.dir, 'fixtures');
mkdirSync(fixturesDir, { recursive: true });
const wanted = process.argv.slice(2);
const groups = readdirSync(groupsDir)
  .filter((file) => file.endsWith('.ts'))
  .map((file) => file.slice(0, -3))
  .filter((name) => !wanted.length || wanted.includes(name))
  .sort();
for (const name of wanted)
  if (!groups.includes(name)) throw new Error(`no parity group ${name} in ${groupsDir}`);
for (const name of groups) {
  const { scenarios } = (await import(path.join(groupsDir, `${name}.ts`))) as {
    scenarios: Scenario[];
  };
  const results = await record(scenarios);
  const out = path.join(fixturesDir, `${name}.json`);
  writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);
  console.log(`${name}: wrote ${results.length} scenarios to ${path.relative(process.cwd(), out)}`);
}
server.stop(true);
