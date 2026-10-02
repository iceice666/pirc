import type { Api, Model } from '@mariozechner/pi-ai';
import { getModels, getProviders } from './pi-catalog.js';
import {
  getOAuthProviders,
  type OAuthCredentials,
  type OAuthProviderInterface,
} from '@mariozechner/pi-ai/oauth';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ApiError } from '../errors.js';
import {
  modelRefSchema,
  modelsSchema,
  publicModels,
  type ModelConfig,
  type ModelsConfig,
  type ProviderConfig,
} from '../models.js';
import {
  catalogMetadata,
  catalogPresets,
  discoverModels,
  testConnection,
  type BackendPreset,
  type ConnectionResult,
  type DiscoveredModel,
} from './discovery.js';
import {
  workerLogin,
  workerRefresh,
  type LoginRunner,
  type RefreshRunner,
} from './oauth-worker.js';

const customId = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/)
  .refine((value) => !['__proto__', 'constructor', 'prototype', 'default-model'].includes(value));
const endpoint = z
  .string()
  .max(4096)
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.hash &&
      !url.search
    );
  });
const uiModel = z
  .object({
    id: z.string().min(1).max(200),
    name: z.string().min(1).max(200).optional(),
    contextWindow: z.number().int().positive().max(100_000_000).default(200_000),
    maxTokens: z.number().int().positive().max(10_000_000).default(32_000),
    reasoning: z.boolean().default(false),
    input: z
      .array(z.enum(['text', 'image']))
      .min(1)
      .max(2)
      .default(['text']),
  })
  .strict();
export const customProviderSchema = z
  .object({
    api: z.enum(['openai-chat', 'anthropic-messages', 'openai-completions', 'openai-responses']),
    baseUrl: endpoint,
    opencodeGo: z.boolean().optional(),
    apiKey: z.string().max(32_768).optional(),
    /** A pi-ai catalog provider this backend was set up from (keeps its request compatibility). */
    preset: z.string().max(100).optional(),
    models: z.array(uiModel).min(1).max(200),
  })
  .strict()
  .refine((value) => new Set(value.models.map((model) => model.id)).size === value.models.length);
/** An unsaved form: the key may be omitted to reuse a saved web-managed backend's key. */
const probeSchema = z
  .object({
    api: customProviderSchema.innerType().shape.api,
    baseUrl: endpoint,
    opencodeGo: z.boolean().optional(),
    apiKey: z.string().max(32_768).optional(),
    preset: z.string().max(100).optional(),
    backendId: z.string().max(100).optional(),
  })
  .strict();
const testSchema = probeSchema.extend({ model: uiModel }).strict();
const credentialsSchema = z
  .object({ access: z.string().min(1), refresh: z.string().min(1), expires: z.number().finite() })
  .passthrough();
const diskSchema = z
  .object({
    version: z.literal(1),
    providers: modelsSchema.shape.providers,
    oauth: z.record(credentialsSchema),
    defaultModel: modelRefSchema.optional(),
  })
  .strict();
type DiskState = z.infer<typeof diskSchema>;
export interface AuthPrompt {
  id: string;
  kind: 'prompt' | 'manual' | 'select';
  message: string;
  placeholder?: string;
  allowEmpty?: boolean;
  options?: { id: string; label: string }[];
}
export interface AuthSession {
  id: string;
  providerId: string;
  status: 'pending' | 'succeeded' | 'failed' | 'cancelled' | 'expired';
  /** `userCode`: a device-flow code the user types on the authorization page. */
  auth?: { url: string; instructions?: string; userCode?: string };
  prompts: AuthPrompt[];
  progress?: string;
  error?: string;
  expiresAt: number;
}
interface PendingSession {
  view: AuthSession;
  owner: string;
  generation: number;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  answers: Map<
    string,
    { resolve: (value: string | undefined) => void; reject: (error: Error) => void }
  >;
  task?: Promise<void>;
}
export interface BackendServiceOptions {
  stateDir: string;
  baseline: ModelsConfig;
  onChange?: () => void;
  registry?: OAuthProviderInterface[];
  catalog?: (providerId: string) => Model<Api>[];
  /** Catalog provider IDs offered as API-key presets (default: pi-ai's full catalog). */
  catalogProviders?: () => string[];
  /** Injectable network access for model discovery tests. */
  fetcher?: typeof fetch;
  /** Injectable connection test so route tests need no model server. */
  connectionTester?: typeof testConnection;
  loginRunner?: LoginRunner;
  refreshRunner?: RefreshRunner;
  sessionTimeoutMs?: number;
}
const invalid = (message = 'Invalid backend settings') =>
  new ApiError(400, 'invalid_input', message);
