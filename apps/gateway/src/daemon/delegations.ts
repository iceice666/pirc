/**
 * Delegation (plans/assistant.md): the assistant in a chat hands a task to a
 * new session in one of the user's directory workspaces, or more
 * instructions to a session it started before. The user approves each one
 * in the chat, where it shows as a confirmation. Then the gateway creates
 * and names the session on the target node, delivers the task as a custom
 * message (never as the user's words), follows the session, and tells the
 * chat when the task finishes, fails or needs the user.
 */
import { randomBytes } from 'node:crypto';
import { redactSecrets } from '../agent/features/memory/redact.js';
import type { GatewayDatabase, SessionRow } from '../database.js';
import { ApiError } from '../errors.js';
import type { EventHub } from '../events.js';
import type { ModelStore } from '../models.js';
import type { GatewayEvent, Workspace } from '../types.js';
import { now } from '../util.js';
import type { NodeRegistry } from './nodes.js';
import { THINKING_LEVELS } from './schedules.js';
import {
  clip,
  deliver,
  isWatchedEvent,
  oneLine,
  readProgress,
  startSession,
  workspaceOnline,
} from './session-dispatch.js';

export type DelegationStatus =
  | 'pending_approval'
  | 'rejected'
  | 'expired'
  | 'running'
  | 'waiting_input'
  | 'completed'
  | 'failed';

