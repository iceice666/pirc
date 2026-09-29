/**
 * Operations an agent may ask the gateway for through its node
 * (`agent_request` in protocol.ts). The node names the session. An operation
 * runs only if it is allowlisted here and the session belongs to that node
 * and to a user who is still allowed; an agent can never act as another
 * session.
 */
import { z } from 'zod';
import type { GatewayDatabase, SessionRow } from '../database.js';
import { ApiError } from '../errors.js';
import type { Workspace } from '../types.js';
import { agentError, type AgentAnswer } from '../protocol.js';
import type { Delegations } from './delegations.js';
import type { MemoryStore } from './memory.js';
import type { MemoryRecords } from './memory-records.js';
import type { NodeRegistry } from './nodes.js';
import { webSearchArgs, type WebSearch } from './web-search.js';

export interface AgentOpServices {
  db: GatewayDatabase;
  allowedUsers: ReadonlySet<string>;
  memory: MemoryStore;
  /** Tell the user's open clients that their memory changed. */
  memoryChanged(user: string): void;
  delegations: Delegations;
  records: MemoryRecords;
  nodes: NodeRegistry;
  /** Search the web with the gateway's key (daemon/web-search.ts). */
  webSearch: WebSearch;
}
export interface AgentOpContext {
  services: AgentOpServices;
  nodeId: string;
  session: SessionRow;
  workspace: Workspace;
  user: string;
}
interface AgentOp {
  args: z.ZodType<unknown>;
  run(context: AgentOpContext, args: any): unknown;
}

/** Memory belongs to the assistant, which lives in chat workspaces (plans/assistant.md). */
function requireChat({ workspace }: AgentOpContext): void {
  if (workspace.kind !== 'chat')
    throw new ApiError(403, 'forbidden', 'Only chat sessions have the assistant memory');
}

const action = z.enum(['add', 'replace', 'remove']);
const entryId = z.string().min(1).max(40);
/** Session history entries backing a change; the agent resolves them from the quote. */
const entryIds = z.array(z.string().min(1).max(200)).max(20);

