/**
 * The assistant's memory in chat sessions (plans/assistant.md). The gateway
 * holds, per user, USER entries (who the user is; changed only with their
 * approval) and MEMORY notes (the assistant's own). A chat starts with both
 * frozen into its system prompt. `memory_note` writes notes directly and
 * `memory_propose_user` asks the user to approve a USER change that rests on
 * their exact words, which code finds in their own messages: the model never
 * decides where a memory came from.
 */
import type { Agent } from '../../agent.js';
import { capabilities, type Capabilities } from '../../capabilities.js';
import type { Feature } from '../../feature.js';
import { GatewayError, processGateway, type NodeGateway } from '../../gateway.js';
import type { Message } from '../../messages.js';
import type { SessionEntry } from '../../session-store.js';
import { text, typed, type Tool, type ToolResult } from '../../tools/types.js';
import { arr, bool, fields, int, nullable, obj, str } from '../../tools/result-schema.js';
import { localStamp } from '../memory/ledger.js';
import { redactSecrets } from '../memory/redact.js';
import { messageOrigin } from '../memory/serialize.js';
import { startedCapabilities } from '../../ptc/contracts.js';
import { describeRoles, type RoleBrief } from '../../roles.js';
import { toolPrompt } from '../../prompts/tools.js';

/** Session entry: the memory frozen into this chat's system prompt, with the revisions it showed. */
export const ASSISTANT_SNAPSHOT = 'assistant.snapshot';
export const NOTE_TOOL = 'memory_note';
export const PROPOSE_TOOL = 'memory_propose_user';
export const DELEGATE_TOOL = 'delegate';
export const DELEGATIONS_TOOL = 'delegation_status';
export const SEARCH_TOOL = 'memory_search';
const MEMORY_TOOLS = new Set([NOTE_TOOL, PROPOSE_TOOL]);
/** Session entry: a note revision this chat wrote (`learn` after a restart). */
const NOTE_REVISION = 'assistant.note_revision';
/** A chat waits this long for its memory before starting without it (and trying again next run). */
const CONTEXT_TIMEOUT_MS = 10_000;

interface Brief {
  id: string;
  content: string;
  revision: number;
  updatedAt?: number;
}
interface WorkspaceBrief {
  id: string;
  name: string;
  node: string;
  online?: boolean;
  /** Roles a delegation can start in there (agent/roles.ts). */
  roles?: RoleBrief[];
}
interface MemoryContext {
  capabilities?: Capabilities;
  enabled?: boolean;
  user?: Brief[];
  notes?: Brief[];
  usage?: Record<'user' | 'note', { used: number; max: number }>;
  pendingProposals?: number;
  /** Where the assistant can delegate tasks. */
  workspaces?: WorkspaceBrief[];
}
/** A delegation as the gateway reports it (daemon/delegations.ts `brief`). */
interface DelegationBrief {
  id: string;
  title: string;
  workspace: string;
  status: string;
  role?: string;
  model?: string;
  thinking?: string;
  session?: string;
  result?: string;
  resultOffset?: number;
  resultChars?: number;
  nextOffset?: number;
}

const number = (value: number) => value.toLocaleString('en-US');

const DELEGATION = obj(
  {
    id: str(),
    title: str(),
    workspace: str(),
    status: str(),
    role: str(),
    model: str(),
    thinking: str(),
    session: str('Name of the session doing the work'),
    result: str('This chunk of the final answer'),
    resultOffset: int(),
    resultChars: int(),
    nextOffset: nullable(int('Where the next chunk starts, or null at the end')),
  },
  ['role', 'model', 'thinking', 'session', 'result', 'resultOffset', 'resultChars', 'nextOffset'],
);