export interface Delegation {
  id: string;
  ownerUser: string;
  /** The chat that asked (gateway session id). */
  assistantSessionId: string;
  workspaceId: string;
  title: string;
  task: string;
  /** The earlier delegation whose session gets this task. */
  follows: string | null;
  /** Run it on this model (the session keeps it); null for the workspace default. */
  model: ModelRef | null;
  /** And this thinking level; null for the default. */
  thinking: string | null;
  status: DelegationStatus;
  /** The delegated session (gateway session id), once dispatched. */
  targetSessionId: string | null;
  /** The delegated agent's final answer, or why it failed. */
  result: string | null;
  /** The last status the chat was told about. */
  notifiedStatus: DelegationStatus | null;
  /** Until when the user can approve it. */
  expiresAt: number;
  dispatchedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface ModelRef {
  provider: string;
  id: string;
}

export const TASK_MAX_CHARS = 20_000;
const TITLE_MAX_CHARS = 80;
/** Stored in full up to this sanity cap; readers page through it. */
const RESULT_MAX_CHARS = 200_000;
/** How much of the result the chat's update message carries. */
const RESULT_NOTICE_CHARS = 4000;
/** One `delegation_status` read of a result. */
export const RESULT_CHUNK_CHARS = 12_000;
const PENDING_MAX = 10;
/** The chat hears about these; the user already sees an approval happen. */
const NOTIFIED = new Set<DelegationStatus>([
  'rejected',
  'expired',
  'waiting_input',
  'completed',
  'failed',
]);
const NEXT_STEP: Partial<Record<DelegationStatus, string>> = {
  completed: 'It finished: tell the user what came of it.',
  failed: 'It failed: tell the user why.',
  waiting_input:
    'The delegated session is waiting for the user: ask them to open it and answer there.',
  rejected: 'The user declined it: do not ask again unless they want it.',
  expired: 'Nobody approved it in time: ask again only if it is still wanted.',
};

const rowOf = (row: any): Delegation => ({
  id: row.id,
  ownerUser: row.owner_user,
  assistantSessionId: row.assistant_session_id,
  workspaceId: row.workspace_id,
  title: row.title,
  task: row.task,
  follows: row.follows ?? null,
  model: row.model_json ? JSON.parse(row.model_json) : null,
  thinking: row.thinking ?? null,
  status: row.status,
  targetSessionId: row.target_session_id ?? null,
  result: row.result ?? null,
  notifiedStatus: row.notified_status ?? null,
  expiresAt: row.expires_at,
  dispatchedAt: row.dispatched_at ?? null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** A directory workspace by id, or by a name only one of them has. */
export function resolveDirectoryWorkspace(db: GatewayDatabase, ref: string): Workspace {
  const all = db
    .listWorkspaces()
    .filter((workspace) => workspace.kind === 'directory' && workspace.id.includes(':'));
  const exact = all.find((workspace) => workspace.id === ref);
  if (exact) return exact;
  const named = all.filter(
    (workspace) => workspace.displayName.toLowerCase() === ref.toLowerCase(),
  );
  if (named.length === 1) return named[0]!;
  if (named.length)
    throw new ApiError(
      409,
      'conflict',
      `Several workspaces are called ${ref}; use one of these ids: ${named.map((w) => w.id).join(', ')}`,
    );
  throw new ApiError(
    404,
    'not_found',
    `No workspace ${ref}. Workspaces: ${all.map((w) => `${w.displayName} (${w.id})`).join(', ') || 'none'}`,
  );
}

const modelLabel = (model: ModelRef) => `${model.provider}/${model.id}`;

/** A model the user picked: {provider,id}, `provider/id`, or null/'' for the default. */
function modelOf(value: unknown): ModelRef | null {
  if (value === null || value === '') return null;
  if (typeof value === 'string') {
    const slash = value.indexOf('/');
    if (slash > 0 && slash < value.length - 1)
      return { provider: value.slice(0, slash), id: value.slice(slash + 1) };
  } else if (
    typeof value === 'object' &&
    typeof (value as ModelRef).provider === 'string' &&
    typeof (value as ModelRef).id === 'string'
  )
    return { provider: (value as ModelRef).provider, id: (value as ModelRef).id };
  throw new ApiError(400, 'invalid_input', 'model is provider/model-id');
}

const taskMessage = (delegation: Delegation) =>
  `Task from the user's assistant, approved by the user (delegation ${delegation.id}):

${delegation.task}

Work on it here. When you are done, end with a short summary of what you did and anything left over: the assistant receives your final message.`;

export interface DelegationDeps {
  db: GatewayDatabase;
  events: EventHub;
  nodes: NodeRegistry;
  /** The gateway's models: a delegation's model must be one of them. */
  models: ModelStore;
  ttlMs: number;
  /** Browsers reload their lists: a delegated session appeared. */
  directoryChanged(): void;
  /** It finished, failed or waits for the user: push it (daemon/push.ts). */
  announce?(delegation: Delegation): void;
  warn(message: string, error?: unknown): void;
}

export class Delegations {
  private readonly scheduled = new Map<string, NodeJS.Timeout>();
  /** `id:status` pairs being reported, so one status is never pushed twice at once. */
  private readonly reporting = new Set<string>();
  private readonly sweeper: NodeJS.Timeout;
  private readonly unsubscribe: () => void;
  private closed = false;

  constructor(private readonly deps: DelegationDeps) {
    this.unsubscribe = deps.events.subscribeAll((event) => this.onEvent(event));
    this.sweeper = setInterval(() => this.sweep(), Math.min(30_000, Math.max(50, deps.ttlMs)));
    this.sweeper.unref();
    this.sweep();
  }

  close(): void {
    this.closed = true;
    clearInterval(this.sweeper);
    this.unsubscribe();
    for (const timer of this.scheduled.values()) clearTimeout(timer);
    this.scheduled.clear();
  }

  // ---------- reading ----------

  private row(id: string): Delegation | undefined {
    const row = this.deps.db.raw.prepare('SELECT * FROM delegations WHERE id=?').get(id);
    return row ? rowOf(row) : undefined;
  }

  private rows(where: string, ...values: Array<string | number>): Delegation[] {
    return (
      this.deps.db.raw
        .prepare(`SELECT * FROM delegations WHERE ${where} ORDER BY created_at`)
        .all(...values) as any[]
    ).map(rowOf);
  }

  get(user: string, id: string): Delegation {
    const delegation = this.row(id);
    if (!delegation || delegation.ownerUser !== user)
      throw new ApiError(404, 'not_found', `No delegation ${id}`);
    return delegation;
  }

  /** Newest first. */
  list(user: string, limit = 20): Delegation[] {
    return this.rows('owner_user=?', user).reverse().slice(0, limit);
  }

  /**
   * What the assistant sees of a delegation. `full` returns the result from
   * `offset` in chunks, with `nextOffset` until the end.
   */
  brief(delegation: Delegation, full = false, offset = 0) {
    const result = delegation.result;
    if (full && result !== null && offset > result.length)
      throw new ApiError(400, 'invalid_input', `offset exceeds result length ${result.length}`);
    const end = result === null ? 0 : Math.min(result.length, offset + RESULT_CHUNK_CHARS);
    return {
      id: delegation.id,
      title: delegation.title,
      workspace: this.label(delegation.workspaceId),
      status: delegation.status,
      ...(delegation.follows ? { follows: delegation.follows } : {}),
      ...(delegation.model ? { model: modelLabel(delegation.model) } : {}),
      ...(delegation.thinking ? { thinking: delegation.thinking } : {}),
      ...(delegation.targetSessionId
        ? { session: this.sessionName(delegation.targetSessionId) }
        : {}),
      ...(result
        ? full
          ? {
              result: result.slice(offset, end),
              ...(offset || end < result.length
                ? { resultOffset: offset, resultChars: result.length }
                : {}),
              ...(end < result.length ? { nextOffset: end } : {}),
            }
          : { result: clip(result, 600) }
        : {}),
      createdAt: delegation.createdAt,
    };
  }

  /** Directory workspaces the assistant may delegate to, and whether their node is online now. */
  workspaces() {
    return this.deps.db
      .listWorkspaces()
      .filter((workspace) => workspace.kind === 'directory' && workspace.id.includes(':'))
      .map((workspace) => ({
        id: workspace.id,
        name: workspace.displayName,
        node: workspace.hostId,
        online: this.online(workspace),
      }));
  }

  /** Confirmations waiting in a chat, shaped like a node's interactions. */
  pendingInteractions(sessionId: string) {
    return this.rows(
      "assistant_session_id=? AND status='pending_approval' AND expires_at>?",
      sessionId,
      now(),
    ).map((delegation) => this.interactionOf(delegation));
  }

  // ---------- the assistant ----------

  /** Record a delegation and ask the user in the chat; nothing runs before they approve. */
  create(
    user: string,
    assistant: SessionRow,
    input: {
      workspace?: string | undefined;
      task: string;
      title?: string | undefined;
      follows?: string | undefined;
      /** The assistant's suggestion; the user can change it when approving. */
      model?: ModelRef | null | undefined;
      thinking?: string | null | undefined;
    },
  ): Delegation {
    this.deps.db.requireSessionCapability(assistant.id, 'delegation');
    const task = redactSecrets(input.task).trim();
    if (!task) throw new ApiError(400, 'invalid_input', 'task is required');
    if (task.length > TASK_MAX_CHARS)
      throw new ApiError(
        413,
        'payload_too_large',
        `A task holds at most ${TASK_MAX_CHARS} characters`,
      );
    const model = this.checkModel(input.model ?? null);
    const thinking = this.checkThinking(input.thinking ?? null);
    let workspace: Workspace;
    let previous: Delegation | undefined;
    if (input.follows) {
      previous = this.get(user, input.follows);
      if (
        !previous.targetSessionId ||
        !['running', 'waiting_input', 'completed', 'failed'].includes(previous.status)
      )
        throw new ApiError(409, 'conflict', `Delegation ${previous.id} has no session to continue`);
      workspace = this.deps.db.getWorkspace(previous.workspaceId);
    } else {
      if (!input.workspace?.trim())
        throw new ApiError(
          400,
          'invalid_input',
          'Name a workspace, or an earlier delegation to follow up',
        );
      workspace = resolveDirectoryWorkspace(this.deps.db, input.workspace.trim());
    }
    if (!this.online(workspace))
      throw new ApiError(
        503,
        'node_offline',
        `${workspace.hostId} is offline; delegate when it is back, or pick another workspace`,
      );
    const waiting = this.rows("owner_user=? AND status='pending_approval'", user).length;
    if (waiting >= PENDING_MAX)
      throw new ApiError(
        429,
        'too_many_requests',
        `${waiting} delegations already wait for the user's approval`,
      );
    const title = clip(
      oneLine(input.title?.trim() || previous?.title || task.split('\n', 1)[0]!),
      TITLE_MAX_CHARS,
    );
    const id = this.newId();
    const at = now();
    this.deps.db.raw
      .prepare(
        "INSERT INTO delegations (id,owner_user,assistant_session_id,workspace_id,title,task,follows,model_json,thinking,status,expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,'pending_approval',?,?,?)",
      )
      .run(
        id,
        user,
        assistant.id,
        workspace.id,
        title,
        task,
        previous?.id ?? null,
        model ? JSON.stringify(model) : null,
        thinking,
        at + this.deps.ttlMs,
        at,
        at,
      );
    const delegation = this.row(id)!;
    this.deps.events.publish(
      assistant.id,
      assistant.runnerEpoch,
      'interaction_created',
      this.interactionOf(delegation),
    );
    return delegation;
  }

  // ---------- the user ----------

  /**
   * The user answered a confirmation in the chat `sessionId`. Returns
   * undefined when `interactionId` is not a delegation of that chat, so the
   * caller forwards the answer to the node as usual. An approval may pick
   * the model and thinking level (`model`: {provider,id}, `provider/id`, or
   * null for the default), replacing what the assistant suggested.
   */
  answer(
    sessionId: string,
    interactionId: string,
    user: string,
    answer: unknown,
  ): { interactionId: string; status: 'answered' } | undefined {
    const delegation = this.row(interactionId);
    if (!delegation || delegation.assistantSessionId !== sessionId) return undefined;
    if (delegation.ownerUser !== user)
      throw new ApiError(403, 'forbidden', 'Delegation belongs to another user');
    const reply = (answer ?? {}) as { confirmed?: unknown; model?: unknown; thinking?: unknown };
    const approved = reply.confirmed === true;
    let model = delegation.model;
    let thinking = delegation.thinking;
    if (approved) {
      this.deps.db.requireSessionCapability(sessionId, 'delegation');
      if (reply.model !== undefined) model = this.checkModel(modelOf(reply.model));
      if (reply.thinking !== undefined)
        thinking = this.checkThinking(
          reply.thinking === null || reply.thinking === '' ? null : String(reply.thinking),
        );
    }
    const changed = this.deps.db.raw
      .prepare(
        "UPDATE delegations SET status=?, model_json=?, thinking=?, updated_at=? WHERE id=? AND status='pending_approval' AND expires_at>?",
      )
      .run(
        approved ? 'running' : 'rejected',
        model ? JSON.stringify(model) : null,
        thinking,
        now(),
        delegation.id,
        now(),
      ).changes;
    if (!changed)
      throw new ApiError(409, 'stale_interaction', 'This delegation can no longer be answered');
    this.publishAnswered(delegation);
    if (approved) void this.dispatch(delegation.id);
    else void this.report(delegation.id);
    return { interactionId: delegation.id, status: 'answered' };
  }

  /** Lapse approvals nobody gave in time. */
  sweep(): void {
    for (const delegation of this.rows("status='pending_approval' AND expires_at<=?", now())) {
      const changed = this.deps.db.raw
        .prepare(
          "UPDATE delegations SET status='expired', updated_at=? WHERE id=? AND status='pending_approval'",
        )
        .run(now(), delegation.id).changes;
      if (!changed) continue;
      this.publishAnswered(delegation);
      void this.report(delegation.id);
    }
  }

  // ---------- running it ----------

  private async dispatch(id: string): Promise<void> {
    const delegation = this.row(id);
    if (!delegation || delegation.status !== 'running') return;
    try {
      const { db } = this.deps;
      db.requireSessionCapability(delegation.assistantSessionId, 'delegation');
      const workspace = db.getWorkspace(delegation.workspaceId);
      const nodeId = workspace.hostId;
      if (!this.online(workspace)) throw new Error(`${nodeId} is offline`);
      const previous = delegation.follows ? this.row(delegation.follows) : undefined;
      let target: SessionRow;
      if (previous?.targetSessionId) {
        target = db.getSession(previous.targetSessionId);
        if (target.ownerUser !== delegation.ownerUser)
          throw new Error('The session to follow up belongs to another user');
      } else {
        target = await startSession(this.deps, workspace, delegation.ownerUser, delegation.title);
      }
      db.raw
        .prepare(
          'UPDATE delegations SET target_session_id=?, dispatched_at=?, updated_at=? WHERE id=?',
        )
        .run(target.id, now(), now(), delegation.id);
      db.requireSessionCapability(delegation.assistantSessionId, 'delegation');
      await deliver(this.deps.nodes, target, delegation.ownerUser, {
        customType: 'assistant-delegation',
        content: taskMessage(delegation),
        details: { delegationId: delegation.id, title: delegation.title },
        ...(delegation.model ? { model: delegation.model } : {}),
        ...(delegation.thinking ? { thinking: delegation.thinking } : {}),
      });
    } catch (error) {
      this.finish(delegation.id, 'failed', `Could not start the task: ${(error as Error).message}`);
    }
  }

  private onEvent(event: GatewayEvent): void {
    if (!isWatchedEvent(event)) return;
    for (const delegation of this.rows(
      "target_session_id=? AND status IN ('running','waiting_input')",
      event.sessionId,
    ))
      this.schedule(delegation.id);
    // The chat's node is back: tell it what it missed.
    if (event.type === 'node_reconnected')
      for (const delegation of this.rows('assistant_session_id=?', event.sessionId))
        if (NOTIFIED.has(delegation.status) && delegation.notifiedStatus !== delegation.status)
          setTimeout(() => void this.report(delegation.id), 150).unref();
  }

  private schedule(id: string): void {
    if (this.closed || this.scheduled.has(id)) return;
    const timer = setTimeout(() => {
      this.scheduled.delete(id);
      this.check(id).catch((error) => this.deps.warn(`delegation ${id}: check failed`, error));
    }, 150);
    timer.unref();
    this.scheduled.set(id, timer);
  }

  /**
   * Read the delegated session: waiting for the user, still working, or done,
   * in which case the last answer after the task is the result.
   */
  private async check(id: string): Promise<void> {
    const delegation = this.row(id);
    if (
      !delegation ||
      !['running', 'waiting_input'].includes(delegation.status) ||
      !delegation.targetSessionId ||
      delegation.dispatchedAt === null
    )
      return;
    const progress = await readProgress(
      this.deps.nodes,
      this.deps.db.getSession(delegation.targetSessionId),
      delegation.ownerUser,
      delegation.dispatchedAt,
      (message) => message.details?.delegationId === delegation.id,
    );
    switch (progress.state) {
      case 'dropped':
        return this.finish(id, 'failed', 'The agent stopped before it took the task');
      case 'waiting':
        if (delegation.status === 'waiting_input') return;
        this.update(id, 'waiting_input');
        this.announce(id);
        void this.report(id);
        return;
      case 'working':
        // Answered: back to work, and a later wait is reported again.
        if (delegation.status === 'waiting_input') this.update(id, 'running', true);
        return;
      case 'over': {
        const { status, failureReason, answer } = progress;
        if (status === 'succeeded') this.finish(id, 'completed', answer || '(no final answer)');
        else
          this.finish(
            id,
            'failed',
            `The run ${status}${failureReason ? `: ${failureReason}` : ''}${answer ? `\n\nLast answer: ${answer}` : ''}`,
          );
        return;
      }
      default:
        return;
    }
  }

  private update(id: string, status: DelegationStatus, forgetReport = false): void {
    this.deps.db.raw
      .prepare(
        `UPDATE delegations SET status=?, updated_at=?${forgetReport ? ', notified_status=NULL' : ''} WHERE id=?`,
      )
      .run(status, now(), id);
  }

  private finish(id: string, status: 'completed' | 'failed', result: string): void {
    const changed = this.deps.db.raw
      .prepare(
        "UPDATE delegations SET status=?, result=?, updated_at=? WHERE id=? AND status IN ('running','waiting_input')",
      )
      .run(status, clip(redactSecrets(result), RESULT_MAX_CHARS), now(), id).changes;
    if (!changed) return;
    this.announce(id);
    void this.report(id);
  }

  /** Tell the chat that asked; retried when its node comes back. */
  private async report(id: string): Promise<void> {
    const delegation = this.row(id);
    if (
      !delegation ||
      !NOTIFIED.has(delegation.status) ||
      delegation.notifiedStatus === delegation.status
    )
      return;
    const key = `${delegation.id}:${delegation.status}`;
    if (this.reporting.has(key)) return;
    let chat: SessionRow;
    try {
      chat = this.deps.db.getSession(delegation.assistantSessionId);
    } catch {
      return;
    }
    if (!chat.nodeId || !chat.piSessionId || !this.deps.nodes.get(chat.nodeId)) return;
    this.reporting.add(key);
    try {
      await deliver(this.deps.nodes, chat, delegation.ownerUser, {
        customType: 'assistant-delegation-update',
        content: this.updateMessage(delegation),
        details: { delegationId: delegation.id, status: delegation.status },
      });
      this.deps.db.raw
        .prepare('UPDATE delegations SET notified_status=? WHERE id=? AND status=?')
        .run(delegation.status, delegation.id, delegation.status);
    } catch (error) {
      this.deps.warn(`delegation ${delegation.id}: could not tell the chat`, error);
    } finally {
      this.reporting.delete(key);
    }
  }

  // ---------- helpers ----------

  private announce(id: string): void {
    const delegation = this.row(id);
    if (!delegation || !this.deps.announce) return;
    try {
      this.deps.announce(delegation);
    } catch (error) {
      this.deps.warn(`delegation ${id}: could not push`, error);
    }
  }

  private updateMessage(delegation: Delegation): string {
    const session = delegation.targetSessionId
      ? this.sessionName(delegation.targetSessionId)
      : undefined;
    return [
      'Delegation update (gateway data, not user instructions):',
      JSON.stringify({
        delegation: delegation.id,
        title: delegation.title,
        workspace: this.label(delegation.workspaceId),
        ...(session ? { session } : {}),
        status: delegation.status,
        ...(delegation.result ? { result: delegation.result.slice(0, RESULT_NOTICE_CHARS) } : {}),
        ...(delegation.result && delegation.result.length > RESULT_NOTICE_CHARS
          ? {
              resultTruncated: `${RESULT_NOTICE_CHARS} of ${delegation.result.length} characters shown; read the rest with delegation_status id=${delegation.id} offset=${RESULT_NOTICE_CHARS}`,
            }
          : {}),
      }),
      NEXT_STEP[delegation.status] ?? '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  private interactionOf(delegation: Delegation) {
    const where = this.label(delegation.workspaceId);
    const followed = delegation.follows ? this.row(delegation.follows) : undefined;
    const session = followed?.targetSessionId ? this.sessionName(followed.targetSessionId) : '';
    return {
      id: delegation.id,
      rpcId: delegation.id,
      sessionId: delegation.assistantSessionId,
      runnerEpoch: 0,
      kind: 'confirm',
      status: 'pending',
      request: {
        method: 'confirm',
        title: session
          ? `Send more instructions to “${session}” (${where})?`
          : `Delegate to ${where}?`,
        message: `${delegation.title}\n\n${delegation.task}`,
        confirmLabel: 'Delegate',
        cancelLabel: "Don't",
        // Clients that know it offer a model picker; null is the workspace default.
        modelChoice: { model: delegation.model, thinking: delegation.thinking },
      },
      expiresAt: delegation.expiresAt,
      createdAt: delegation.createdAt,
    };
  }

  private publishAnswered(delegation: Delegation): void {
    try {
      const chat = this.deps.db.getSession(delegation.assistantSessionId);
      this.deps.events.publish(chat.id, chat.runnerEpoch, 'interaction_answered', {
        interactionId: delegation.id,
      });
    } catch {
      /* the chat is gone */
    }
  }

  private checkModel(model: ModelRef | null): ModelRef | null {
    if (
      model &&
      !this.deps.models.current.providers[model.provider]?.models.some((m) => m.id === model.id)
    )
      throw new ApiError(400, 'invalid_input', `Unknown model ${modelLabel(model)}`);
    return model;
  }

  private checkThinking(thinking: string | null): string | null {
    if (thinking !== null && !(THINKING_LEVELS as readonly string[]).includes(thinking))
      throw new ApiError(400, 'invalid_input', `thinking is one of ${THINKING_LEVELS.join(', ')}`);
    return thinking;
  }

  private online(workspace: Workspace): boolean {
    return workspaceOnline(this.deps.nodes, workspace);
  }

  private label(workspaceId: string): string {
    try {
      const workspace = this.deps.db.getWorkspace(workspaceId);
      return `${workspace.displayName} on ${workspace.hostId}`;
    } catch {
      return workspaceId;
    }
  }

  private sessionName(sessionId: string): string {
    try {
      return this.deps.db.getSession(sessionId).name;
    } catch {
      return sessionId;
    }
  }

  private newId(): string {
    const exists = this.deps.db.raw.prepare('SELECT 1 FROM delegations WHERE id=?');
    for (;;) {
      const id = `d${randomBytes(4).toString('hex')}`;
      if (!exists.get(id)) return id;
    }
  }
}
