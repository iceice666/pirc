/** OpenCode's public model list, pinned separately from pi-ai's release cycle. */
import { createHash } from 'node:crypto';

export const OPENCODE_SOURCES = {
  metadata: 'https://models.dev/api.json',
  opencode: 'https://opencode.ai/inference/v1/models',
  'opencode-go': 'https://opencode.ai/inference/go/v1/models',
} as const;

const APIS: Record<string, string> = {
  '@ai-sdk/openai-compatible': 'openai-completions',
  '@ai-sdk/openai': 'openai-responses',
  '@ai-sdk/anthropic': 'anthropic-messages',
};

type SourceModel = {
  name: string;
  reasoning: boolean;
  provider?: { npm?: string; api?: string };
  limit: { context: number; output: number };
  modalities: { input: string[] };
  interleaved?: boolean | { field: string };
};
type SourceProvider = { npm: string; api: string; models: Record<string, SourceModel> };
export type OpenCodeModel = {
  id: string;
  name: string;
  api: string;
  provider: string;
  baseUrl: string;
  reasoning: boolean;
  input: string[];
  contextWindow: number;
  maxTokens: number;
  compat?: Record<string, unknown>;
};

/** No guessed limits/protocols: only live IDs with OpenCode provider metadata. */
export function openCodeCatalog(
  metadata: Record<string, SourceProvider>,
  live: Record<string, { data: { id: string }[] }>,
) {
  const providers: Record<string, OpenCodeModel[]> = {};
  const omitted: Record<string, { id: string; reason: string }[]> = {};
  for (const provider of ['opencode', 'opencode-go']) {
    const source = metadata[provider];
    if (!source?.models || !Array.isArray(live[provider]?.data)) {
      throw new Error(`Missing OpenCode source: ${provider}`);
    }
    const root = `https://opencode.ai/inference${provider === 'opencode-go' ? '/go' : ''}`;
    const entries: OpenCodeModel[] = [];
    const skipped: { id: string; reason: string }[] = [];
    for (const id of [...new Set(live[provider].data.map((row) => row.id))].sort()) {
      // Some live Go IDs only have a Zen metadata entry in models.dev.
      // Zen's same-model metadata is usable, with the endpoint kept on Go.
      const owner = source.models[id] ? source : metadata.opencode;
      const model = owner?.models[id];
      if (!model) {
        skipped.push({ id, reason: 'No OpenCode model metadata' });
        continue;
      }
      const npm = model.provider?.npm ?? owner.npm;
      const api = Object.hasOwn(APIS, npm) ? APIS[npm] : undefined;
      if (!api) {
        skipped.push({ id, reason: `Unsupported wire API: ${npm}` });
        continue;
      }
      const expected = `${root}/${api === 'anthropic-messages' ? 'anthropic' : 'openai'}/v1`;
      const metadataUrl = model.provider?.api ?? owner.api;
      const expectedMetadataUrl = source.models[id]
        ? expected
        : expected.replace('/inference/go/', '/inference/');
      if (metadataUrl !== expectedMetadataUrl) {
        throw new Error(`Unexpected OpenCode endpoint: ${provider}/${id}`);
      }
      const { context, output } = model.limit;
      if (![context, output].every((n) => Number.isSafeInteger(n) && n > 0)) {
        throw new Error(`Invalid OpenCode limits: ${provider}/${id}`);
      }
      const input = model.modalities.input.filter((kind) => kind === 'text' || kind === 'image');
      if (!input.includes('text')) throw new Error(`Missing text input: ${provider}/${id}`);
      const entry: OpenCodeModel = {
        id,
        name: model.name,
        api,
        provider,
        // Our Anthropic adapter appends /v1/messages itself.
        baseUrl: api === 'anthropic-messages' ? expected.slice(0, -3) : expected,
        reasoning: model.reasoning,
        input,
        contextWindow: context,
        maxTokens: output,
      };
      if (api === 'openai-completions' && typeof model.interleaved === 'object') {
        if (model.interleaved.field === 'reasoning_content') {
          entry.compat = { requiresReasoningContentOnAssistantMessages: true };
        }
      }
      entries.push(entry);
    }
    if (!entries.length) throw new Error(`Empty OpenCode catalog: ${provider}`);
    providers[provider] = entries;
    omitted[provider] = skipped;
  }
  return { providers, omitted };
}

/** Explicit refresh only; normal builds and --check never use the network. */
export async function refreshOpenCodeCatalog() {
  const documents: Record<string, string> = {};
  for (const [name, url] of Object.entries(OPENCODE_SOURCES)) {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok)
      throw new Error(`OpenCode catalog fetch failed: ${name} (${response.status})`);
    documents[name] = await response.text();
  }
  return pinnedOpenCodeCatalog(documents, new Date().toISOString().slice(0, 10));
}

export function pinnedOpenCodeCatalog(documents: Record<string, string>, updated: string) {
  const { metadata, ...live } = Object.fromEntries(
    Object.entries(documents).map(([name, text]) => [name, JSON.parse(text)]),
  );
  return {
    updated,
    sources: Object.entries(OPENCODE_SOURCES).map(([name, url]) => ({
      url,
      sha256: createHash('sha256').update(documents[name]).digest('hex'),
    })),
    ...openCodeCatalog(metadata, live),
  };
}