const conflict = (message: string) => new ApiError(409, 'conflict', message);
const notFound = () => new ApiError(404, 'not_found', 'Backend or authorization session not found');
const text = (value: string) =>
  value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(
      /(?:Bearer\s+|(?:access_token|refresh_token|api_key|token)\s*[:=]\s*)\S+/gi,
      '[redacted]',
    )
    .slice(0, 2000);
const own = (object: object, key: string) => Object.hasOwn(object, key);

/** Single-user global configuration. File-managed providers always win, never mutated. */
export class BackendService {
  private baseline: ModelsConfig;
  private state: DiskState;
  private readonly file: string;
  private readonly registry: Map<string, OAuthProviderInterface>;
  private readonly sessions = new Map<string, PendingSession>();
  private readonly generations = new Map<string, number>();
  private readonly refreshing = new Map<string, Promise<OAuthCredentials>>();
  private readonly refreshControllers = new Map<string, AbortController>();
  private readonly loginRunner: LoginRunner;
  private readonly refreshRunner: RefreshRunner;
  private presetCache: BackendPreset[] | undefined;
  private probes = 0;
  private closed = false;

  constructor(private readonly options: BackendServiceOptions) {
    this.baseline = structuredClone(options.baseline);
    this.registry = new Map(
      (options.registry ?? getOAuthProviders()).map((provider) => [provider.id, provider]),
    );
    this.loginRunner = options.loginRunner ?? workerLogin;
    this.refreshRunner = options.refreshRunner ?? workerRefresh;
    const directory = path.join(options.stateDir, 'backends');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    this.file = path.join(directory, 'settings.json');
    this.state = { version: 1, providers: {}, oauth: {} };
    if (existsSync(this.file)) {
      try {
        this.state = diskSchema.parse(JSON.parse(readFileSync(this.file, 'utf8')));
        chmodSync(this.file, 0o600);
      } catch {
        throw new Error('Cannot read backend credential store');
      }
    }
    for (const id of Object.keys(this.state.providers))
      if (!customId.safeParse(id).success) throw new Error('Invalid backend credential store');
  }

