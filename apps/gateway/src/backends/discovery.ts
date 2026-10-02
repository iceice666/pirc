/**
 * Setup helpers for API-key backends: presets from pi-ai's built-in catalog,
 * model discovery from an endpoint's model list, and a one-off connection
 * test. Upstream bodies, URLs and credentials are never echoed; errors are
 * curated messages the web client may show verbatim.
 */
import type { Api, Model } from '@mariozechner/pi-ai';
import { ApiError } from '../errors.js';
import type { ModelConfig, ProviderConfig } from '../models.js';
import { GatewayInference } from './inference.js';

/** The editable model fields the settings UI round-trips. */
export interface UiModel {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: Array<'text' | 'image'>;
}

export interface BackendPreset {
  id: string;
  name: string;
  api: 'openai-completions' | 'openai-responses' | 'anthropic-messages';
  baseUrl: string;
  /** A local server that normally needs no key. */
  keyless?: boolean;
  /** Models come from pi-ai's catalog (and saving keeps its request compatibility). */
  catalog: boolean;
  models: UiModel[];
}

type PresetApi = BackendPreset['api'];
const presetApis: readonly string[] = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
];

const NAMES: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  openrouter: 'OpenRouter',
  deepseek: 'DeepSeek',
  xai: 'xAI',
  groq: 'Groq',
  cerebras: 'Cerebras',
  fireworks: 'Fireworks',
  huggingface: 'Hugging Face',
  moonshotai: 'Moonshot AI',
  'moonshotai-cn': 'Moonshot AI (China)',
  'kimi-coding': 'Kimi Coding',
  zai: 'Z.ai Coding Plan',
  minimax: 'MiniMax',
  'minimax-cn': 'MiniMax (China)',
  'opencode-go': 'OpenCode Go',
  'vercel-ai-gateway': 'Vercel AI Gateway',
  xiaomi: 'Xiaomi MiMo',
};
/** Common services first; the rest follow alphabetically. */
const ORDER = ['openai', 'anthropic', 'openrouter', 'deepseek', 'xai', 'groq'];
/** Subscription-only catalogs are handled by OAuth login, not API keys. */
const EXCLUDED = new Set(['github-copilot', 'openai-codex']);
const LOCAL: BackendPreset[] = [
  {
    id: 'ollama',
    name: 'Ollama (local)',
    api: 'openai-completions',
    baseUrl: 'http://localhost:11434/v1',
    keyless: true,
    catalog: false,
    models: [],
  },
  {
    id: 'lmstudio',
    name: 'LM Studio (local)',
    api: 'openai-completions',
    baseUrl: 'http://localhost:1234/v1',
    keyless: true,
    catalog: false,
    models: [],
  },
];

export const uiModel = (model: Model<Api>): UiModel => ({
  id: model.id,
  ...(model.name && model.name !== model.id ? { name: model.name } : {}),
  contextWindow: model.contextWindow,
  maxTokens: model.maxTokens,
  reasoning: model.reasoning,
  input: model.input.filter((kind) => kind === 'text' || kind === 'image'),
});

/**
 * Catalog providers usable with a plain API key: one supported API and one
 * concrete endpoint (templated URLs such as Cloudflare's need manual setup).
 */
export function catalogPresets(
  providers: readonly string[],
  catalog: (id: string) => Model<Api>[],
): BackendPreset[] {
  const presets: BackendPreset[] = [];
  for (const id of providers) {
    if (EXCLUDED.has(id)) continue;
    const models = catalog(id);
    const first = models[0];
    if (
      !first ||
      !presetApis.includes(first.api) ||
      !/^https:\/\/[^{}]+$/.test(first.baseUrl) ||
      models.some((model) => model.api !== first.api || model.baseUrl !== first.baseUrl)
    )
      continue;
    presets.push({
      id,
      name: NAMES[id] ?? id,
      api: first.api as PresetApi,
      baseUrl: first.baseUrl,
      catalog: true,
      models: models.map(uiModel),
    });
  }
  const rank = (id: string) => (ORDER.includes(id) ? ORDER.indexOf(id) : ORDER.length);
  presets.sort((a, b) => rank(a.id) - rank(b.id) || a.name.localeCompare(b.name));
  return [...presets, ...LOCAL];
}

/** Gateway-only request metadata a catalog model needs (kept when saving from a preset). */
export function catalogMetadata(model: Model<Api>): Partial<ModelConfig> {
  return {
    compat: structuredClone((model.compat ?? {}) as Record<string, unknown>),
    ...(model.headers ? { headers: { ...model.headers } } : {}),
    ...(model.thinkingLevelMap ? { thinkingLevelMap: { ...model.thinkingLevelMap } } : {}),
  };
}

export interface DiscoveredModel extends UiModel {
  /** Metadata came from pi-ai's catalog rather than defaults. */
  known: boolean;
}

const MAX_BODY = 8 * 1024 * 1024;
const MAX_MODELS = 1000;
const fail = (message: string, status = 502) =>
  new ApiError(status, status === 504 ? 'node_timeout' : 'node_error', message);

