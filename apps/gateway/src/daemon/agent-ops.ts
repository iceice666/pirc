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
import { resolveDirectoryWorkspace, type Delegations } from './delegations.js';
import type { MemoryStore } from './memory.js';
import type { MemoryRecords } from './memory-records.js';
import type { NodeRegistry } from './nodes.js';
import type { Push } from './push.js';
import { NOTIFY_LEVELS, type Schedule, type Schedules } from './schedules.js';
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
  /** Scheduled agent runs (daemon/schedules.ts). */
  schedules: Schedules;
  /** Push notifications (daemon/push.ts); absent in some tests. */
  push?: Push;
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

/**
 * Where a session's agent may schedule (plans/cron.md): an assistant chat in
 * its own chat or any directory workspace it may delegate to; any other
 * session only in its own workspace.
 */
function scheduleScope({ services, workspace: own }: AgentOpContext) {
  const chat = own.kind === 'chat';
  return {
    resolve(ref: string): Workspace {
      if (ref === own.id || ref.toLowerCase() === own.displayName.toLowerCase()) return own;
      if (chat) return resolveDirectoryWorkspace(services.db, ref);
      throw new ApiError(
        403,
        'forbidden',
        'Only the assistant schedules in other workspaces: leave workspace out to schedule here',
      );
    },
    allows: (schedule: Schedule) => chat || schedule.workspaceId === own.id,
  };
}

/** An agent's view of the user's schedule `id`, if its session may manage it. */
function scopedSchedule(context: AgentOpContext, id: string): Schedule {
  const schedule = context.services.schedules.get(context.user, id);
  if (!scheduleScope(context).allows(schedule))
    throw new ApiError(404, 'not_found', `No schedule ${id} in this workspace`);
  return schedule;
}

/** A scheduled run may not start more work: no new schedules, resumes or runs from it. */
function refuseFromScheduledRun({ services, session }: AgentOpContext): void {
  if (services.schedules.isRunSession(session.id))
    throw new ApiError(
      403,
      'forbidden',
      'A scheduled run cannot create, change, resume or start schedules',
    );
}

