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
import type { MemoryStore } from './memory.js';

export interface AgentOpServices {
  db: GatewayDatabase;
  allowedUsers: ReadonlySet<string>;
  memory: MemoryStore;
  /** Tell the user's open clients that their memory changed. */
  memoryChanged(user: string): void;
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
  /**
   * What an assistant session starts with: every session in a chat workspace
   * is one, and gets the user's USER entries and MEMORY notes.
   */
  'assistant.context': {
    args: z.object({}).strict(),
    run: ({ services, workspace, user }) =>
      workspace.kind === 'chat'
        ? { enabled: true, ...services.memory.context(user) }
        : { enabled: false },
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