function httpError(status: number): ApiError {
  if (status === 401 || status === 403)
    return fail(`The endpoint rejected the API key (HTTP ${status}). Check the key and try again.`);
  if (status === 404)
    return fail('This endpoint does not list its models (HTTP 404). Add model IDs manually.');
  if (status === 429)
    return fail('The endpoint is rate limiting requests (HTTP 429). Try again later.');
  return fail(`The endpoint returned HTTP ${status} when listing models.`);
}

async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) {
      await reader.cancel().catch(() => {});
      throw fail('The model list is too large to read.');
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

const positive = (...values: unknown[]) => {
  for (const value of values)
    if (typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 100_000_000)
      return value;
  return undefined;
};
const label = (value: unknown) =>
  typeof value === 'string' && /^[^\u0000-\u001f\u007f]{1,200}$/.test(value) ? value : undefined;

/** OpenAI-style `{data}`, Ollama-style `{models}` or a bare array, with optional size hints. */
export function parseModelList(raw: unknown): UiModel[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object'
      ? ((raw as { data?: unknown }).data ?? (raw as { models?: unknown }).models)
      : undefined;
  if (!Array.isArray(list)) throw fail('The endpoint returned an unrecognized model list.');
  const seen = new Map<string, UiModel>();
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as Record<string, any>;
    const id = label(item.id) ?? label(item.name) ?? label(item.model);
    if (!id || seen.has(id)) continue;
    const name =
      label(item.display_name) ?? (label(item.name) !== id ? label(item.name) : undefined);
    const top = item.top_provider && typeof item.top_provider === 'object' ? item.top_provider : {};
    const contextWindow = positive(
      item.context_length,
      item.context_window,
      item.max_context_length,
      item.max_model_len,
      top.context_length,
    );
    const maxTokens = positive(
      top.max_completion_tokens,
      item.max_output_tokens,
      item.max_completion_tokens,
    );
    const modalities = item.architecture?.input_modalities;
    const parameters = item.supported_parameters;
    seen.set(id, {
      id,
      ...(name ? { name } : {}),
      ...(contextWindow ? { contextWindow } : {}),
      ...(maxTokens ? { maxTokens } : {}),
      ...(Array.isArray(parameters) && parameters.includes('reasoning') ? { reasoning: true } : {}),
      ...(Array.isArray(modalities) && modalities.includes('image')
        ? { input: ['text', 'image'] as Array<'text' | 'image'> }
        : {}),
    });
    if (seen.size >= MAX_MODELS) break;
  }
  return [...seen.values()];
}

export interface ProbeTarget {
  api: string;
  baseUrl: string;
  apiKey?: string | undefined;
}

/** List models from the endpoint itself. Redirects are refused so a key is never forwarded. */
export async function discoverModels(
  target: ProbeTarget,
  known: (id: string) => Model<Api> | undefined,
  fetcher: typeof fetch = fetch,
): Promise<DiscoveredModel[]> {
  const base = target.baseUrl.replace(/\/+$/, '');
  const anthropic = target.api === 'anthropic-messages';
  const url = anthropic ? `${base}/v1/models?limit=1000` : `${base}/models`;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (anthropic) {
    headers['anthropic-version'] = '2023-06-01';
    if (target.apiKey) headers['x-api-key'] = target.apiKey;
  } else if (target.apiKey) headers.authorization = `Bearer ${target.apiKey}`;
  let response: Response;
  try {
    response = await fetcher(url, {
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    if ((error as Error)?.name === 'TimeoutError')
      throw fail('The endpoint did not answer within 15 seconds.', 504);
    throw fail('Cannot reach the endpoint from the gateway. Check the base URL.');
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => {});
    throw fail('The endpoint redirected the request. Use the final base URL.');
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw httpError(response.status);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await readCapped(response));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw fail('The endpoint returned an unrecognized model list.');
  }
  return parseModelList(raw)
    .map((model) => {
      const entry = known(model.id);
      return entry
        ? { ...uiModel(entry), ...(model.name ? { name: model.name } : {}), known: true }
        : { ...model, known: false };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

export interface ConnectionResult {
  ok: boolean;
  message: string;
  latencyMs: number;
}

/** Send one tiny request through the same transport real runs use. */
export async function testConnection(
  resolved: { provider: ProviderConfig; model: ModelConfig; apiKey?: string | undefined },
  inference: (
    resolver: ConstructorParameters<typeof GatewayInference>[0],
  ) => Pick<GatewayInference, 'run'> = (resolver) => new GatewayInference(resolver),
): Promise<ConnectionResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const message = await inference({ resolve: async () => structuredClone(resolved) }).run(
      {
        providerName: 'connection-test',
        modelId: resolved.model.id,
        systemPrompt: 'This is a connection test. Reply with OK.',
        messages: [{ role: 'user', content: 'ping', timestamp: Date.now() }],
        tools: [],
        thinking: 'off',
        sessionId: crypto.randomUUID(),
        maxTokens: 32,
      },
      controller.signal,
      () => {},
      'settings',
    );
    const latencyMs = Date.now() - started;
    if (message.stopReason === 'error' || message.stopReason === 'aborted')
      return {
        ok: false,
        latencyMs,
        message: controller.signal.aborted
          ? 'The model did not answer within 30 seconds.'
          : (message.errorMessage ?? 'Model request failed'),
      };
    return { ok: true, latencyMs, message: `${resolved.model.id} answered in ${latencyMs} ms.` };
  } finally {
    clearTimeout(timer);
  }
}
