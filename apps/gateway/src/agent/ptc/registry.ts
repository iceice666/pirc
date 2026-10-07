/**
 * The capability registry behind `ptc` and `ptc_docs` (plans/ptc-only.md §1–2).
 *
 * Capabilities are the agent's existing tools under their existing names.
 * Availability is the agent's own calculation (registration, role/config
 * allowlists, project capability flags); discovery and execution use the
 * same list, and every operation is still authorized when it runs. The
 * metadata below describes capabilities for documentation and scheduling;
 * it never grants anything.
 *
 * Results: every capability returns `text` (its formatted output), `images`
 * when it produced any, and the typed fields its tool declares in
 * `resultSchema`; `ptc` checks each result against that contract.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Tool } from '../tools/types.js';
import { summaryOf } from './summary.js';
import {
  BUDGETS,
  CAPABILITY_NAME,
  CONTRACT_VERSION,
  PtcError,
  WRAPPER_NAMES,
  type Approval,
  type Effect,
  type ErrorCode,
  type Json,
  type Suspension,
} from './contracts.js';

interface Meta {
  category: string;
  effects: Effect[];
  /** `read` runs concurrently; `exclusive-write` takes the execution's single write slot. */
  concurrency: 'read' | 'exclusive-write';
  /** Actions of an action-dependent capability that only read. */
  readActions?: string[];
  approval: Approval;
  suspension: Suspension[];
  /** Returns web content (pages, search results): what the script returns is fenced as untrusted. */
  untrusted?: true;
}

const meta = (
  category: string,
  effects: Effect[],
  concurrency: Meta['concurrency'],
  approval: Approval = 'none',
  suspension: Suspension[] = [],
  readActions?: string[],
): Meta => ({
  category,
  effects,
  concurrency,
  approval,
  suspension,
  ...(readActions ? { readActions } : {}),
});

const READ = (category: string, effects: Effect[] = ['read']) => meta(category, effects, 'read');

/** Known capabilities; anything else is documented conservatively as an exclusive write. */
const META: Record<string, Meta> = {
  read: READ('files'),
  ls: READ('files'),
  find: READ('files'),
  grep: READ('files'),
  write: meta('files', ['write'], 'exclusive-write', 'operation-policy'),
  edit: meta('files', ['write'], 'exclusive-write', 'operation-policy'),
  // Commands may write anything: conservatively one at a time.
  bash: meta('shell', ['process', 'write'], 'exclusive-write', 'operation-policy', ['approval']),
  background_task: meta(
    'shell',
    ['process', 'write'],
    'exclusive-write',
    'action-dependent',
    ['approval', 'job'],
    ['list', 'output', 'wait'],
  ),
  unsandboxed_bash: meta(
    'sandbox',
    ['process', 'write', 'external'],
    'exclusive-write',
    'always-confirm',
    ['approval'],
  ),
  sandbox_allow_domains: meta('sandbox', ['external'], 'exclusive-write', 'always-confirm', [
    'approval',
  ]),
  web_fetch: READ('web', ['external']),
  web_search: READ('web', ['external']),
  browser_snapshot: READ('browser', ['external']),
  browser_screenshot: READ('browser', ['external']),
  browser_tabs: meta('browser', ['external'], 'exclusive-write', 'none', [], ['list']),
  browser_handoff: meta('browser', ['interaction', 'external'], 'exclusive-write', 'none', [
    'user',
  ]),
  ask_user_question: meta('interaction', ['interaction'], 'exclusive-write', 'none', ['user']),
  todo: meta('planning', ['write'], 'exclusive-write', 'none', [], ['list']),
  get_goal: READ('planning'),
  create_goal: meta('planning', ['write'], 'exclusive-write'),
  update_goal: meta('planning', ['write'], 'exclusive-write'),
  recall: READ('memory'),
  memory_search: READ('memory', ['read', 'external']),
  memory_note: meta('memory', ['write'], 'exclusive-write'),
  memory_propose_user: meta(
    'memory',
    ['write', 'interaction'],
    'exclusive-write',
    'always-confirm',
    ['approval'],
  ),
  delegate: meta('delegation', ['external', 'write'], 'exclusive-write', 'always-confirm', [
    'approval',
    'child',
  ]),
  delegation_status: READ('delegation', ['external']),
  schedule: meta(
    'schedule',
    ['external', 'write'],
    'exclusive-write',
    'action-dependent',
    ['approval'],
    ['list', 'result'],
  ),
  agent_list: READ('team'),
  agent_inbox: READ('team'),
  board_read: READ('team'),
  task_list: READ('team'),
  task_get: READ('team'),
  agent_wait: meta('team', ['read'], 'read', 'none', ['child']),
  subagent: meta('team', ['process', 'write'], 'exclusive-write', 'none', ['child']),
  agent_spawn: meta('team', ['process', 'write'], 'exclusive-write', 'none', ['child']),
  agent_ask: meta('team', ['interaction', 'write'], 'exclusive-write', 'none', ['user']),
};