/** The documented fields of a gateway delegation record. */
function delegationData(delegation: DelegationBrief): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: String(delegation.id),
    title: String(delegation.title),
    workspace: String(delegation.workspace),
    status: String(delegation.status),
  };
  for (const key of ['role', 'model', 'thinking', 'session', 'result'] as const)
    if (typeof delegation[key] === 'string') out[key] = delegation[key];
  for (const key of ['resultOffset', 'resultChars'] as const)
    if (typeof delegation[key] === 'number') out[key] = delegation[key];
  if (delegation.resultChars !== undefined) out.nextOffset = delegation.nextOffset ?? null;
  return out;
}

/** Where a chunked delegation result stands, and how to read on. */
function resultFooter(delegation: DelegationBrief): string {
  if (delegation.resultChars === undefined) return '';
  const start = delegation.resultOffset ?? 0;
  const end = delegation.nextOffset ?? delegation.resultChars;
  return delegation.nextOffset === undefined
    ? `\n[Result characters ${start}–${end} of ${delegation.resultChars}; end of result]`
    : `\n[Result characters ${start}–${end} of ${delegation.resultChars}; continue with delegation_status id=${delegation.id} offset=${end}]`;
}

export function renderMemory(context: MemoryContext): string {
  const user = context.user ?? [];
  const notes = context.notes ?? [];
  const size = (kind: 'user' | 'note') =>
    context.usage
      ? ` (${number(context.usage[kind].used)}/${number(context.usage[kind].max)} characters)`
      : '';
  const pending = context.pendingProposals ?? 0;
  return [
    '## Memory',
    '',
    'What you remember from earlier chats with this user. It was loaded when this chat started; changes reach new chats only.',
    '',
    '- USER is what the user told you about themselves, their preferences and standing rules. They approved every entry: follow it unless they say otherwise now. To change it, call memory_propose_user with their exact words; they approve it in Settings → Memory.',
    '- MEMORY holds your own notes from earlier chats. They may be stale: check what can change, and prefer what the user says now. Keep them current with memory_note.',
    ...(pending
      ? [
          '',
          `${pending} proposed USER change${pending === 1 ? ' is' : 's are'} waiting for the user's approval.`,
        ]
      : []),
    '',
    `### USER${size('user')}`,
    ...(user.length ? user.map((entry) => `[${entry.id}] ${entry.content}`) : ['(none yet)']),
    '',
    `### MEMORY${size('note')}`,
    ...(notes.length
      ? notes.map(
          (entry) =>
            `[${entry.id}] ${entry.updatedAt ? `${localStamp(entry.updatedAt).slice(0, 10)} ` : ''}${entry.content}`,
        )
      : ['(none yet)']),
  ].join('\n');
}

/**
 * The frozen memory section as shown under the chat's current capability
 * policy. The snapshot is kept as written (the policy can change later), so
 * guidance for disabled tools is taken out each time it is shown.
 */
export function presentSection(section: string, capabilities: Capabilities): string {
  if (!capabilities.delegation) return section.replace(/\n*## Workspaces\n[\s\S]*$/, '');
  if (!capabilities.memory_search)
    return section.replace(
      / Their coding sessions keep notes there \(workspace memory\)[^\n]*/,
      '',
    );
  if (!capabilities.remote_recall)
    return section.replace(/, and open a note's sources with recall\./, '.');
  return section;
}

/** The user's repositories the assistant can hand tasks to, as of the chat's start. */
export function renderWorkspaces(workspaces: WorkspaceBrief[] = []): string {
  if (!workspaces.length) return '';
  return [
    '## Workspaces',
    '',
    `The user's repositories you can hand tasks to with ${DELEGATE_TOOL}. Online status is as of this chat's start. Their coding sessions keep notes there (workspace memory): search them with ${SEARCH_TOOL}, and open a note's sources with recall.`,
    ...workspaces.map((workspace) => {
      const line = `[${workspace.id}] ${workspace.name} on ${workspace.node}${workspace.online === false ? ' (offline)' : ''}`;
      return workspace.roles?.length
        ? `${line}\n  Roles:\n${describeRoles(workspace.roles)
            .split('\n')
            .map((item) => `  ${item}`)
            .join('\n')}`
        : line;
    }),
  ].join('\n');
}

const UNAVAILABLE = `## Memory

Your memory of this user could not be loaded: the gateway is unreachable. You probably know things about them from earlier chats that you cannot see now, so do not assume you know nothing, and say so when it matters. ${NOTE_TOOL} and ${PROPOSE_TOOL} fail until it is back.`;

// ---------- where a memory comes from ----------

const userText = (message: Extract<Message, { role: 'user' }>) =>
  typeof message.content === 'string'
    ? message.content
    : message.content
        .filter((part) => part.type === 'text')
        .map((part) => (part as { text: string }).text)
        .join('\n');
/** Compare words, not typography: width, case, spacing and surrounding quote marks. */
const words = (value: string) =>
  value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'“”‘’「」『』]+|["'“”‘’「」『』]+$/g, '')
    .trim();

