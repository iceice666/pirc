/**
 * Web search for agents (`web.search` in agent-ops.ts), run by the gateway so
 * the search API key never reaches a node, where an agent's shell could read
 * it. Backed by Exa (https://exa.ai/docs/search/quickstart): each result is
 * a title, URL and query-relevant highlights; agents read whole pages with
 * `web_fetch`.
 */
import { z } from 'zod';
import { ApiError } from '../errors.js';

export const WEB_SEARCH_MAX_RESULTS = 10;
const DEFAULT_RESULTS = 5;
/** Highlight characters Exa returns per result. */
const HIGHLIGHT_CHARS = 1500;
const TIMEOUT_MS = 20_000;
const CACHE_TTL_MS = 15 * 60_000;
const CACHE_LIMIT = 100;
const EXA_URL = 'https://api.exa.ai/search';

const domain = z
  .string()
  .min(1)
  .max(253)
  .regex(
    /^(?:\*\.)?[a-zA-Z0-9.-]+(?:\/[^\s]*)?$/,
    'a domain such as example.com or example.com/docs',
  );
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date as YYYY-MM-DD');

export const webSearchArgs = z
  .object({
    query: z.string().trim().min(1).max(500),
    count: z.number().int().min(1).max(WEB_SEARCH_MAX_RESULTS).optional(),
    includeDomains: z.array(domain).min(1).max(20).optional(),
    excludeDomains: z.array(domain).min(1).max(20).optional(),
    publishedAfter: date.optional(),
    publishedBefore: date.optional(),
    category: z.enum(['news', 'publication']).optional(),
  })
  .strict()
  .refine((args) => !(args.includeDomains && args.excludeDomains), {
    message: 'Use includeDomains or excludeDomains, not both',
  });
export type WebSearchArgs = z.infer<typeof webSearchArgs>;

export interface WebSearchResult {
  title: string;
  url: string;
  published?: string;
  author?: string;
  highlights: string[];
}
export interface WebSearchAnswer {
  results: WebSearchResult[];
  cached: boolean;
}

const exaResponse = z.object({
  results: z.array(
    z
      .object({
        url: z.string(),
        title: z.string().nullish(),
        publishedDate: z.string().nullish(),
        author: z.string().nullish(),
        highlights: z.array(z.string()).nullish(),
      })
      .passthrough(),
  ),
});

function httpUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url.href.slice(0, 2048)
      : undefined;
  } catch {
    return undefined;
  }
}

export class WebSearch {
  private readonly cache = new Map<string, { at: number; results: WebSearchResult[] }>();

  constructor(
    private readonly apiKey: string | undefined,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  get configured(): boolean {
    return !!this.apiKey;
  }

  async search(args: WebSearchArgs, signal?: AbortSignal): Promise<WebSearchAnswer> {
    if (!this.apiKey)
      throw new ApiError(
        503,
        'runner_unavailable',
        'Web search is not configured on the gateway (set EXA_API_KEY)',
      );
    const count = args.count ?? DEFAULT_RESULTS;
    const key = JSON.stringify({ ...args, count, query: args.query.toLowerCase() });
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < CACHE_TTL_MS) return { results: hit.results, cached: true };
    if (hit) this.cache.delete(key);

    const body = {
      query: args.query,
      type: 'auto',
      numResults: count,
      contents: { highlights: { maxCharacters: HIGHLIGHT_CHARS } },
      ...(args.includeDomains ? { includeDomains: args.includeDomains } : {}),
      ...(args.excludeDomains ? { excludeDomains: args.excludeDomains } : {}),
      ...(args.publishedAfter
        ? { startPublishedDate: `${args.publishedAfter}T00:00:00.000Z` }
        : {}),
      ...(args.publishedBefore
        ? { endPublishedDate: `${args.publishedBefore}T23:59:59.999Z` }
        : {}),
      ...(args.category ? { category: args.category } : {}),
    };
    let response: Response;
    try {
      response = await this.fetchFn(EXA_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': this.apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), ...(signal ? [signal] : [])]),
        redirect: 'error',
      });
    } catch (error) {
      if (signal?.aborted) throw new ApiError(499, 'aborted', 'Web search cancelled');
      const timeout = (error as Error)?.name === 'TimeoutError';
      throw new ApiError(
        504,
        'node_timeout',
        timeout ? 'Web search timed out' : 'Web search could not reach the search service',
      );
    }
    // Never reflect upstream bodies: they may echo request headers.
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      const status = response.status;
      if (status === 400 || status === 422)
        throw new ApiError(
          400,
          'invalid_input',
          'The search service rejected these search options',
        );
      if (status === 401 || status === 403)
        throw new ApiError(502, 'node_error', 'The gateway web search key was rejected');
      if (status === 429 || status === 402)
        throw new ApiError(429, 'too_many_requests', 'Web search rate limit or credit exceeded');
      throw new ApiError(502, 'node_error', `The search service failed (HTTP ${status})`);
    }
    let parsed: z.infer<typeof exaResponse>;
    try {
      parsed = exaResponse.parse(await response.json());
    } catch {
      throw new ApiError(502, 'node_error', 'The search service returned an unexpected answer');
    }
    const results: WebSearchResult[] = [];
    for (const item of parsed.results.slice(0, count)) {
      const url = httpUrl(item.url);
      if (!url) continue;
      const published = item.publishedDate?.slice(0, 10);
      results.push({
        title: (item.title ?? '').trim().slice(0, 300) || url,
        url,
        ...(published && /^\d{4}-\d{2}-\d{2}$/.test(published) ? { published } : {}),
        ...(item.author?.trim() ? { author: item.author.trim().slice(0, 200) } : {}),
        highlights: (item.highlights ?? [])
          .map((text) => text.trim())
          .filter(Boolean)
          .slice(0, 5)
          .map((text) => text.slice(0, HIGHLIGHT_CHARS)),
      });
    }
    this.cache.set(key, { at: this.now(), results });
    while (this.cache.size > CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value!);
    return { results, cached: false };
  }
}