for (const name of [
  'browser_navigate',
  'browser_click',
  'browser_type',
  'browser_select',
  'browser_press',
  'browser_wait_for',
  'browser_record',
])
  META[name] = meta('browser', ['external', 'write'], 'exclusive-write');
for (const name of [
  'agent_send',
  'agent_reply',
  'agent_stop',
  'board_post',
  'task_create',
  'task_update',
])
  META[name] = meta('team', ['write'], 'exclusive-write');

for (const name of [
  'web_fetch',
  'web_search',
  'browser_navigate',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_select',
  'browser_press',
  'browser_wait_for',
  'browser_screenshot',
  'browser_tabs',
  'browser_handoff',
])
  META[name] = { ...META[name]!, untrusted: true };

const FALLBACK = meta('other', ['write'], 'exclusive-write', 'operation-policy');

const IMAGES_SCHEMA = {
  type: 'array',
  description:
    'Images the operation returned, kept by the host: pass one to attachments.add() to show it to the model with the ptc result',
  items: {
    type: 'object',
    properties: {
      handle: { type: 'string', description: 'Opaque attachment handle' },
      mimeType: { type: 'string' },
      bytes: { type: 'integer' },
    },
    required: ['handle', 'mimeType', 'bytes'],
    additionalProperties: false,
  },
};

/** One alternative of a result schema: `text`, optional `images`, then the capability's fields. */
function resultBranch(typed: Record<string, unknown>): Record<string, unknown> {
  const properties = (typed.properties ?? {}) as Record<string, unknown>;
  const required = Array.isArray(typed.required) ? (typed.required as string[]) : [];
  return {
    type: 'object',
    ...(typeof typed.description === 'string' ? { description: typed.description } : {}),
    properties: {
      text: {
        type: 'string',
        description: 'The formatted output (what a person reading the result would see)',
      },
      images: IMAGES_SCHEMA,
      ...properties,
    },
    required: ['text', ...required],
    // Closed unless the capability documents an open record (team events).
    additionalProperties: typed.additionalProperties === true,
  };
}

/**
 * The full result contract of a capability: its declared typed fields plus
 * `text` and `images`. A tool without a declaration returns `{ text }` only.
 */
export function resultSchemaOf(tool: Tool): Record<string, unknown> {
  const typed = tool.resultSchema ?? { type: 'object', properties: {} };
  if (Array.isArray(typed.oneOf))
    return { oneOf: (typed.oneOf as Record<string, unknown>[]).map(resultBranch) };
  return resultBranch(typed);
}

const ERRORS: ErrorCode[] = [
  'ApprovalDenied',
  'CapabilityUnavailable',
  'InvalidArguments',
  'QuotaExceeded',
  'Cancelled',
  'Timeout',
  'OperationFailed',
];

export interface Capability {
  name: string;
  category: string;
  tool: Tool;
  meta: Meta;
}

export function capabilityMeta(name: string): Meta {
  return Object.hasOwn(META, name) ? META[name]! : FALLBACK;
}

/** Whether this call takes the execution's write slot (conservative for unknown actions). */
export function isWriteCall(name: string, args: Record<string, unknown>): boolean {
  const info = capabilityMeta(name);
  if (info.concurrency === 'read') return false;
  return !(
    info.readActions &&
    typeof args.action === 'string' &&
    info.readActions.includes(args.action)
  );
}

const label = (name: string) => {
  const words = name.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};

function example(name: string, parameters: Record<string, unknown>): string {
  const properties = (parameters.properties ?? {}) as Record<string, { type?: unknown }>;
  const required = Array.isArray(parameters.required) ? (parameters.required as string[]) : [];
  const args = required
    .slice(0, 3)
    .map((key) => {
      const type = properties[key]?.type;
      const value =
        type === 'number' || type === 'integer'
          ? '1'
          : type === 'boolean'
            ? 'true'
            : type === 'array'
              ? '[]'
              : type === 'object'
                ? '{}'
                : '"…"';
      return `${key}: ${value}`;
    })
    .join(', ');
  return `const result = await tools.${name}({${args ? ` ${args} ` : ''}});`;
}