/**
 * The newest message the human typed in this chat (`role: 'user'`; features,
 * delegations and teammates only add custom messages) that contains `quote`.
 */
export function findQuote(branch: SessionEntry[], quote: string): string | undefined {
  const wanted = words(quote);
  if (wanted.length < 2) return undefined;
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index]!;
    if (
      entry.type === 'message' &&
      entry.message.role === 'user' &&
      words(userText(entry.message)).includes(wanted)
    )
      return entry.id;
  }
  return undefined;
}

/**
 * Where what the assistant knows right now came from: itself, plus every tool
 * result and custom message since the user's last message (a page fetched
 * with `bash` taints a note written from it).
 */
export function currentOrigins(branch: SessionEntry[], running: Iterable<string> = []): string[] {
  const origins = new Set(['assistant']);
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index]!;
    if (entry.type !== 'message') continue;
    const message = entry.message;
    if (message.role === 'user') break;
    if (message.role === 'toolResult' && MEMORY_TOOLS.has(message.toolName)) continue;
    // A ptc result carries what its operations returned: judge by those.
    const started = startedCapabilities(message);
    if (started) {
      for (const name of started) if (!MEMORY_TOOLS.has(name)) origins.add(`tool:${name}`);
      // No operation ran, but hook output may still have been appended.
      if (!started.length) origins.add(messageOrigin(message));
      continue;
    }
    if (message.role === 'toolResult' || message.role === 'custom')
      origins.add(messageOrigin(message));
  }
  for (const name of running) if (!MEMORY_TOOLS.has(name)) origins.add(`tool:${name}`);
  return [...origins].sort();
}

// ---------- the feature ----------