  private catalog(id: string, credentials?: OAuthCredentials): Model<Api>[] {
    const models = structuredClone(
      this.options.catalog
        ? this.options.catalog(id)
        : getModels(id as Parameters<typeof getModels>[0]),
    ) as Model<Api>[];
    return credentials
      ? (this.registry.get(id)?.modifyModels?.(models, credentials) ?? models)
      : models;
  }
  private oauthProvider(id: string, credentials: OAuthCredentials): ProviderConfig | undefined {
    const entries = this.catalog(id, credentials);
    if (!entries.length) return undefined;
    return {
      api: entries[0]!.api as ProviderConfig['api'],
      piProvider: id,
      baseUrl: entries[0]!.baseUrl,
      headers: {},
      compat: {},
      models: entries.map((model) => ({
        id: model.id,
        name: model.name,
        api: model.api as ModelConfig['api'],
        canonicalProvider: model.provider,
        baseUrl: model.baseUrl,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        reasoning: model.reasoning,
        input: [...model.input],
        compat: structuredClone((model.compat ?? {}) as Record<string, unknown>),
        ...(model.headers ? { headers: { ...model.headers } } : {}),
        ...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
      })),
    };
  }
  private merged(): ModelsConfig {
    const providers: Record<string, ProviderConfig> = { ...this.state.providers };
    for (const [id, credentials] of Object.entries(this.state.oauth)) {
      if (!this.registry.has(id)) continue;
      const provider = this.oauthProvider(id, credentials);
      if (provider) providers[`oauth:${id}`] = provider;
    }
    Object.assign(providers, this.baseline.providers);
    const preferred = this.state.defaultModel ?? this.baseline.defaultModel;
    const defaultModel =
      preferred && providers[preferred.provider]?.models.some((model) => model.id === preferred.id)
        ? preferred
        : undefined;
    return { providers, ...(defaultModel ? { defaultModel } : {}) };
  }
  get models(): ModelsConfig {
    return publicModels(this.merged());
  }
  setBaseline(config: ModelsConfig): void {
    this.baseline = structuredClone(config);
    this.changed();
  }
  private changed(): void {
    this.options.onChange?.();
  }
  private commit(next: DiskState, notify = true): void {
    const temporary = `${this.file}.${crypto.randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporary, 'wx', 0o600);
      writeFileSync(descriptor, JSON.stringify(next));
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporary, this.file);
    } catch {
      throw new ApiError(500, 'node_error', 'Unable to save backend settings');
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      try {
        unlinkSync(temporary);
      } catch {
        /* renamed or never created */
      }
    }
    this.state = next;
    if (notify) this.changed();
  }
  snapshot() {
    const config = this.merged();
    const safe = publicModels(config);
    return {
      providers: Object.entries(config.providers).map(([id, provider]) => ({
        id,
        name: id.startsWith('oauth:') ? (this.registry.get(id.slice(6))?.name ?? id) : id,
        source: own(this.baseline.providers, id)
          ? ('file' as const)
          : id.startsWith('oauth:')
            ? ('oauth' as const)
            : ('ui' as const),
        readOnly: own(this.baseline.providers, id),
        api: provider.api,
        opencodeGo: provider.opencodeGo ?? false,
        ...(own(this.state.providers, id) && !own(this.baseline.providers, id)
          ? {
              baseUrl: provider.baseUrl,
              ...(provider.piProvider ? { preset: provider.piProvider } : {}),
            }
          : {}),
        hasApiKey: !!provider.apiKey || id.startsWith('oauth:'),
        models: safe.providers[id]!.models,
      })),
      oauthProviders: [...this.registry.values()].map((provider) => ({
        id: provider.id,
        name: provider.name,
        providerId: `oauth:${provider.id}`,
        connected: own(this.state.oauth, provider.id),
        requiresPolicyConsent: provider.id === 'github-copilot',
        usesCallbackServer: !!provider.usesCallbackServer,
        modelCount: this.catalog(provider.id).length,
      })),
      ...(config.defaultModel ? { defaultModel: config.defaultModel } : {}),
    };
  }
  saveProvider(id: string, input: unknown, create = false): void {
    if (this.closed) throw conflict('Backend service is closed');
    if (!customId.safeParse(id).success) throw invalid('Invalid backend ID');
    if (own(this.baseline.providers, id)) throw conflict('File-managed backends are read-only');
    if (create && own(this.state.providers, id)) throw conflict('Backend ID already exists');
    if (!create && !own(this.state.providers, id)) throw notFound();
    const parsed = customProviderSchema.safeParse(input);
    if (!parsed.success) throw invalid();
    const value = parsed.data;
    const apiKey =
      value.apiKey === undefined ? this.state.providers[id]?.apiKey : value.apiKey || undefined;
    const provider = this.providerConfig(value, apiKey);
    this.commit({ ...this.state, providers: { ...this.state.providers, [id]: provider } });
  }
  /**
   * A web-managed provider. With a catalog preset, models known to pi-ai keep
   * the catalog's gateway-only request metadata (compat, headers, thinking map)
   * and requests run through pi-ai under the catalog provider's name.
   */
  private providerConfig(
    value: Omit<z.infer<typeof customProviderSchema>, 'models'> & {
      models: Array<Omit<ModelConfig, 'compat'>>;
    },
    apiKey: string | undefined,
  ): ProviderConfig {
    const { preset, apiKey: _input, ...rest } = value;
    let known = new Map<string, Model<Api>>();
    if (preset !== undefined) {
      const entry = this.presets().find((item) => item.id === preset && item.catalog);
      if (!entry || entry.api !== value.api) throw invalid('Unknown backend preset');
      known = new Map(this.catalog(preset).map((model) => [model.id, model]));
    }
    const provider: ProviderConfig = {
      ...rest,
      ...(preset === undefined ? {} : { piProvider: preset }),
      models: value.models.map((model) => {
        const entry = known.get(model.id);
        return { ...model, compat: {}, ...(entry ? catalogMetadata(entry) : {}) };
      }),
      headers: {},
      compat: {},
      ...(apiKey ? { apiKey } : {}),
    };
    return provider;
  }
  /** API-key presets: pi-ai catalog providers plus common local servers. */
  presets(): BackendPreset[] {
    this.presetCache ??= catalogPresets(this.options.catalogProviders?.() ?? getProviders(), (id) =>
      this.catalog(id),
    );
    return this.presetCache;
  }
  /** The key a probe uses: the typed one, else the saved key of the backend being edited. */
  private probeKey(input: { apiKey?: string | undefined; backendId?: string | undefined }) {
    if (input.apiKey !== undefined) return input.apiKey || undefined;
    const id = input.backendId;
    return id && own(this.state.providers, id) && !own(this.baseline.providers, id)
      ? this.state.providers[id]!.apiKey
      : undefined;
  }
  /** Probes reach user-chosen endpoints; a few at a time is plenty for one settings form. */
  private async probe<T>(task: () => Promise<T>): Promise<T> {
    if (this.closed) throw conflict('Backend service is closed');
    if (this.probes >= 4)
      throw new ApiError(429, 'too_many_requests', 'Too many backend checks; try again shortly');
    this.probes++;
    try {
      return await task();
    } finally {
      this.probes--;
    }
  }
  /** List an unsaved (or edited) endpoint's models, enriched with catalog metadata. */
  discover(input: unknown): Promise<DiscoveredModel[]> {
    const parsed = probeSchema.safeParse(input);
    if (!parsed.success) throw invalid();
    const value = parsed.data;
    const preset = value.preset ? this.catalog(value.preset) : [];
    const lookup = (id: string) => preset.find((model) => model.id === id);
    return this.probe(() =>
      discoverModels(
        { api: value.api, baseUrl: value.baseUrl, apiKey: this.probeKey(value) },
        lookup,
        this.options.fetcher,
      ),
    );
  }
  /** Run one tiny request against an unsaved (or edited) backend's model. */
  testProvider(input: unknown): Promise<ConnectionResult> {
    const parsed = testSchema.safeParse(input);
    if (!parsed.success) throw invalid();
    const { backendId: _id, model, ...value } = parsed.data;
    const provider = this.providerConfig({ ...value, models: [model] }, this.probeKey(parsed.data));
    return this.probe(() =>
      (this.options.connectionTester ?? testConnection)({
        provider,
        model: provider.models[0]!,
        apiKey: provider.apiKey,
      }),
    );
  }
  deleteProvider(id: string): void {
    if (own(this.baseline.providers, id)) throw conflict('File-managed backends are read-only');
    const next = structuredClone(this.state);
    if (id.startsWith('oauth:')) {
      const providerId = id.slice(6);
      if (!this.registry.has(providerId)) throw notFound();
      this.generations.set(providerId, this.generation(providerId) + 1);
      this.refreshControllers.get(providerId)?.abort();
      for (const session of this.sessions.values())
        if (session.view.providerId === providerId && session.view.status === 'pending')
          this.finish(session, 'cancelled');
      delete next.oauth[providerId];
    } else {
      if (!own(next.providers, id)) throw notFound();
      delete next.providers[id];
    }
    if (next.defaultModel?.provider === id) delete next.defaultModel;
    this.commit(next);
  }
  setDefault(input: unknown): void {
    if (input === null) {
      const next = { ...this.state };
      delete next.defaultModel;
      this.commit(next);
      return;
    }
    const parsed = modelRefSchema.strict().safeParse(input);
    if (!parsed.success) throw invalid();
    const ref = parsed.data;
    if (!this.merged().providers[ref.provider]?.models.some((model) => model.id === ref.id))
      throw invalid('Model is not configured');
    this.commit({ ...this.state, defaultModel: ref });
  }
  private generation(id: string): number {
    return this.generations.get(id) ?? 0;
  }

  async resolve(
    providerName: string,
    modelId: string,
  ): Promise<{ provider: ProviderConfig; model: ModelConfig; apiKey?: string | undefined }> {
    if (this.closed) throw conflict('Backend service is closed');
    let provider: ProviderConfig | undefined;
    let apiKey: string | undefined;
    if (own(this.baseline.providers, providerName))
      provider = this.baseline.providers[providerName];
    else if (providerName.startsWith('oauth:')) {
      const id = providerName.slice(6);
      const registry = this.registry.get(id);
      let credentials = this.state.oauth[id];
      if (!credentials || !registry) throw notFound();
      // Refresh slightly early so a long stream does not start with an almost-expired token.
      if (credentials.expires <= Date.now() + 60_000)
        credentials = await this.refresh(id, credentials);
      if (!this.state.oauth[id] || this.closed) throw notFound();
      provider = this.oauthProvider(id, credentials);
      apiKey = registry.getApiKey(credentials);
    } else if (own(this.state.providers, providerName))
      provider = this.state.providers[providerName];
    const model = provider?.models.find((entry) => entry.id === modelId);
    if (!provider || !model) throw notFound();
    return {
      provider: structuredClone(provider),
      model: structuredClone(model),
      apiKey: apiKey ?? provider.apiKey,
    };
  }
  private refresh(id: string, credentials: OAuthCredentials): Promise<OAuthCredentials> {
    const active = this.refreshing.get(id);
    if (active) return active;
    const generation = this.generation(id);
    const controller = new AbortController();
    this.refreshControllers.set(id, controller);
    const timeout = setTimeout(() => controller.abort(), 60_000);
    const promise = (async () => {
      try {
        const fresh = credentialsSchema.parse(
          await this.refreshRunner(id, structuredClone(credentials), controller.signal),
        );
        if (
          controller.signal.aborted ||
          this.closed ||
          generation !== this.generation(id) ||
          !this.state.oauth[id]
        )
          throw notFound();
        this.commit({ ...this.state, oauth: { ...this.state.oauth, [id]: fresh } }, false);
        return fresh;
      } catch {
        throw new ApiError(
          502,
          'node_error',
          'Backend authorization refresh failed; sign in again',
        );
      } finally {
        clearTimeout(timeout);
        if (this.refreshControllers.get(id) === controller) this.refreshControllers.delete(id);
      }
    })();
    this.refreshing.set(id, promise);
    void promise
      .finally(() => {
        if (this.refreshing.get(id) === promise) this.refreshing.delete(id);
      })
      .catch(() => {});
    return promise;
  }

  startAuth(owner: string, providerId: string, policyConsent = false): AuthSession {
    if (this.closed) throw conflict('Backend service is closed');
    const provider = this.registry.get(providerId);
    if (!provider) throw invalid('Unknown OAuth provider');
    if (own(this.baseline.providers, `oauth:${providerId}`))
      throw conflict('File-managed backend ID is reserved');
    if (providerId === 'github-copilot' && policyConsent !== true)
      throw invalid('Explicit consent to enable known GitHub Copilot models is required');
    if (
      [...this.sessions.values()].some(
        (session) => session.view.providerId === providerId && session.view.status === 'pending',
      )
    )
      throw conflict('A login for this provider is already in progress');
    for (const [id, session] of this.sessions)
      if (session.view.status !== 'pending' && session.view.expiresAt < Date.now())
        this.sessions.delete(id);
    if (this.sessions.size >= 32)
      throw conflict('Too many authorization sessions; try again later');
    const id = crypto.randomUUID();
    const expiresAt = Date.now() + (this.options.sessionTimeoutMs ?? 10 * 60_000);
    const session: PendingSession = {
      owner,
      generation: this.generation(providerId),
      controller: new AbortController(),
      answers: new Map(),
      view: { id, providerId, status: 'pending', prompts: [], expiresAt },
      timer: setTimeout(() => this.finish(session, 'expired'), Math.max(1, expiresAt - Date.now())),
    };
    this.sessions.set(id, session);
    const prompt = (value: Omit<AuthPrompt, 'id'>): Promise<string | undefined> => {
      if (session.view.status !== 'pending') return Promise.reject(new Error('OAuth cancelled'));
      if (session.answers.size >= 8) return Promise.reject(new Error('Too many OAuth prompts'));
      const promptId = crypto.randomUUID();
      session.view.prompts.push({ ...value, id: promptId });
      return new Promise((resolve, reject) => session.answers.set(promptId, { resolve, reject }));
    };
    session.task = (async () => {
      try {
        const credentials = credentialsSchema.parse(
          await this.loginRunner(providerId, {
            signal: session.controller.signal,
            onAuth: (value) => {
              if (session.view.status !== 'pending') return;
              const url = new URL(value.url);
              if (
                url.protocol !== 'https:' ||
                url.username ||
                url.password ||
                url.searchParams.has('access_token') ||
                url.searchParams.has('refresh_token')
              )
                throw new Error('Unsafe authorization URL');
              const userCode = value.instructions?.match(
                /\bcode:\s*([A-Z0-9]{4,8}-[A-Z0-9]{4,8})\b/i,
              )?.[1];
              session.view.auth = {
                url: url.toString(),
                ...(value.instructions ? { instructions: text(value.instructions) } : {}),
                ...(userCode ? { userCode } : {}),
              };
            },
            onProgress: (value) => {
              if (session.view.status === 'pending') session.view.progress = text(value);
            },
            onPrompt: async (value) =>
              (await prompt({
                kind: 'prompt',
                message: text(value.message),
                ...(value.placeholder ? { placeholder: text(value.placeholder) } : {}),
                ...(value.allowEmpty === undefined ? {} : { allowEmpty: value.allowEmpty }),
              })) ?? '',
            onManualCodeInput: async () =>
              (await prompt({
                kind: 'manual',
                message: 'Paste the complete localhost callback URL after authorization',
                allowEmpty: false,
              })) ?? '',
            onSelect: (value) =>
              prompt({
                kind: 'select',
                message: text(value.message),
                options: value.options
                  .slice(0, 50)
                  .map((option) => ({ id: option.id, label: text(option.label) })),
              }),
          }),
        );
        if (
          session.view.status !== 'pending' ||
          session.generation !== this.generation(providerId) ||
          this.closed
        )
          return;
        if (own(this.baseline.providers, `oauth:${providerId}`))
          throw new Error('Baseline changed');
        this.commit({ ...this.state, oauth: { ...this.state.oauth, [providerId]: credentials } });
        this.finish(session, 'succeeded');
      } catch {
        if (session.view.status === 'pending')
          this.finish(session, 'failed', 'Authorization failed. Please retry.');
      }
    })();
    return structuredClone(session.view);
  }
  private session(owner: string, id: string): PendingSession {
    const session = this.sessions.get(id);
    if (!session || session.owner !== owner) throw notFound();
    if (session.view.status === 'pending' && session.view.expiresAt <= Date.now())
      this.finish(session, 'expired');
    return session;
  }
  authStatus(owner: string, id: string): AuthSession {
    return structuredClone(this.session(owner, id).view);
  }
  cancelAuth(owner: string, id: string): AuthSession {
    const session = this.session(owner, id);
    if (session.view.status === 'pending') this.finish(session, 'cancelled');
    return structuredClone(session.view);
  }
  authInput(owner: string, id: string, promptId: string, value?: string): AuthSession {
    const session = this.session(owner, id);
    if (session.view.status !== 'pending')
      throw conflict('Authorization session is no longer pending');
    const prompt = session.view.prompts.find((entry) => entry.id === promptId);
    const answer = session.answers.get(promptId);
    if (!prompt || !answer) throw conflict('Prompt is no longer pending');
    if (value !== undefined && (typeof value !== 'string' || value.length > 16_384))
      throw invalid('Invalid authorization input');
    if (prompt.kind === 'select') {
      if (value !== undefined && !prompt.options?.some((option) => option.id === value))
        throw invalid('Unknown selection');
    } else if (value === undefined || (!value.trim() && !prompt.allowEmpty))
      throw invalid('A response is required');
    if (
      prompt.kind === 'manual' ||
      (prompt.kind === 'prompt' && ['anthropic', 'openai-codex'].includes(session.view.providerId))
    )
      this.validateCallback(session, value!);
    if (prompt.kind === 'prompt' && session.view.providerId === 'github-copilot' && value?.trim()) {
      try {
        const url = new URL(value.includes('://') ? value : `https://${value}`);
        if (
          url.protocol !== 'https:' ||
          url.username ||
          url.password ||
          url.port ||
          url.search ||
          url.hash ||
          url.pathname !== '/'
        )
          throw new Error();
      } catch {
        throw invalid('Enter an HTTPS GitHub Enterprise domain without path or credentials');
      }
    }
    session.answers.delete(promptId);
    session.view.prompts = session.view.prompts.filter((entry) => entry.id !== promptId);
    answer.resolve(value);
    return structuredClone(session.view);
  }
  private validateCallback(session: PendingSession, value: string): void {
    try {
      const url = new URL(value);
      const auth = new URL(session.view.auth!.url);
      const redirect = new URL(auth.searchParams.get('redirect_uri')!);
      const state = auth.searchParams.get('state');
      if (
        url.protocol !== 'http:' ||
        url.hostname !== 'localhost' ||
        url.origin !== redirect.origin ||
        url.pathname !== redirect.pathname ||
        url.username ||
        url.password ||
        url.hash ||
        !state ||
        url.searchParams.get('state') !== state ||
        !url.searchParams.get('code') ||
        url.searchParams.getAll('state').length !== 1 ||
        url.searchParams.getAll('code').length !== 1
      )
        throw new Error();
    } catch {
      throw invalid(
        'Paste the complete expected localhost callback URL with matching authorization state',
      );
    }
  }
  private finish(session: PendingSession, status: AuthSession['status'], error?: string): void {
    session.view.status = status;
    if (error) session.view.error = error;
    clearTimeout(session.timer);
    session.controller.abort();
    for (const answer of session.answers.values()) answer.reject(new Error('Authorization ended'));
    session.answers.clear();
    session.view.prompts = [];
    delete session.view.auth;
    delete session.view.progress;
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const session of this.sessions.values())
      if (session.view.status === 'pending') this.finish(session, 'cancelled');
    for (const controller of this.refreshControllers.values()) controller.abort();
    await Promise.allSettled([...this.sessions.values()].map((session) => session.task));
    await Promise.allSettled(this.refreshing.values());
  }
}