const byteLength = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

export interface DocsRequest {
  names?: unknown;
  category?: unknown;
  cursor?: unknown;
  registryVersion?: unknown;
}

/**
 * The registry for one agent. `list` is read fresh on every use so a
 * capability that becomes unavailable disappears from docs and execution
 * alike.
 */
export class CapabilityRegistry {
  /** Cursor authentication; per process, so cursors never outlive the agent. */
  private readonly key = randomBytes(32);

  constructor(
    private readonly list: () => Tool[],
    private readonly sessionId: string,
  ) {}

  available(): Map<string, Capability> {
    const out = new Map<string, Capability>();
    for (const tool of this.list()) {
      if (WRAPPER_NAMES.has(tool.name) || !CAPABILITY_NAME.test(tool.name)) continue;
      const info = capabilityMeta(tool.name);
      out.set(tool.name, { name: tool.name, category: info.category, tool, meta: info });
    }
    return out;
  }

  contract(capability: Capability): Record<string, Json> {
    const { tool, meta: info } = capability;
    return {
      name: tool.name,
      category: info.category,
      uiLabel: label(tool.name),
      contractVersion: CONTRACT_VERSION,
      description: tool.description,
      inputSchema: tool.parameters as Json,
      resultSchema: resultSchemaOf(tool) as Json,
      errors: ERRORS,
      effects: info.effects,
      concurrency: info.concurrency,
      ...(info.readActions ? { readActions: info.readActions } : {}),
      approval: info.approval,
      suspension: info.suspension,
      ...(info.untrusted ? { untrustedContent: true } : {}),
      examples: [example(tool.name, tool.parameters)],
    };
  }