const scheduleFields = {
  title: z.string().max(300).optional(),
  cron: z.string().max(200).optional(),
  at: z.string().max(100).optional(),
  timezone: z.string().max(100).optional(),
  // No model or thinking level: only the user picks those (schedule settings).
  notify: z.enum(NOTIFY_LEVELS).optional(),
};
const scheduleId = z.object({ id: z.string().min(1).max(40) }).strict();

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
    run: ({ services, workspace, user, session }) =>
      workspace.kind === 'chat'
        ? {
            enabled: true,
            capabilities: services.db.getWorkspaceCapabilities(workspace.id),
            ...services.memory.context(user, session.id),
            workspaces: services.delegations.workspaces(),
          }
        : // Directory workspaces have no policy: every capability stays allowed.
          { enabled: false },
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
        /** The target workspace's role; no model or thinking level: only the user picks those. */
        role: z
          .string()
          .regex(/^[a-z][a-z0-9_-]{0,39}$/)
          .optional(),
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
    args: z
      .object({
        id: z.string().min(1).max(40).optional(),
        offset: z.number().int().min(0).optional(),
      })
      .strict(),
    run: (context, args) => {
      requireChat(context);
      const { delegations } = context.services;
      if (args.offset !== undefined && !args.id)
        throw new ApiError(400, 'invalid_input', 'offset needs an id');
      return {
        delegations: args.id
          ? [delegations.brief(delegations.get(context.user, args.id), true, args.offset ?? 0)]
          : delegations.list(context.user).map((delegation) => delegations.brief(delegation)),
      };
    },
  },
  /** The user's schedules this session may manage, and the default time zone. */
  'schedule.list': {
    args: z.object({}).strict(),
    run: (context) => {
      const { schedules } = context.services;
      const scope = scheduleScope(context);
      return {
        schedules: schedules
          .list(context.user)
          .filter(scope.allows)
          .map((schedule) => schedules.brief(schedule)),
        timezone: schedules.defaultTimezone,
      };
    },
  },
  /** A run's final message, in chunks, for runs of schedules this session may manage. */
  'schedule.result': {
    args: z
      .object({ id: z.string().min(1).max(40), offset: z.number().int().min(0).optional() })
      .strict(),
    run: (context, args) => {
      const { schedules } = context.services;
      const run = schedules.getRun(context.user, args.id);
      try {
        scopedSchedule(context, run.scheduleId);
      } catch {
        throw new ApiError(404, 'not_found', `No run ${args.id} in this workspace`);
      }
      return schedules.runResult(run, args.offset ?? 0);
    },
  },
  /** Propose a new schedule; it exists once the user approves it in the chat. */
  'schedule.create': {
    args: z
      .object({
        workspace: z.string().min(1).max(300).optional(),
        prompt: z.string().max(40_000),
        ...scheduleFields,
      })
      .strict(),
    run: (context, args) => {
      refuseFromScheduledRun(context);
      const { workspace, ...input } = args;
      const { proposalId, spec } = context.services.schedules.propose(
        context.user,
        context.session,
        { ...input, workspace: workspace ?? context.workspace.id },
        scheduleScope(context).resolve,
      );
      return { proposalId, status: 'pending_approval', title: spec.title };
    },
  },
  /** Propose a change to a schedule; it applies once the user approves it. */
  'schedule.update': {
    args: z
      .object({
        id: z.string().min(1).max(40),
        workspace: z.string().min(1).max(300).optional(),
        prompt: z.string().max(40_000).optional(),
        ...scheduleFields,
      })
      .strict(),
    run: (context, args) => {
      refuseFromScheduledRun(context);
      const { id, ...input } = args;
      scopedSchedule(context, id);
      const { proposalId, spec } = context.services.schedules.propose(
        context.user,
        context.session,
        input,
        scheduleScope(context).resolve,
        id,
      );
      return { proposalId, status: 'pending_approval', title: spec.title };
    },
  },
  'schedule.pause': {
    args: scheduleId,
    run: (context, { id }) => {
      scopedSchedule(context, id);
      const { schedules } = context.services;
      return schedules.brief(schedules.pause(context.user, id));
    },
  },
  'schedule.resume': {
    args: scheduleId,
    run: (context, { id }) => {
      refuseFromScheduledRun(context);
      scopedSchedule(context, id);
      const { schedules } = context.services;
      return schedules.brief(schedules.resume(context.user, id));
    },
  },
  'schedule.delete': {
    args: scheduleId,
    run: (context, { id }) => {
      const schedule = scopedSchedule(context, id);
      context.services.schedules.delete(context.user, id);
      return { id, title: schedule.title, deleted: true };
    },
  },
  /** Run a schedule now (the user's /cron run). */
  'schedule.run': {
    args: scheduleId,
    run: (context, { id }) => {
      refuseFromScheduledRun(context);
      scopedSchedule(context, id);
      const run = context.services.schedules.runNow(context.user, id);
      return { runId: run.id, status: run.status };
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
      if (!duplicate) {
        services.memoryChanged(user);
      }
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
    const capability = request.op.startsWith('delegation.')
      ? 'delegation'
      : request.op.startsWith('schedule.')
        ? 'schedules'
        : request.op === 'memory.search'
          ? 'memory_search'
          : request.op === 'recall.remote'
            ? 'remote_recall'
            : request.op === 'web.search'
              ? 'web_search'
              : null;
    if (capability) db.requireWorkspaceCapability(workspace.id, capability);
    const result = await op.run({ services, nodeId, session, workspace, user }, args.data);
    return { status: 200, body: { result: result ?? null } };
  } catch (error) {
    if (error instanceof ApiError)
      return agentError(error.statusCode, error.code, error.message, error.details);
    throw error;
  }
}
