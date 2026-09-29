import { describe, expect, it } from 'bun:test';
import { WebSearch, webSearchArgs } from '../src/daemon/web-search.js';
import { ApiError } from '../src/errors.js';

type Call = { url: string; init: RequestInit };

function fakeFetch(responses: Array<() => Response>) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error('unexpected fetch');
    return next();
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const exaResults = {
  results: [
    {
      url: 'https://bun.sh/docs',
      title: 'Bun docs',
      publishedDate: '2026-09-01T00:00:00.000Z',
      author: 'Oven',
      highlights: ['  Bun is a fast runtime.  ', ''],
    },
    { url: 'javascript:alert(1)', title: 'bad' },
    { url: 'https://example.com/x', title: null, highlights: null },
  ],
  costDollars: { total: 0.007 },
};

async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected a rejection');
}

describe('gateway web search (Exa)', () => {
  it('sends the key only to Exa and normalizes results', async () => {
    const { fn, calls } = fakeFetch([() => json(exaResults)]);
    const search = new WebSearch('exa-key', fn);
    const answer = await search.search(
      webSearchArgs.parse({
        query: 'bun runtime',
        count: 3,
        includeDomains: ['bun.sh'],
        publishedAfter: '2026-01-01',
        category: 'news',
      }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.exa.ai/search');
    expect((calls[0]!.init.headers as Record<string, string>)['x-api-key']).toBe('exa-key');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      query: 'bun runtime',
      type: 'auto',
      numResults: 3,
      contents: { highlights: { maxCharacters: 1500 } },
      includeDomains: ['bun.sh'],
      startPublishedDate: '2026-01-01T00:00:00.000Z',
      category: 'news',
    });
    expect(answer).toEqual({
      cached: false,
      results: [
        {
          title: 'Bun docs',
          url: 'https://bun.sh/docs',
          published: '2026-09-01',
          author: 'Oven',
          highlights: ['Bun is a fast runtime.'],
        },
        { title: 'https://example.com/x', url: 'https://example.com/x', highlights: [] },
      ],
    });
  });

  it('caches identical searches for a while', async () => {
    let now = 1_000_000;
    const { fn, calls } = fakeFetch([() => json(exaResults), () => json({ results: [] })]);
    const search = new WebSearch('k', fn, () => now);
    await search.search(webSearchArgs.parse({ query: 'Bun' }));
    const again = await search.search(webSearchArgs.parse({ query: 'bun' }));
    expect(again.cached).toBe(true);
    expect(calls).toHaveLength(1);
    now += 16 * 60_000;
    expect((await search.search(webSearchArgs.parse({ query: 'bun' }))).results).toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it('never reflects upstream error bodies', async () => {
    const leaky = () => json({ error: 'bad key exa-key' }, 401);
    const { fn } = fakeFetch([
      leaky,
      () => json({}, 429),
      () => json({}, 500),
      () => json({ x: 1 }),
    ]);
    const search = new WebSearch('exa-key', fn);
    const args = (query: string) => webSearchArgs.parse({ query });
    const unauthorized = await rejection(search.search(args('a')));
    expect(unauthorized.message).not.toContain('exa-key');
    expect(unauthorized.statusCode).toBe(502);
    expect((await rejection(search.search(args('b')))).code).toBe('too_many_requests');
    expect((await rejection(search.search(args('c')))).message).toContain('HTTP 500');
    expect((await rejection(search.search(args('d')))).message).toContain('unexpected answer');
  });

  it('is off without a key', async () => {
    const { fn, calls } = fakeFetch([]);
    const error = await rejection(new WebSearch(undefined, fn).search({ query: 'x' }));
    expect(error.statusCode).toBe(503);
    expect(error.message).toContain('EXA_API_KEY');
    expect(calls).toHaveLength(0);
  });

  it('validates arguments', () => {
    expect(webSearchArgs.safeParse({ query: ' ' }).success).toBe(false);
    expect(webSearchArgs.safeParse({ query: 'x', count: 11 }).success).toBe(false);
    expect(webSearchArgs.safeParse({ query: 'x', publishedAfter: 'yesterday' }).success).toBe(
      false,
    );
    expect(
      webSearchArgs.safeParse({ query: 'x', includeDomains: ['a.com'], excludeDomains: ['b.com'] })
        .success,
    ).toBe(false);
    expect(webSearchArgs.safeParse({ query: 'x', includeDomains: ['*.a.com/docs'] }).success).toBe(
      true,
    );
    expect(webSearchArgs.safeParse({ query: 'x', extra: 1 }).success).toBe(false);
  });
});