  /** What the context inspector lists: each available capability, without schemas. */
  summaries(available = this.available()) {
    return [...available.values()]
      .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name))
      .map(({ name, category, meta: info }) => ({
        name,
        category,
        uiLabel: label(name),
        effects: [...info.effects],
        approval: info.approval,
      }));
  }

  /** Content hash of the available contracts. */
  version(available = this.available()): string {
    const hash = createHash('sha256');
    for (const name of [...available.keys()].sort())
      hash.update(JSON.stringify(this.contract(available.get(name)!))).update('\0');
    return hash.digest('hex').slice(0, 16);
  }

  /** Category → capability names, for the system prompt and the docs index. */
  index(available = this.available()): Array<{ category: string; names: string[] }> {
    const groups = new Map<string, string[]>();
    for (const capability of available.values()) {
      const names = groups.get(capability.category) ?? [];
      names.push(capability.name);
      groups.set(capability.category, names);
    }
    return [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([category, names]) => ({ category, names: names.sort() }));
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.key).update(payload).digest('base64url');
  }

  private cursor(category: string, offset: number, version: string): string {
    const payload = Buffer.from(
      JSON.stringify({ s: this.sessionId, v: version, c: category, o: offset }),
    ).toString('base64url');
    return `${payload}.${this.sign(payload)}`;
  }

  private readCursor(cursor: string, category: string, version: string): number {
    const [payload, signature] = cursor.split('.');
    const expected = payload ? this.sign(payload) : '';
    if (
      !payload ||
      !signature ||
      signature.length !== expected.length ||
      !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    )
      throw new PtcError('InvalidArguments', 'Invalid cursor');
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
      s: string;
      v: string;
      c: string;
      o: number;
    };
    if (data.s !== this.sessionId || data.c !== category)
      throw new PtcError('InvalidArguments', 'The cursor belongs to a different query');
    if (data.v !== version)
      throw new PtcError(
        'StaleContract',
        'Capabilities changed since this cursor was issued; query the category again',
        'not_started',
        { names: [], registryVersion: version },
      );
    return data.o;
  }

  /** `ptc_docs`: bounded, read-only discovery. */
  docs(request: DocsRequest): Record<string, Json> {
    const allowed = new Set(['names', 'category', 'cursor', 'registryVersion']);
    for (const key of Object.keys(request))
      if (!allowed.has(key)) throw new PtcError('InvalidArguments', `Unknown argument: ${key}`);
    const { names, category, cursor, registryVersion } = request;
    if (names !== undefined && (category !== undefined || cursor !== undefined))
      throw new PtcError('InvalidArguments', 'names cannot be combined with category or cursor');
    if (cursor !== undefined && category === undefined)
      throw new PtcError('InvalidArguments', 'cursor needs the category it was issued for');
    if (registryVersion !== undefined && typeof registryVersion !== 'string')
      throw new PtcError('InvalidArguments', 'registryVersion must be a string');
    if (cursor !== undefined && typeof cursor !== 'string')
      throw new PtcError('InvalidArguments', 'cursor must be a string');
    if (
      category !== undefined &&
      (typeof category !== 'string' || !/^[a-z][a-z0-9_-]*$/.test(category))
    )
      throw new PtcError('InvalidArguments', 'category must be a category name from the index');
    if (
      names !== undefined &&
      (!Array.isArray(names) ||
        !names.length ||
        names.length > BUDGETS.docsNames ||
        names.some((name) => typeof name !== 'string' || !CAPABILITY_NAME.test(name)))
    )
      throw new PtcError(
        'InvalidArguments',
        `names must be 1–${BUDGETS.docsNames} capability names`,
      );
    const available = this.available();
    const version = this.version(available);
    const base = { registryVersion: version, contractVersion: CONTRACT_VERSION };
    if (registryVersion !== undefined && registryVersion !== version)
      throw new PtcError(
        'StaleContract',
        `Capabilities changed (registry ${version}); fetch the docs you need again`,
        'not_started',
        { names: Array.isArray(names) ? (names as string[]) : [], registryVersion: version },
      );

    if (Array.isArray(names)) {
      const requested = [...new Set(names as string[])];
      const missing = requested.filter((name) => !available.has(name));
      if (missing.length)
        throw new PtcError(
          'CapabilityUnavailable',
          `Not available in this session: ${missing.join(', ')}. ptc_docs({}) lists what is.`,
        );
      const items: Json[] = [];
      const remaining: string[] = [];
      let size = byteLength({
        ...base,
        items: [],
        truncated: true,
        nextCursor: null,
        remaining: requested,
      });
      for (const name of requested) {
        const item = this.contract(available.get(name)!);
        const itemSize = byteLength(item) + 1;
        if (!remaining.length && size + itemSize <= BUDGETS.docsOutputBytes) {
          items.push(item);
          size += itemSize;
        } else remaining.push(name);
      }
      if (!items.length)
        throw new PtcError(
          'QuotaExceeded',
          `The contract of ${requested[0]} is larger than ${BUDGETS.docsOutputBytes} bytes`,
        );
      return {
        ...base,
        items,
        truncated: remaining.length > 0,
        nextCursor: null,
        ...(remaining.length ? { remaining } : {}),
      };
    }

    if (typeof category === 'string') {
      const all = [...available.values()]
        .filter((capability) => capability.category === category)
        .sort((a, b) => a.name.localeCompare(b.name));
      if (!all.length)
        throw new PtcError(
          'CapabilityUnavailable',
          `No available capabilities in category ${category}. ptc_docs({}) lists the categories.`,
        );
      const offset = typeof cursor === 'string' ? this.readCursor(cursor, category, version) : 0;
      if (!Number.isInteger(offset) || offset < 0 || offset >= all.length)
        throw new PtcError('InvalidArguments', 'Invalid cursor');
      const items: Json[] = [];
      let size = byteLength({
        ...base,
        category,
        items: [],
        truncated: true,
        nextCursor: 'x'.repeat(200),
      });
      let index = offset;
      for (; index < all.length && items.length < BUDGETS.docsPageItems; index++) {
        const capability = all[index]!;
        const item = {
          name: capability.name,
          uiLabel: label(capability.name),
          summary: summaryOf(capability.tool.description),
          effects: capability.meta.effects,
          approval: capability.meta.approval,
        };
        const itemSize = byteLength(item) + 1;
        if (size + itemSize > BUDGETS.docsOutputBytes) break;
        items.push(item);
        size += itemSize;
      }
      const more = index < all.length;
      return {
        ...base,
        category,
        items,
        truncated: more,
        nextCursor: more ? this.cursor(category, index, version) : null,
      };
    }

    const categories = this.index(available).map(({ category: name, names: list }) => ({
      category: name,
      count: list.length,
      names: list,
    }));
    const index = { ...base, categories, truncated: false, nextCursor: null };
    if (byteLength(index) <= BUDGETS.docsOutputBytes) return index;
    // Too many names for one response: counts only; category queries list them.
    return {
      ...base,
      categories: categories.map(({ category: name, count }) => ({ category: name, count })),
      truncated: true,
      nextCursor: null,
    };
  }
}