export function assistantFeature(): Feature {
  let frozen: string | undefined;
  /** Revision of each entry as this chat last saw it, sent with replace and remove. */
  const revisions = new Map<string, number>();

  const gatewayOf = (agent: Agent) =>
    agent.config.workspaceKind === 'chat' ? processGateway() : undefined;

  /** After a restart: the snapshot's revisions, then every write this chat made. */
  const learn = (agent: Agent) => {
    for (const entry of agent.store.branch()) {
      if (entry.type === 'custom' && entry.customType === ASSISTANT_SNAPSHOT) {
        const seen = (entry.data as { revisions?: Record<string, unknown> })?.revisions ?? {};
        for (const [id, revision] of Object.entries(seen))
          if (typeof revision === 'number') revisions.set(id, revision);
      } else if (entry.type === 'custom' && entry.customType === NOTE_REVISION) {
        const data = entry.data as { id?: unknown; revision?: unknown } | undefined;
        if (typeof data?.id === 'string' && typeof data.revision === 'number')
          revisions.set(data.id, data.revision);
      } else if (
        entry.type === 'message' &&
        entry.message.role === 'toolResult' &&
        entry.message.toolName === NOTE_TOOL
      ) {
        const details = entry.message.details as { id?: unknown; revision?: unknown } | undefined;
        if (typeof details?.id === 'string' && typeof details.revision === 'number')
          revisions.set(details.id, details.revision);
      }
    }
  };

  /** The memory section of this chat's system prompt, frozen once loaded. */
  async function memorySection(agent: Agent, gateway: NodeGateway): Promise<string> {
    let context: MemoryContext;
    try {
      context = ((await gateway.request(
        'assistant.context',
        {},
        AbortSignal.timeout(CONTEXT_TIMEOUT_MS),
      )) ?? {}) as MemoryContext;
    } catch {
      // Preserve the last known policy when offline; the gateway still enforces every operation.
      return frozen ?? UNAVAILABLE;
    }
    agent.capabilities = capabilities(context.capabilities);
    if (frozen !== undefined) return frozen;
    const existing = agent.store
      .branch()
      .findLast((entry) => entry.type === 'custom' && entry.customType === ASSISTANT_SNAPSHOT);
    if (existing?.type === 'custom')
      return (frozen = String((existing.data as { text?: unknown })?.text ?? ''));
    const shown = context.enabled ? [...(context.user ?? []), ...(context.notes ?? [])] : [];
    for (const entry of shown) revisions.set(entry.id, entry.revision);
    const section = context.enabled
      ? [renderMemory(context), renderWorkspaces(context.workspaces)].filter(Boolean).join('\n\n')
      : '';
    agent.store.append({
      type: 'custom',
      customType: ASSISTANT_SNAPSHOT,
      data: {
        text: section,
        revisions: Object.fromEntries(shown.map((entry) => [entry.id, entry.revision])),
      },
    });
    return (frozen = section);
  }

  const failure = (error: unknown, details?: unknown): ToolResult => {
    if (!(error instanceof GatewayError)) throw error;
    const message = ['gateway_offline', 'gateway_timeout', 'gateway_closed'].includes(error.code)
      ? 'Memory is unavailable right now (the gateway cannot be reached); nothing was saved.'
      : error.code === 'forgotten'
        ? 'The user asked to forget this; do not save it again.'
        : error.message;
    return text(message, details ?? { code: error.code }, true);
  };

  const noteTool = (agent: Agent, gateway: NodeGateway): Tool => ({
    name: NOTE_TOOL,
    description: toolPrompt('memory_note'),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'replace', 'remove'] },
        id: { type: 'string', description: 'The note to replace or remove, like n1a2b3c4d.' },
        content: {
          type: 'string',
          description: 'The note, one self-contained line (add and replace).',
        },
        quote: {
          type: 'string',
          description:
            "Optional: the user's exact words in this chat that the note rests on. They are checked against the user's messages.",
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    resultSchema: fields({
      id: str('The note, like n1a2b3c4d'),
      revision: int(),
      unchanged: bool('It already said this'),
      used: int('Characters MEMORY uses now'),
      max: int(),
    }),
    async execute(args, ctx) {
      const action = args.action;
      if (action !== 'add' && action !== 'replace' && action !== 'remove')
        return text('action must be add, replace or remove', undefined, true);
      const id = typeof args.id === 'string' ? args.id.trim() : '';
      const content = typeof args.content === 'string' ? args.content.trim() : '';
      if (action !== 'add' && !id)
        return text('id is required to replace or remove a note', undefined, true);
      if (action !== 'remove' && !content)
        return text('content is required to add or replace a note', undefined, true);
      const branch = agent.store.branch();
      const origins = new Set(
        currentOrigins(
          branch,
          [...agent.runningScripts].flatMap((names) => [...names]),
        ),
      );
      let entryIds: string[] = [];
      let quote: string | undefined;
      if (typeof args.quote === 'string' && args.quote.trim()) {
        const found = findQuote(branch, args.quote);
        if (!found)
          return text(
            "That quote is not in the user's messages in this chat. Quote their exact words, or leave quote out.",
            undefined,
            true,
          );
        entryIds = [found];
        origins.add('user');
        quote = redactSecrets(args.quote.trim());
      }
      try {
        const result = (await gateway.request(
          'memory.note',
          {
            action,
            ...(id ? { id } : {}),
            ...(content ? { content: redactSecrets(content) } : {}),
            ...(action === 'add' ? {} : { baseRevision: revisions.get(id) ?? null }),
            origins: [...origins].sort(),
            entryIds,
            ...(quote ? { quote } : {}),
          },
          ctx.signal,
        )) as {
          id: string;
          revision: number;
          unchanged: boolean;
          usage: { used: number; max: number };
        };
        revisions.set(result.id, result.revision);
        // The tool result reaches the session inside a ptc result, without
        // these details: record the revision on its own for a restart.
        agent.store.append({
          type: 'custom',
          customType: NOTE_REVISION,
          data: { id: result.id, revision: result.revision },
        });
        const room = `MEMORY now uses ${number(result.usage.used)}/${number(result.usage.max)} characters.`;
        const done =
          action === 'remove'
            ? `Removed note ${result.id}; the user can restore it in Settings → Memory.`
            : result.unchanged
              ? `Note ${result.id} already says this; nothing changed.`
              : `${action === 'add' ? 'Saved' : 'Updated'} note ${result.id}. New chats will see it.`;
        return typed(
          `${done} ${room}`,
          {
            id: result.id,
            revision: result.revision,
            unchanged: result.unchanged === true,
            used: result.usage.used,
            max: result.usage.max,
          },
          { details: { id: result.id, revision: result.revision } },
        );
      } catch (error) {
        const current = error instanceof GatewayError ? (error.details as any) : undefined;
        if (
          error instanceof GatewayError &&
          error.code === 'conflict' &&
          typeof current?.id === 'string' &&
          typeof current.revision === 'number'
        ) {
          revisions.set(current.id, current.revision);
          agent.store.append({
            type: 'custom',
            customType: NOTE_REVISION,
            data: { id: current.id, revision: current.revision },
          });
          return text(
            `Note ${current.id} changed in another chat since you last saw it. It now reads: ${JSON.stringify(current.content)}. If your change still applies, call ${NOTE_TOOL} again.`,
            { id: current.id, revision: current.revision },
            true,
          );
        }
        return failure(error);
      }
    },
  });

  const proposeTool = (agent: Agent, gateway: NodeGateway): Tool => ({
    name: PROPOSE_TOOL,
    description: toolPrompt('memory_propose_user'),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'replace', 'remove'] },
        id: { type: 'string', description: 'The USER entry to replace or remove, like u1a2b3c4d.' },
        content: { type: 'string', description: 'The entry, one short line (add and replace).' },
        quote: {
          type: 'string',
          description: "The user's exact words in this chat that this change rests on.",
        },
      },
      required: ['action', 'quote'],
      additionalProperties: false,
    },
    resultSchema: fields({
      proposalId: str('Nothing is saved until the user approves it in Settings → Memory'),
      duplicate: bool('The same change was already waiting'),
    }),
    async execute(args, ctx) {
      const action = args.action;
      if (action !== 'add' && action !== 'replace' && action !== 'remove')
        return text('action must be add, replace or remove', undefined, true);
      const id = typeof args.id === 'string' ? args.id.trim() : '';
      const content = typeof args.content === 'string' ? args.content.trim() : '';
      if (action !== 'add' && !id)
        return text('id is required to replace or remove a USER entry', undefined, true);
      if (action !== 'remove' && !content)
        return text('content is required to add or replace a USER entry', undefined, true);
      const found =
        typeof args.quote === 'string' ? findQuote(agent.store.branch(), args.quote) : undefined;
      if (!found)
        return text(
          "That quote is not in the user's messages in this chat. USER changes need the user's own words, quoted exactly.",
          undefined,
          true,
        );
      try {
        const result = (await gateway.request(
          'memory.proposeUser',
          {
            action,
            ...(id ? { id } : {}),
            ...(content ? { content: redactSecrets(content) } : {}),
            ...(action === 'add' ? {} : { baseRevision: revisions.get(id) ?? null }),
            quote: redactSecrets(String(args.quote).trim()),
            entryIds: [found],
          },
          ctx.signal,
        )) as { proposalId: string; duplicate: boolean };
        return typed(
          result.duplicate
            ? `This change is already waiting for the user's approval (proposal ${result.proposalId}).`
            : `Proposed (proposal ${result.proposalId}). Nothing is saved until the user approves it in Settings → Memory; tell them what you proposed.`,
          { proposalId: result.proposalId, duplicate: result.duplicate === true },
          { details: { proposalId: result.proposalId } },
        );
      } catch (error) {
        return failure(error);
      }
    },
  });

  const delegateTool = (gateway: NodeGateway): Tool => ({
    name: DELEGATE_TOOL,
    description: toolPrompt('delegate'),
    parameters: {
      type: 'object',
      properties: {
        workspace: {
          type: 'string',
          description:
            'The workspace id (like m5pro:workspace_…), or its name if no other workspace has it.',
        },
        task: { type: 'string', description: 'The whole task, standing on its own.' },
        title: { type: 'string', description: 'A short title; it names the new session.' },
        follows: {
          type: 'string',
          description:
            "An earlier delegation's id (like d1a2b3c4d): send the task to its session instead.",
        },
        role: {
          type: 'string',
          pattern: '^[a-z][a-z0-9_-]{0,39}$',
          description:
            'A role of the target workspace (see ## Workspaces); default: none (the workspace default). Not with follows.',
        },
      },
      required: ['task'],
      additionalProperties: false,
    },
    // Asks the user; nothing runs until they approve it in the chat.
    resultSchema: fields({ delegation: DELEGATION }),
    async execute(args, ctx) {
      const field = (key: string) => (typeof args[key] === 'string' ? args[key].trim() : '');
      const task = field('task');
      if (!task) return text('task is required', undefined, true);
      const [workspace, title, follows, role] = [
        field('workspace'),
        field('title'),
        field('follows'),
        field('role'),
      ];
      if (!workspace && !follows)
        return text(
          'Name a workspace, or pass follows with an earlier delegation id',
          undefined,
          true,
        );
      try {
        const result = (await gateway.request(
          'delegation.create',
          {
            ...(workspace ? { workspace } : {}),
            task: redactSecrets(task),
            ...(title ? { title } : {}),
            ...(follows ? { follows } : {}),
            ...(role ? { role } : {}),
          },
          ctx.signal,
        )) as DelegationBrief;
        return typed(
          `Asked the user to approve delegation ${result.id} (“${result.title}”, ${result.workspace}${result.role ? `, role ${result.role}` : ''}). They can pick the model when approving. Nothing runs until they do; you will get a message when it finishes, fails or needs them.`,
          { delegation: delegationData(result) },
          { details: { delegationId: result.id } },
        );
      } catch (error) {
        return failure(error);
      }
    },
  });

  const searchTool = (agent: Agent, gateway: NodeGateway): Tool => ({
    name: SEARCH_TOOL,
    // A getter: only mention tools this chat's capability policy allows.
    get description() {
      return toolPrompt('memory_search', {
        recall: agent.capabilities.remote_recall,
        delegation: agent.capabilities.delegation,
      });
    },
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to look for, separated by spaces.' },
        workspace: {
          type: 'string',
          description: 'Only this workspace: its id, or its name if no other workspace has it.',
        },
        limit: { type: 'number', description: 'At most this many results (1 to 20, default 8).' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    resultSchema: fields({
      hits: arr(
        obj(
          {
            id: str('Recall it with recall({ id })'),
            kind: str(),
            workspace: str(),
            date: str(),
            status: str(),
            git: str(),
            content: str(),
          },
          ['git'],
        ),
      ),
    }),
    async execute(args, ctx) {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query) return text('query is required', undefined, true);
      const workspace = typeof args.workspace === 'string' ? args.workspace.trim() : '';
      const limit =
        typeof args.limit === 'number' && Number.isFinite(args.limit)
          ? Math.min(20, Math.max(1, Math.floor(args.limit)))
          : undefined;
      try {
        const result = (await gateway.request(
          'memory.search',
          { query, ...(workspace ? { workspace } : {}), ...(limit ? { limit } : {}) },
          ctx.signal,
        )) as {
          hits: Array<{
            id: string;
            kind: string;
            workspace: string;
            date: string;
            status: string;
            git?: string;
            content: string;
          }>;
        };
        const hits = result.hits.map((hit) => ({
          id: String(hit.id),
          kind: String(hit.kind),
          workspace: String(hit.workspace),
          date: String(hit.date),
          status: String(hit.status),
          ...(typeof hit.git === 'string' ? { git: hit.git } : {}),
          content: String(hit.content),
        }));
        if (!result.hits.length)
          return typed(`Nothing found for ${JSON.stringify(query)}.`, { hits });
        const shown = text(
          result.hits
            .map((hit) => {
              const where =
                hit.kind === 'delegation' ? `delegation to ${hit.workspace}` : hit.workspace;
              const state =
                hit.kind === 'delegation' || hit.status !== 'active' ? ` · ${hit.status}` : '';
              return `[${hit.id}] ${where} · ${hit.date}${hit.git ? ` · ${hit.git}` : ''}${state}\n${hit.content}`;
            })
            .join('\n\n'),
          { hits: result.hits.map((hit) => hit.id) },
        );
        return { ...shown, data: { hits } };
      } catch (error) {
        return failure(error);
      }
    },
  });

  const delegationsTool = (gateway: NodeGateway): Tool => ({
    name: DELEGATIONS_TOOL,
    description: toolPrompt('delegation_status'),
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'A delegation id, like d1a2b3c4d.' },
        offset: {
          type: 'integer',
          minimum: 0,
          description: 'With id: first result character to return (default 0)',
        },
      },
      additionalProperties: false,
    },
    resultSchema: fields({ delegations: arr(DELEGATION) }),
    async execute(args, ctx) {
      const id = typeof args.id === 'string' ? args.id.trim() : '';
      const offset = Number.isInteger(args.offset) && args.offset > 0 ? args.offset : 0;
      try {
        const result = (await gateway.request(
          'delegation.status',
          id ? { id, ...(offset ? { offset } : {}) } : {},
          ctx.signal,
        )) as { delegations: DelegationBrief[] };
        const delegations = result.delegations.map(delegationData);
        if (!result.delegations.length) return typed('No delegations yet.', { delegations });
        const shown = text(
          result.delegations
            .map(
              (delegation) =>
                `${delegation.id} · ${delegation.status} · “${delegation.title}” → ${delegation.workspace}${delegation.session ? ` (session “${delegation.session}”)` : ''}${delegation.result ? `\n${delegation.result}` : ''}${resultFooter(delegation)}`,
            )
            .join('\n\n'),
          { delegations: result.delegations.map((delegation) => delegation.id) },
        );
        return { ...shown, data: { delegations } };
      } catch (error) {
        return failure(error);
      }
    },
  });

  return {
    name: 'assistant',
    tools: (agent) => {
      const gateway = gatewayOf(agent);
      return gateway
        ? [
            noteTool(agent, gateway),
            proposeTool(agent, gateway),
            delegateTool(gateway),
            delegationsTool(gateway),
            searchTool(agent, gateway),
          ]
        : [];
    },
    init(agent) {
      if (gatewayOf(agent)) learn(agent);
    },
    async beforeAgentStart(agent) {
      const gateway = gatewayOf(agent);
      if (!gateway) return;
      const section = presentSection(await memorySection(agent, gateway), agent.capabilities);
      return section
        ? {
            systemPrompt: [
              {
                id: 'assistant',
                title: 'Assistant memory and workspaces',
                source: 'gateway',
                frozen: true,
                text: section,
              },
            ],
          }
        : undefined;
    },
  };
}
