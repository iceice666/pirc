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
import { agentError, type AgentAnswer } from '../protocol.js';

export interface AgentOpContext {
  nodeId: string;
  session: SessionRow;
  user: string;
}
interface AgentOp {
  args: z.ZodType<unknown>;
  run(context: AgentOpContext, args: any): unknown;
}

const ops: Record<string, AgentOp> = {
  /**
   * What an assistant session gets at start-up. No workspace can be made an
   * assistant home yet (plans/assistant.md, milestone 2), so every session is
   * an ordinary one.
   */
  'assistant.context': { args: z.object({}).strict(), run: () => ({ enabled: false }) },
};

export async function runAgentOp(
  db: GatewayDatabase,
  allowedUsers: ReadonlySet<string>,
  nodeId: string,
  request: { sessionId: string; op: string; args: unknown },
): Promise<AgentAnswer> {
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
    const result = await op.run({ nodeId, session, user }, args.data);
    return { status: 200, body: { result: result ?? null } };
  } catch (error) {
    if (error instanceof ApiError) return agentError(error.statusCode, error.code, error.message);
    throw error;
  }
}