const ops: Record<string, AgentOp> = {
  /** Any session may search the web; the key stays on the gateway. */
  'web.search': {
    args: webSearchArgs,
    run: ({ services }, args) => services.webSearch.search(args),
  },
  /**
   * What an assistant session starts with: every session in a chat workspace
   * is one, and gets the user's USER entries and MEMORY notes, and the
   * workspaces it can delegate to.
   */
  'assistant.context': {
    args: z.object({}).strict(),
    run: ({ services, workspace, user }) =>
      workspace.kind === 'chat'
        ? {
            enabled: true,
            ...services.memory.context(user),
            workspaces: services.delegations.workspaces(),
          }
        : { enabled: false },
  },
  /**
   * The assistant hands a task to a new session in a workspace, or more
   * instructions to an earlier delegation's session. The user approves it in
   * the chat first.
   */
  'delegation.create': {
    args: z
      .object({
        workspace: z.string().min(1).max(300).optional(),
        task: z.string().max(40_000),
        title: z.string().max(300).optional(),
        follows: z.string().min(1).max(40).optional(),
      })
      .strict(),
    run: (context, args) => {
      requireChat(context);
      const { delegations } = context.services;
      return delegations.brief(delegations.create(context.user, context.session, args));
    },
  },
  /**
   * Search what coding sessions noted in the user's repositories (workspace
   * memory from every node) and what delegations reported.
   */
  'memory.search': {
    args: z
      .object({
        query: z.string().min(1).max(500),
        workspace: z.string().min(1).max(300).optional(),
        limit: z.number().int().min(1).max(20).optional(),
      })
      .strict(),
    run: (context, args) => {
      requireChat(context);
      return {
        hits: context.services.records.search(context.user, args.query, {
          ...(args.workspace ? { workspace: args.workspace } : {}),
          ...(args.limit ? { limit: args.limit } : {}),
        }),
      };
    },
  },
  /**
   * Recall a workspace-memory note found by search: its node reads the
   * session that wrote it. With the node offline, the gateway's copy.
   */
  'recall.remote': {
    args: z.object({ id: z.string().regex(/^[a-f0-9]{12}$/) }).strict(),
    run: async (context, args) => {
      requireChat(context);
      const { records, nodes } = context.services;
      const found = records.find(context.user, args.id);
      if (!found.length)
        throw new ApiError(404, 'not_found', `No workspace memory note ${args.id}`);
      const parts: string[] = [];
      for (const record of found) {
        const online = !!nodes.get(record.nodeId);
        if (online) {
          try {
            const response = await nodes.request(record.nodeId, {
              method: 'POST',
              url: '/api/workspace-memory/recall',
              user: context.user,
              payload: { ledgerKey: record.ledgerKey, id: args.id },
            });
            const text = (response.body as { text?: unknown } | null)?.text;
            if (response.status < 400 && typeof text === 'string') {
              parts.push(`${record.workspace}:\n${text}`);
              continue;
            }
          } catch {
            /* fall back to the gateway's copy */
          }
        }
        parts.push(
          `Workspace memory (${record.workspace}), as the gateway last saw it:\n[${args.id}] ${record.date}${record.status === 'active' ? '' : ` [${record.status}]`} ${record.content}\n${online ? `${record.nodeId} could not read its source now.` : `${record.nodeId} is offline, so the session that wrote it cannot be read now.`}`,
        );
      }
      return { text: parts.join('\n\n'), status: 'ok' };
    },
  },
  /** One delegation with its full result, or the user's recent ones. */
  'delegation.status': {
    args: z.object({ id: z.string().min(1).max(40).optional() }).strict(),
    run: (context, args) => {
      requireChat(context);
      const { delegations } = context.services;
      return {
        delegations: args.id
          ? [delegations.brief(delegations.get(context.user, args.id), true)]
          : delegations.list(context.user).map((delegation) => delegations.brief(delegation)),
      };
    },
  },
  /** The assistant adds, replaces or removes one of its MEMORY notes. */
  'memory.note': {
    args: z
      .object({
        action,
        id: entryId.optional(),
        content: z.string().max(4000).optional(),
        /** The revision the assistant last saw (replace and remove). */
        baseRevision: z.number().int().nonnegative().nullable().optional(),
        /** Set by the agent: where the note's content came from. */
        origins: z.array(z.string().min(1).max(100)).min(1).max(20),
        entryIds: entryIds.default([]),
        /** The user's words the note rests on, when it does. */
        quote: z.string().max(4000).optional(),
      })
      .strict(),
    run: (context, args) => {
      requireChat(context);
      const { services, session, user } = context;
      const { entry, unchanged } = services.memory.writeNote(user, args, {
        actor: `session:${session.id}`,
        origins: args.origins,
        sources: {
          sessionId: session.id,
          ...(args.entryIds.length ? { entryIds: args.entryIds } : {}),
          ...(args.quote ? { quote: args.quote } : {}),
        },
      });
      if (!unchanged) services.memoryChanged(user);
      return {
        id: entry.id,
        revision: entry.revision,
        status: entry.status,
        unchanged,
        usage: services.memory.usage(user).note,
      };
    },
  },
  /**
   * The assistant proposes a USER change, resting on the user's exact words
   * in one of their messages; the user approves it in the web app.
   */
  'memory.proposeUser': {
    args: z
      .object({
        action,
        id: entryId.optional(),
        content: z.string().max(4000).optional(),
        baseRevision: z.number().int().nonnegative().nullable().optional(),
        quote: z.string().max(4000),
        entryIds: entryIds.min(1),
      })
      .strict(),
    run: (context, args) => {
      requireChat(context);
      const { services, session, user } = context;
      const { proposal, duplicate } = services.memory.propose(user, session.id, args, {
        sessionId: session.id,
        entryIds: args.entryIds,
      });
      if (!duplicate) services.memoryChanged(user);
      return { proposalId: proposal.id, duplicate };
    },
  },
};

export async function runAgentOp(
  services: AgentOpServices,
  nodeId: string,
  request: { sessionId: string; op: string; args: unknown },
): Promise<AgentAnswer> {
  const { db, allowedUsers } = services;
  const sessionId = db.resolveRemoteSession(nodeId, request.sessionId);
  if (!sessionId) return agentError(404, 'not_found', 'The gateway does not know this session');
  const session = db.getSession(sessionId);
  const user = session.ownerUser;
  if (session.nodeId !== nodeId || !user || !allowedUsers.has(user))
    return agentError(403, 'forbidden', 'This session may not use the gateway');
  const op = Object.hasOwn(ops, request.op) ? ops[request.op] : undefined;
  if (!op) return agentError(404, 'unknown_operation', `Unknown gateway operation: ${request.op}`);
  const args = op.args.safeParse(request.args);
  if (!args.success) return agentError(400, 'invalid_input', `Invalid arguments for ${request.op}`);
  try {
    const workspace = db.getWorkspace(session.workspaceId);
    const result = await op.run({ services, nodeId, session, workspace, user }, args.data);
    return { status: 200, body: { result: result ?? null } };
  } catch (error) {
    if (error instanceof ApiError)
      return agentError(error.statusCode, error.code, error.message, error.details);
    throw error;
  }
}
