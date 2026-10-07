/** Public-benchmark fixtures: split, order, loading and the sandboxed oracle. */
import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { POLYGLOT_NAMES, loadPolyglot, polyglotSplit } from './ptc-m1/polyglot.js';
import { exerciseOrder } from './ptc-m1/m4-polyglot.js';
import { runOpenAIFixture } from './ptc-m1/openai-runner.js';
import { OpenAIBudget } from './ptc-m1/openai-budget.js';
import { fakeResponses } from './ptc-m1/openai-fake.js';

test('the split is fixed before tuning: 15 development and 19 holdout exercises', () => {
  expect(POLYGLOT_NAMES).toHaveLength(34);
  const dev = POLYGLOT_NAMES.filter((name) => polyglotSplit(name) === 'dev');
  expect(dev).toEqual([
    'beer-song',
    'food-chain',
    'grade-school',
    'hangman',
    'paasio',
    'pig-latin',
    'poker',
    'proverb',
    'react',
    'rest-api',
    'sgf-parsing',
    'variable-length-quantity',
    'wordy',
    'zebra-puzzle',
    'zipper',
  ]);
});

test('the holdout order interleaves the arms and alternates which goes first', () => {
  const fixtures = [{ id: 'a' }, { id: 'b' }] as never[];
  expect(
    exerciseOrder(fixtures, ['main', 'ptc'], 2).map((p) => `${p.trial}:${p.fixture}:${p.arm}`),
  ).toEqual([
    '0:a:main',
    '0:a:ptc',
    '0:b:ptc',
    '0:b:main',
    '1:a:ptc',
    '1:a:main',
    '1:b:main',
    '1:b:ptc',
  ]);
});

const dataset = process.env.PTC_POLYGLOT_DIR;
test.skipIf(!dataset)('loads pinned files without the example solution', async () => {
  const fixtures = await loadPolyglot(dataset!, 'dev');
  expect(fixtures).toHaveLength(15);
  for (const fixture of fixtures) {
    expect(Object.keys(fixture.files).some((file) => file.includes('.meta'))).toBe(false);
    expect(fixture.prompt).toMatch(/python3 -m unittest -q [a-z_]+_test/);
  }
});

// The real-srt fake-model run: a scripted solution written with ptc, then the sandboxed oracle.
test.skipIf(!dataset || !process.env.PTC_M4_NODE_BINARY)(
  'a solved exercise passes the sandboxed pristine tests; an unsolved one fails',
  async () => {
    const [fixture] = (await loadPolyglot(dataset!, 'dev')).filter(
      (f) => f.exercise.name === 'proverb',
    );
    const example = await readFile(
      path.join(dataset!, 'python/exercises/practice/proverb/.meta/example.py'),
      'utf8',
    );
    for (const solve of [true, false]) {
      let step = 0;
      const upstream = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        async fetch(req) {
          const body = (await req.json()) as any;
          if (!(body.tools ?? []).some((t: any) => t.name === 'ptc'))
            return fakeResponses({ text: 'synthetic auxiliary' });
          if (step++ === 0 && solve)
            return fakeResponses({
              tool: {
                id: 'w',
                name: 'ptc',
                args: {
                  code: `await tools.write({ path: 'proverb.py', content: ${JSON.stringify(example)} });
return (await tools.bash({ command: 'python3 -m unittest -q proverb_test' })).exitCode;`,
                },
              },
            });
          return fakeResponses({ text: 'Done.' });
        },
      });
      try {
        const result = await runOpenAIFixture({
          fixture: fixture!,
          condition: 'uncached',
          binary: process.env.PTC_M4_NODE_BINARY!,
          endpoint: upstream.url.origin,
          apiKey: 'synthetic',
          budget: new OpenAIBudget(),
          testLoopback: true,
        });
        expect(result.infrastructureValid).toBe(true);
        expect(result.success).toBe(solve);
        expect(result.outcome?.filesMatch).toBe(solve);
        expect((result.outcome as { testsRun?: number | null }).testsRun).toBe(8);
      } finally {
        await upstream.stop(true);
      }
    }
  },
  120000,
);
