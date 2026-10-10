/**
 * Scheduled agent runs (docs/history/cron.md). The gateway keeps each user's
 * schedules and one timer for the earliest due one. When one falls due it
 * starts a new session in the schedule's workspace, delivers the prompt as a
 * `scheduled-run` custom message (never the user's words), and follows the
 * session like a delegation until it finishes, fails or waits for the user.
 *
 * Nothing runs that the user did not allow:
 * - schedules an agent proposes (or changes) wait for the user's approval in
 *   that chat, like a delegation;
 * - a fire time the gateway slept through, or whose node was offline, is
 *   recorded as a `missed` run and only runs when the user allows it;
 * - a fire time while the previous run still goes is `skipped`.
 */
import { randomBytes } from 'node:crypto';
import { Cron } from 'croner';
import { redactSecrets } from '../agent/features/memory/redact.js';
import type { GatewayDatabase, SessionRow } from '../database.js';
import { ApiError } from '../errors.js';
import type { EventHub } from '../events.js';
import type { ModelStore } from '../models.js';
import type { GatewayEvent, Workspace } from '../types.js';
import { now } from '../util.js';
import type { NodeRegistry } from './nodes.js';
import {
  clip,
  deliver,
  isWatchedEvent,
  oneLine,
  readProgress,
  startSession,
  workspaceOnline,
} from './session-dispatch.js';

export type ScheduleStatus = 'active' | 'paused' | 'done';
export type RunStatus =
  | 'missed'
  | 'skipped'
  | 'dismissed'
  | 'running'
  | 'waiting_input'
  | 'completed'
  | 'failed';
type ProposalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
/** Which runs push a notification: every outcome, only the ones needing the user, or none. */
export const NOTIFY_LEVELS = ['all', 'problems', 'none'] as const;
export type NotifyLevel = (typeof NOTIFY_LEVELS)[number];

/** What a schedule does and when; everything the user approves. */
export interface ScheduleSpec {
  workspaceId: string;
  title: string;
  prompt: string;
  /** 5-field cron expression, or null for a one-shot. */
  cron: string | null;
  /** The one-shot's time (ms), or null for cron. */
  runAt: number | null;
  /** IANA time zone the cron expression (or a one-shot's wall time) is read in. */
  timezone: string;
  model: { provider: string; id: string } | null;
  thinking: string | null;
  notify: NotifyLevel;
}

export interface Schedule extends ScheduleSpec {
  id: string;
  ownerUser: string;
  status: ScheduleStatus;
  nextRunAt: number | null;
  /** The chat whose agent proposed it; null when the user made it. */
  createdBySession: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ScheduleRun {
  id: string;
  scheduleId: string;
  ownerUser: string;
  /** The fire time it belongs to (for a manual run, when it was asked for). */
  dueAt: number;
  status: RunStatus;
  sessionId: string | null;
  result: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  createdAt: number;
}

/** A change to a schedule, as the user, the UI or an agent writes it. */
export interface ScheduleInput {
  /** Workspace id (or, for agents, a directory workspace's unique name). */
  workspace?: string | undefined;
  title?: string | undefined;
  prompt?: string | undefined;
  cron?: string | undefined;
  /** One-shot time: ISO 8601; without an offset it is wall time in `timezone`. */
  at?: string | undefined;
  timezone?: string | undefined;
  model?: { provider: string; id: string } | null | undefined;
  thinking?: string | null | undefined;
  notify?: NotifyLevel | undefined;
}

export const PROMPT_MAX_CHARS = 20_000;
const TITLE_MAX_CHARS = 80;
/** Stored in full up to this sanity cap; readers page through it. */
const RESULT_MAX_CHARS = 200_000;
/** How much of each run's result the run list (UI) carries. */
const RESULT_VIEW_CHARS = 4000;
/** One `schedule` result read. */
export const RESULT_CHUNK_CHARS = 12_000;
const PENDING_MAX = 10;
const SCHEDULES_MAX = 100;
const RUNS_KEPT = 50;
/** A fire time the timer reaches later than this was slept through: missed, not run. */
const DEFAULT_GRACE_MS = 120_000;
/** Re-check at least this often, so a suspended machine or clock change is noticed. */
const MAX_SLEEP_MS = 3_600_000;
const OPEN_RUNS = "('running','waiting_input')";

const scheduleOf = (row: any): Schedule => ({
  id: row.id,
  ownerUser: row.owner_user,
  workspaceId: row.workspace_id,
  title: row.title,
  prompt: row.prompt,
  cron: row.cron ?? null,
  runAt: row.run_at ?? null,
  timezone: row.timezone,
  model: row.model_json ? JSON.parse(row.model_json) : null,
  thinking: row.thinking ?? null,
  notify: row.notify ?? 'all',
  status: row.status,
  nextRunAt: row.next_run_at ?? null,
  createdBySession: row.created_by_session ?? null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const runOf = (row: any): ScheduleRun => ({
  id: row.id,
  scheduleId: row.schedule_id,
  ownerUser: row.owner_user,
  dueAt: row.due_at,
  status: row.status,
  sessionId: row.session_id ?? null,
  result: row.result ?? null,
  startedAt: row.started_at ?? null,
  finishedAt: row.finished_at ?? null,
  createdAt: row.created_at,
});

function validTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** The next fire time strictly after `from`, or null when there is none. */
export function nextFire(spec: Pick<ScheduleSpec, 'cron' | 'runAt' | 'timezone'>, from: number) {
  if (spec.cron !== null)
    return (
      new Cron(spec.cron, { timezone: spec.timezone, paused: true })
        .nextRun(new Date(from))
        ?.getTime() ?? null
    );
  return spec.runAt !== null && spec.runAt > from ? spec.runAt : null;
}

/** A time for people: `2026-10-01 09:00 (Asia/Taipei)`. */
export function formatTime(at: number, timezone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(at))
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} (${timezone})`;
}

const invalid = (message: string) => new ApiError(400, 'invalid_input', message);

const runMessage = (schedule: Schedule, run: ScheduleRun) =>
  `Scheduled task “${schedule.title}” (schedule ${schedule.id}, due ${formatTime(run.dueAt, schedule.timezone)}), set up and approved by the user. Nobody is watching this session live:

${schedule.prompt}

Do it here. End with a short summary of what you did and anything that needs the user: they read it in the schedule's run history.`;

export interface ScheduleDeps {
  db: GatewayDatabase;
  events: EventHub;
  nodes: NodeRegistry;
  models: ModelStore;
  allowedUsers: ReadonlySet<string>;
  /** How long an agent's proposal waits for the user. */
  proposalTtlMs: number;
  /** The gateway's own time zone: the default for agents. */
  defaultTimezone: string;
  graceMs?: number;
  directoryChanged(): void;
  /** The user's schedules or runs changed: clients reload. */
  changed(user: string): void;
  /** A run finished, failed, was missed or waits for the user: push it (daemon/push.ts). */
  announce?(schedule: Schedule, run: ScheduleRun): void;
  warn(message: string, error?: unknown): void;
}

export class Schedules {
  private timer: NodeJS.Timeout | undefined;
  private readonly checks = new Map<string, NodeJS.Timeout>();
  private readonly sweeper: NodeJS.Timeout;
  private readonly unsubscribe: () => void;
  private closed = false;

  constructor(private readonly deps: ScheduleDeps) {
    this.unsubscribe = deps.events.subscribeAll((event) => this.onEvent(event));
    this.sweeper = setInterval(
      () => this.sweep(),
      Math.min(30_000, Math.max(50, deps.proposalTtlMs)),
    );
    this.sweeper.unref();
    this.sweep();
    this.tick();
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    clearInterval(this.sweeper);
    this.unsubscribe();
    for (const timer of this.checks.values()) clearTimeout(timer);
    this.checks.clear();
  }

  // ---------- reading ----------

  private row(id: string): Schedule | undefined {
    const row = this.deps.db.raw.prepare('SELECT * FROM schedules WHERE id=?').get(id);
    return row ? scheduleOf(row) : undefined;
  }

  private runRow(id: string): ScheduleRun | undefined {
    const row = this.deps.db.raw.prepare('SELECT * FROM schedule_runs WHERE id=?').get(id);
    return row ? runOf(row) : undefined;
  }

  get defaultTimezone(): string {
    return this.deps.defaultTimezone;
  }

  get(user: string, id: string): Schedule {
    const schedule = this.row(id);
    if (!schedule || schedule.ownerUser !== user)
      throw new ApiError(404, 'not_found', `No schedule ${id}`);
    return schedule;
  }

  list(user: string): Schedule[] {
    return (
      this.deps.db.raw
        .prepare('SELECT * FROM schedules WHERE owner_user=? ORDER BY created_at')
        .all(user) as any[]
    ).map(scheduleOf);
  }

  /** Newest first. */
  runs(user: string, scheduleId: string, limit = RUNS_KEPT): ScheduleRun[] {
    this.get(user, scheduleId);
    return (
      this.deps.db.raw
        .prepare(
          'SELECT * FROM schedule_runs WHERE schedule_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?',
        )
        .all(scheduleId, limit) as any[]
    ).map(runOf);
  }

  private lastRun(scheduleId: string): ScheduleRun | undefined {
    const row = this.deps.db.raw
      .prepare(
        'SELECT * FROM schedule_runs WHERE schedule_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1',
      )
      .get(scheduleId);
    return row ? runOf(row) : undefined;
  }

  /** A session a scheduled run started: its agent may not schedule more. */
  isRunSession(sessionId: string): boolean {
    return !!this.deps.db.raw
      .prepare('SELECT 1 FROM schedule_runs WHERE session_id=? LIMIT 1')
      .get(sessionId);
  }

  /** What clients show of a schedule. */
  view(schedule: Schedule) {
    const last = this.lastRun(schedule.id);
    const { n: attention } = this.deps.db.raw
      .prepare(
        "SELECT COUNT(*) AS n FROM schedule_runs WHERE schedule_id=? AND status IN ('missed','waiting_input')",
      )
      .get(schedule.id) as { n: number };
    return {
      ...schedule,
      workspace: this.workspaceView(schedule.workspaceId),
      lastRun: last ? this.runView(last) : null,
      /** Runs waiting for the user: missed ones to allow, and ones waiting for an answer. */
      attention,
    };
  }

  runView(run: ScheduleRun) {
    const long = run.result !== null && run.result.length > RESULT_VIEW_CHARS;
    return {
      ...run,
      ...(long
        ? { result: clip(run.result!, RESULT_VIEW_CHARS), resultChars: run.result!.length }
        : {}),
      session: run.sessionId ? this.sessionName(run.sessionId) : null,
    };
  }

  /** The user's run `id`, owner-checked. */
  getRun(user: string, id: string): ScheduleRun {
    const run = this.runRow(id);
    if (!run || run.ownerUser !== user) throw new ApiError(404, 'not_found', `No run ${id}`);
    return run;
  }

  /** A run's result from `offset`, in chunks, with `nextOffset` until the end. */
  runResult(run: ScheduleRun, offset = 0) {
    const result = run.result ?? '';
    if (offset > result.length)
      throw new ApiError(400, 'invalid_input', `offset exceeds result length ${result.length}`);
    const end = Math.min(result.length, offset + RESULT_CHUNK_CHARS);
    return {
      id: run.id,
      schedule: run.scheduleId,
      status: run.status,
      ...(run.sessionId ? { session: this.sessionName(run.sessionId) } : {}),
      result: result.slice(offset, end),
      resultOffset: offset,
      resultChars: result.length,
      ...(end < result.length ? { nextOffset: end } : {}),
    };
  }

  /** What an agent sees of a schedule. */
  brief(schedule: Schedule) {
    const last = this.lastRun(schedule.id);
    return {
      id: schedule.id,
      title: schedule.title,
      workspace: this.label(schedule.workspaceId),
      when: this.describeWhen(schedule),
      status: schedule.status,
      ...(schedule.nextRunAt !== null
        ? { nextRun: formatTime(schedule.nextRunAt, schedule.timezone) }
        : {}),
      ...(schedule.model ? { model: `${schedule.model.provider}/${schedule.model.id}` } : {}),
      ...(schedule.thinking ? { thinking: schedule.thinking } : {}),
      ...(schedule.notify !== 'all' ? { notify: schedule.notify } : {}),
      prompt: clip(schedule.prompt, 300),
      ...(last
        ? {
            lastRun: {
              id: last.id,
              status: last.status,
              due: formatTime(last.dueAt, schedule.timezone),
              ...(last.result ? { result: clip(last.result, 300) } : {}),
              ...(last.result && last.result.length > 300
                ? { resultChars: last.result.length }
                : {}),
            },
          }
        : {}),
    };
  }

  private describeWhen(spec: ScheduleSpec): string {
    return spec.cron !== null
      ? `cron "${spec.cron}" (${spec.timezone})`
      : `once at ${formatTime(spec.runAt!, spec.timezone)}`;
  }

  // ---------- validation ----------

  /**
   * The spec `input` makes of `base` (or a new one). Throws on anything that
   * would not run: a bad expression, time zone or model, a one-shot in the past.
   */
  private resolve(
    user: string,
    input: ScheduleInput,
    base: ScheduleSpec | undefined,
    options: { resolveWorkspace(ref: string): Workspace; redact: boolean },
  ): ScheduleSpec {
    const text = (value: string | undefined) => {
      if (value === undefined) return undefined;
      return (options.redact ? redactSecrets(value) : value).trim();
    };
    const prompt = text(input.prompt) ?? base?.prompt ?? '';
    if (!prompt) throw invalid('prompt is required');
    if (prompt.length > PROMPT_MAX_CHARS)
      throw new ApiError(
        413,
        'payload_too_large',
        `A prompt holds at most ${PROMPT_MAX_CHARS} characters`,
      );
    const timezone = input.timezone?.trim() || base?.timezone || this.deps.defaultTimezone;
    if (!validTimezone(timezone)) throw invalid(`Unknown time zone ${timezone}`);

    let workspaceId = base?.workspaceId;
    if (input.workspace?.trim()) {
      const workspace = options.resolveWorkspace(input.workspace.trim());
      workspaceId = workspace.id;
    }
    if (!workspaceId) throw invalid('workspace is required');
    if (!this.deps.allowedUsers.has(user)) throw new ApiError(403, 'forbidden', 'Not allowed');

    const cronInput = input.cron?.trim();
    const atInput = input.at?.trim();
    if (cronInput && atInput) throw invalid('Give either cron or at, not both');
    let cron = base?.cron ?? null;
    let runAt = base?.runAt ?? null;
    if (cronInput) {
      if (cronInput.split(/\s+/).length !== 5)
        throw invalid('cron needs 5 fields: minute hour day-of-month month day-of-week');
      cron = cronInput;
      runAt = null;
    } else if (atInput) {
      runAt = this.parseAt(atInput, timezone);
      cron = null;
    } else if (runAt !== null && input.timezone && base && input.timezone !== base.timezone)
      throw invalid('Changing the time zone of a one-shot needs its time (at) again');
    if (cron === null && runAt === null) throw invalid('Give cron (repeating) or at (once)');
    if (cron !== null) {
      try {
        if (nextFire({ cron, runAt: null, timezone }, now()) === null)
          throw invalid(`cron "${cron}" never fires`);
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw invalid(`Invalid cron "${cron}": ${(error as Error).message}`);
      }
    } else if (runAt! <= now()) throw invalid(`${formatTime(runAt!, timezone)} is in the past`);

    const model = input.model === undefined ? (base?.model ?? null) : input.model;
    if (
      model &&
      !this.deps.models.current.providers[model.provider]?.models.some((m) => m.id === model.id)
    )
      throw invalid(`Unknown model ${model.provider}/${model.id}`);
    const thinking = input.thinking === undefined ? (base?.thinking ?? null) : input.thinking;
    if (thinking !== null && !(THINKING_LEVELS as readonly string[]).includes(thinking))
      throw invalid(`thinking is one of ${THINKING_LEVELS.join(', ')}`);

    const title = clip(
      oneLine(text(input.title) || base?.title || prompt.split('\n', 1)[0]!),
      TITLE_MAX_CHARS,
    );
    const notify = input.notify ?? base?.notify ?? 'all';
    if (!(NOTIFY_LEVELS as readonly string[]).includes(notify))
      throw invalid(`notify is one of ${NOTIFY_LEVELS.join(', ')}`);
    return { workspaceId, title, prompt, cron, runAt, timezone, model, thinking, notify };
  }

  private parseAt(at: string, timezone: string): number {
    try {
      const time = new Cron(at, { timezone, paused: true }).nextRun(new Date(0))?.getTime();
      if (time === undefined || Number.isNaN(time)) throw new Error('no time');
      return time;
    } catch {
      throw invalid(`at must be an ISO 8601 time like 2026-10-01T09:00, not ${at}`);
    }
  }

  // ---------- changing schedules ----------

  /** The user makes or changes a schedule directly (web, Android, slash command). */
  create(
    user: string,
    input: ScheduleInput,
    resolveWorkspace: (ref: string) => Workspace,
    createdBySession: string | null = null,
  ): Schedule {
    const count = (
      this.deps.db.raw
        .prepare('SELECT COUNT(*) AS n FROM schedules WHERE owner_user=?')
        .get(user) as { n: number }
    ).n;
    if (count >= SCHEDULES_MAX)
      throw new ApiError(429, 'too_many_requests', `At most ${SCHEDULES_MAX} schedules`);
    const spec = this.resolve(user, input, undefined, { resolveWorkspace, redact: false });
    // A chat project with schedules disabled runs none, whoever creates them.
    this.deps.db.requireWorkspaceCapability(spec.workspaceId, 'schedules');
    return this.insert(user, spec, createdBySession);
  }

  update(
    user: string,
    id: string,
    input: ScheduleInput,
    resolveWorkspace: (ref: string) => Workspace,
  ): Schedule {
    const schedule = this.get(user, id);
    const spec = this.resolve(user, input, schedule, { resolveWorkspace, redact: false });
    this.deps.db.requireWorkspaceCapability(spec.workspaceId, 'schedules');
    return this.apply(schedule, spec);
  }

  pause(user: string, id: string): Schedule {
    const schedule = this.get(user, id);
    if (schedule.status === 'active') this.setStatus(schedule, 'paused', schedule.nextRunAt);
    return this.row(id)!;
  }

  /** Runs again from now on; fire times while paused are not made up. */
  resume(user: string, id: string): Schedule {
    const schedule = this.get(user, id);
    if (schedule.status === 'active') return schedule;
    this.requireCapability(schedule);
    const next = nextFire(schedule, now());
    if (next === null)
      throw new ApiError(
        409,
        'conflict',
        'Its one-shot time has passed: give it a new time (at) instead',
      );
    this.setStatus(schedule, 'active', next);
    return this.row(id)!;
  }

  /** Deletes the schedule and its history; sessions it started stay. */
  delete(user: string, id: string): void {
    const schedule = this.get(user, id);
    const { raw } = this.deps.db;
    raw.transaction(() => {
      raw.prepare('DELETE FROM schedule_runs WHERE schedule_id=?').run(id);
      raw.prepare('DELETE FROM schedules WHERE id=?').run(id);
    })();
    for (const proposal of this.proposalRows("schedule_id=? AND status='pending'", id))
      this.closeProposal(proposal, 'expired');
    this.changed(schedule.ownerUser);
  }

  private insert(user: string, spec: ScheduleSpec, createdBySession: string | null): Schedule {
    const id = this.newId('schedules', 's');
    const at = now();
    this.deps.db.raw
      .prepare(
        "INSERT INTO schedules (id,owner_user,workspace_id,title,prompt,cron,run_at,timezone,model_json,thinking,notify,status,next_run_at,created_by_session,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,'active',?,?,?,?)",
      )
      .run(
        id,
        user,
        spec.workspaceId,
        spec.title,
        spec.prompt,
        spec.cron,
        spec.runAt,
        spec.timezone,
        spec.model ? JSON.stringify(spec.model) : null,
        spec.thinking,
        spec.notify,
        nextFire(spec, at),
        createdBySession,
        at,
        at,
      );
    this.changed(user);
    return this.row(id)!;
  }

  private apply(schedule: Schedule, spec: ScheduleSpec): Schedule {
    // A new one-shot time makes a finished one-shot active again.
    const status: ScheduleStatus = schedule.status === 'done' ? 'active' : schedule.status;
    this.deps.db.raw
      .prepare(
        'UPDATE schedules SET workspace_id=?,title=?,prompt=?,cron=?,run_at=?,timezone=?,model_json=?,thinking=?,notify=?,status=?,next_run_at=?,updated_at=? WHERE id=?',
      )
      .run(
        spec.workspaceId,
        spec.title,
        spec.prompt,
        spec.cron,
        spec.runAt,
        spec.timezone,
        spec.model ? JSON.stringify(spec.model) : null,
        spec.thinking,
        spec.notify,
        status,
        nextFire(spec, now()),
        now(),
        schedule.id,
      );
    this.changed(schedule.ownerUser);
    return this.row(schedule.id)!;
  }

  private setStatus(schedule: Schedule, status: ScheduleStatus, nextRunAt: number | null): void {
    this.deps.db.raw
      .prepare('UPDATE schedules SET status=?, next_run_at=?, updated_at=? WHERE id=?')
      .run(status, nextRunAt, now(), schedule.id);
    this.changed(schedule.ownerUser);
  }

  private changed(user: string): void {
    this.deps.changed(user);
    this.arm();
  }

  // ---------- an agent's proposals ----------

  /**
   * An agent proposes a schedule (or a change to `scheduleId`); the user
   * approves it in `session`'s chat. Validated now, so the agent hears of
   * mistakes at once; nothing changes before the user says yes.
   */
  propose(
    user: string,
    session: SessionRow,
    input: ScheduleInput,
    resolveWorkspace: (ref: string) => Workspace,
    scheduleId?: string,
  ): { proposalId: string; spec: ScheduleSpec; scheduleId: string | null } {
    const base = scheduleId ? this.get(user, scheduleId) : undefined;
    const spec = this.resolve(user, input, base, { resolveWorkspace, redact: true });
    const waiting = this.proposalRows("owner_user=? AND status='pending'", user).length;
    if (waiting >= PENDING_MAX)
      throw new ApiError(
        429,
        'too_many_requests',
        `${waiting} schedule proposals already wait for the user's approval`,
      );
    const id = this.newId('schedule_proposals', 'p');
    const at = now();
    this.deps.db.raw
      .prepare(
        "INSERT INTO schedule_proposals (id,owner_user,session_id,schedule_id,spec_json,status,expires_at,created_at) VALUES (?,?,?,?,?,'pending',?,?)",
      )
      .run(
        id,
        user,
        session.id,
        scheduleId ?? null,
        JSON.stringify(spec),
        at + this.deps.proposalTtlMs,
        at,
      );
    const proposal = this.proposalRows('id=?', id)[0]!;
    this.deps.events.publish(
      session.id,
      session.runnerEpoch,
      'interaction_created',
      this.interactionOf(proposal),
    );
    return { proposalId: id, spec, scheduleId: scheduleId ?? null };
  }

  /** Confirmations waiting in a chat, shaped like a node's interactions. */
  pendingInteractions(sessionId: string) {
    return this.proposalRows(
      "session_id=? AND status='pending' AND expires_at>?",
      sessionId,
      now(),
    ).map((proposal) => this.interactionOf(proposal));
  }

  /**
   * The user answered a confirmation in chat `sessionId`. Undefined when
   * `interactionId` is not one of this chat's proposals.
   */
  answer(
    sessionId: string,
    interactionId: string,
    user: string,
    answer: unknown,
  ): { interactionId: string; status: 'answered'; scheduleId?: string } | undefined {
    const proposal = this.proposalRows('id=?', interactionId)[0];
    if (!proposal || proposal.sessionId !== sessionId) return undefined;
    if (proposal.ownerUser !== user)
      throw new ApiError(403, 'forbidden', 'Schedule belongs to another user');
    if (proposal.status !== 'pending' || proposal.expiresAt <= now())
      throw new ApiError(409, 'stale_interaction', 'This schedule can no longer be answered');
    const approved = (answer as { confirmed?: unknown } | undefined)?.confirmed === true;
    if (!approved) {
      this.closeProposal(proposal, 'rejected');
      return { interactionId, status: 'answered' };
    }
    this.deps.db.requireSessionCapability(sessionId, 'schedules');
    let schedule: Schedule;
    try {
      if (proposal.scheduleId) {
        const current = this.get(user, proposal.scheduleId);
        schedule = this.apply(current, this.recheck(user, proposal.spec, current));
      } else {
        schedule = this.insert(user, this.recheck(user, proposal.spec), sessionId);
      }
    } catch (error) {
      this.closeProposal(proposal, 'rejected');
      throw error instanceof ApiError
        ? new ApiError(409, 'conflict', `Could not save the schedule: ${error.message}`)
        : error;
    }
    this.closeProposal(proposal, 'approved');
    return { interactionId, status: 'answered', scheduleId: schedule.id };
  }

  /** The approved spec still holds (a one-shot may have passed while it waited). */
  private recheck(user: string, spec: ScheduleSpec, base?: Schedule): ScheduleSpec {
    return this.resolve(
      user,
      {},
      { ...(base ?? {}), ...spec },
      { resolveWorkspace: () => this.deps.db.getWorkspace(spec.workspaceId), redact: false },
    );
  }

  private sweep(): void {
    for (const proposal of this.proposalRows("status='pending' AND expires_at<=?", now()))
      this.closeProposal(proposal, 'expired');
  }

  private closeProposal(proposal: Proposal, status: ProposalStatus): void {
    const changed = this.deps.db.raw
      .prepare("UPDATE schedule_proposals SET status=? WHERE id=? AND status='pending'")
      .run(status, proposal.id).changes;
    if (!changed) return;
    try {
      const chat = this.deps.db.getSession(proposal.sessionId);
      this.deps.events.publish(chat.id, chat.runnerEpoch, 'interaction_answered', {
        interactionId: proposal.id,
      });
    } catch {
      /* the chat is gone */
    }
  }

  private proposalRows(where: string, ...values: Array<string | number>): Proposal[] {
    return (
      this.deps.db.raw
        .prepare(`SELECT * FROM schedule_proposals WHERE ${where} ORDER BY created_at`)
        .all(...values) as any[]
    ).map((row) => ({
      id: row.id,
      ownerUser: row.owner_user,
      sessionId: row.session_id,
      scheduleId: row.schedule_id ?? null,
      spec: JSON.parse(row.spec_json),
      status: row.status,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    }));
  }

  private interactionOf(proposal: Proposal) {
    const { spec } = proposal;
    const current = proposal.scheduleId ? this.row(proposal.scheduleId) : undefined;
    const next = nextFire(spec, now());
    const lines = [
      spec.title,
      '',
      `Where: ${this.label(spec.workspaceId)} (a new session each run)`,
      `When: ${this.describeWhen(spec)}${next !== null ? `; next ${formatTime(next, spec.timezone)}` : ''}`,
      ...(spec.model || spec.thinking
        ? [
            `Model: ${spec.model ? `${spec.model.provider}/${spec.model.id}` : 'default'}${spec.thinking ? `, thinking ${spec.thinking}` : ''}`,
          ]
        : []),
      ...(spec.notify !== 'all'
        ? [`Notifications: ${spec.notify === 'none' ? 'none' : 'only when it needs you'}`]
        : []),
      '',
      spec.prompt,
    ];
    return {
      id: proposal.id,
      rpcId: proposal.id,
      sessionId: proposal.sessionId,
      runnerEpoch: 0,
      kind: 'confirm',
      status: 'pending',
      request: {
        method: 'confirm',
        title: current ? `Change the schedule “${current.title}”?` : 'Schedule this task?',
        message: lines.join('\n'),
        confirmLabel: current ? 'Save' : 'Schedule',
        cancelLabel: "Don't",
      },
      expiresAt: proposal.expiresAt,
      createdAt: proposal.createdAt,
    };
  }

  // ---------- the timer ----------

  private arm(): void {
    if (this.closed) return;
    clearTimeout(this.timer);
    const row = this.deps.db.raw
      .prepare(
        "SELECT MIN(next_run_at) AS due FROM schedules WHERE status='active' AND next_run_at IS NOT NULL",
      )
      .get() as { due: number | null };
    if (row.due === null) return;
    const delay = Math.min(MAX_SLEEP_MS, Math.max(0, row.due - now()));
    this.timer = setTimeout(() => this.tick(), delay);
    this.timer.unref();
  }

  /** Handle every schedule that is due now. Public so tests can drive the clock. */
  tick(): void {
    if (this.closed) return;
    const at = now();
    const grace = this.deps.graceMs ?? DEFAULT_GRACE_MS;
    const due = (
      this.deps.db.raw
        .prepare(
          "SELECT * FROM schedules WHERE status='active' AND next_run_at IS NOT NULL AND next_run_at<=? ORDER BY next_run_at",
        )
        .all(at) as any[]
    ).map(scheduleOf);
    for (const schedule of due) {
      try {
        this.fall(schedule, at, grace);
      } catch (error) {
        this.deps.warn(`schedule ${schedule.id}: could not handle its fire time`, error);
      }
    }
    this.arm();
  }

  private fall(schedule: Schedule, at: number, grace: number): void {
    const dueAt = schedule.nextRunAt!;
    // The latest fire time that has passed: several slept through count once.
    let latest = dueAt;
    for (
      let i = 0, next = nextFire(schedule, dueAt);
      next !== null && next <= at && i < 10_000;
      i++
    ) {
      latest = next;
      next = nextFire(schedule, next);
    }
    const next = nextFire(schedule, at);
    this.deps.db.raw
      .prepare('UPDATE schedules SET next_run_at=?, status=?, updated_at=? WHERE id=?')
      .run(next, next === null ? 'done' : 'active', at, schedule.id);

    let workspace: Workspace | undefined;
    try {
      workspace = this.deps.db.getWorkspace(schedule.workspaceId);
    } catch {
      /* removed */
    }
    if (!this.deps.allowedUsers.has(schedule.ownerUser) || !workspace) {
      this.insertRun(schedule, latest, 'failed', {
        result: workspace
          ? 'Its owner may no longer use the gateway; the schedule is paused.'
          : 'Its workspace no longer exists; the schedule is paused.',
        finishedAt: at,
      });
      this.setStatus(schedule, 'paused', next);
      return;
    }
    if (at - latest > grace) {
      this.insertRun(schedule, latest, 'missed', {
        result: 'The gateway was not running at this time. Allow the run to start it now.',
      });
      this.deps.changed(schedule.ownerUser);
      return;
    }
    this.start(schedule, latest, undefined, false);
  }

  // ---------- runs ----------

  /**
   * The user runs a schedule now, or allows one of its missed runs
   * (`missedRunId`). Unlike a timed run it fails loudly: the node is offline,
   * or the previous run still goes.
   */
  runNow(user: string, id: string, missedRunId?: string): ScheduleRun {
    const schedule = this.get(user, id);
    if (missedRunId) {
      const missed = this.runRow(missedRunId);
      if (!missed || missed.scheduleId !== id || missed.status !== 'missed')
        throw new ApiError(404, 'not_found', `No missed run ${missedRunId} of schedule ${id}`);
    }
    return this.start(
      schedule,
      missedRunId ? this.runRow(missedRunId)!.dueAt : now(),
      missedRunId,
      true,
    );
  }

  /** The user lets a missed run go. */
  dismiss(user: string, id: string, runId: string): ScheduleRun {
    this.get(user, id);
    const changed = this.deps.db.raw
      .prepare(
        "UPDATE schedule_runs SET status='dismissed', finished_at=? WHERE id=? AND schedule_id=? AND status='missed'",
      )
      .run(now(), runId, id).changes;
    if (!changed) throw new ApiError(404, 'not_found', `No missed run ${runId} of schedule ${id}`);
    this.deps.changed(user);
    return this.runRow(runId)!;
  }

  private requireCapability(schedule: Schedule): void {
    this.deps.db.requireWorkspaceCapability(schedule.workspaceId, 'schedules');
    if (schedule.createdBySession)
      this.deps.db.requireSessionCapability(schedule.createdBySession, 'schedules');
  }

  private start(
    schedule: Schedule,
    dueAt: number,
    existingRunId: string | undefined,
    manual: boolean,
  ): ScheduleRun {
    try {
      this.requireCapability(schedule);
    } catch (error) {
      if (manual) throw error;
      const run = this.insertRun(schedule, dueAt, 'failed', {
        result: (error as Error).message,
        finishedAt: now(),
      });
      this.setStatus(schedule, 'paused', schedule.nextRunAt);
      this.deps.changed(schedule.ownerUser);
      return run;
    }
    const open = this.deps.db.raw
      .prepare(
        `SELECT id FROM schedule_runs WHERE schedule_id=? AND status IN ${OPEN_RUNS} LIMIT 1`,
      )
      .get(schedule.id) as { id: string } | undefined;
    const workspace = this.deps.db.getWorkspace(schedule.workspaceId);
    const online = workspaceOnline(this.deps.nodes, workspace);
    if (manual && open) throw new ApiError(409, 'conflict', `Its run ${open.id} is still going`);
    if (manual && !online)
      throw new ApiError(503, 'node_offline', `${workspace.hostId} is offline`);
    if (open) {
      const run = this.insertRun(schedule, dueAt, 'skipped', {
        result: `The previous run (${open.id}) was still going.`,
        finishedAt: now(),
      });
      this.deps.changed(schedule.ownerUser);
      return run;
    }
    if (!online) {
      const run = this.insertRun(schedule, dueAt, 'missed', {
        result: `${workspace.hostId} was offline. Allow the run to start it now.`,
      });
      this.deps.changed(schedule.ownerUser);
      return run;
    }
    let run: ScheduleRun;
    if (existingRunId) {
      this.deps.db.raw
        .prepare(
          "UPDATE schedule_runs SET status='running', result=NULL, started_at=? WHERE id=? AND status='missed'",
        )
        .run(now(), existingRunId);
      run = this.runRow(existingRunId)!;
    } else run = this.insertRun(schedule, dueAt, 'running', { startedAt: now() });
    this.deps.changed(schedule.ownerUser);
    void this.dispatch(schedule, run, workspace);
    return run;
  }

  private async dispatch(schedule: Schedule, run: ScheduleRun, workspace: Workspace) {
    try {
      this.requireCapability(schedule);
      const session = await startSession(this.deps, workspace, schedule.ownerUser, schedule.title);
      this.deps.db.raw
        .prepare('UPDATE schedule_runs SET session_id=? WHERE id=?')
        .run(session.id, run.id);
      this.requireCapability(schedule);
      await deliver(this.deps.nodes, session, schedule.ownerUser, {
        customType: 'scheduled-run',
        content: runMessage(schedule, run),
        details: { scheduleId: schedule.id, runId: run.id, title: schedule.title },
        ...(schedule.model ? { model: schedule.model } : {}),
        ...(schedule.thinking ? { thinking: schedule.thinking } : {}),
      });
      this.deps.changed(schedule.ownerUser);
    } catch (error) {
      this.finish(run.id, 'failed', `Could not start the run: ${(error as Error).message}`);
    }
  }

  private onEvent(event: GatewayEvent): void {
    if (!isWatchedEvent(event)) return;
    const open = this.deps.db.raw
      .prepare(`SELECT id FROM schedule_runs WHERE session_id=? AND status IN ${OPEN_RUNS}`)
      .all(event.sessionId) as Array<{ id: string }>;
    for (const { id } of open) this.scheduleCheck(id);
  }

  private scheduleCheck(id: string): void {
    if (this.closed || this.checks.has(id)) return;
    const timer = setTimeout(() => {
      this.checks.delete(id);
      this.check(id).catch((error) => this.deps.warn(`scheduled run ${id}: check failed`, error));
    }, 150);
    timer.unref();
    this.checks.set(id, timer);
  }

  private async check(id: string): Promise<void> {
    const run = this.runRow(id);
    if (!run || !['running', 'waiting_input'].includes(run.status) || !run.sessionId) return;
    const progress = await readProgress(
      this.deps.nodes,
      this.deps.db.getSession(run.sessionId),
      run.ownerUser,
      run.startedAt ?? run.createdAt,
      (message) => message.details?.runId === run.id,
    );
    switch (progress.state) {
      case 'dropped':
        return this.finish(id, 'failed', 'The agent stopped before it took the task');
      case 'waiting':
        if (run.status !== 'waiting_input') this.setRunStatus(run, 'waiting_input');
        return;
      case 'working':
        if (run.status === 'waiting_input') this.setRunStatus(run, 'running');
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

  private setRunStatus(run: ScheduleRun, status: RunStatus): void {
    // A progress snapshot can arrive after deletion has settled this run.
    const changed = this.deps.db.raw
      .prepare('UPDATE schedule_runs SET status=? WHERE id=? AND session_id=? AND status=?')
      .run(status, run.id, run.sessionId, run.status).changes;
    if (!changed) return;
    this.deps.changed(run.ownerUser);
    this.announce(run.id);
  }

  /** Push what the user asked to hear about (the schedule's `notify`). */
  private announce(runId: string): void {
    const run = this.runRow(runId);
    const schedule = run && this.row(run.scheduleId);
    if (!run || !schedule || !this.deps.announce || schedule.notify === 'none') return;
    const problem = ['failed', 'waiting_input', 'missed'].includes(run.status);
    if (!problem && !(run.status === 'completed' && schedule.notify === 'all')) return;
    try {
      this.deps.announce(schedule, run);
    } catch (error) {
      this.deps.warn(`scheduled run ${run.id}: could not push`, error);
    }
  }

  private finish(id: string, status: 'completed' | 'failed', result: string): void {
    const run = this.runRow(id);
    const changed = this.deps.db.raw
      .prepare(
        `UPDATE schedule_runs SET status=?, result=?, finished_at=? WHERE id=? AND status IN ${OPEN_RUNS}`,
      )
      .run(status, clip(redactSecrets(result), RESULT_MAX_CHARS), now(), id).changes;
    if (changed && run) {
      this.deps.changed(run.ownerUser);
      this.announce(id);
    }
  }

  private insertRun(
    schedule: Schedule,
    dueAt: number,
    status: RunStatus,
    extra: { result?: string; startedAt?: number; finishedAt?: number },
  ): ScheduleRun {
    const id = this.newId('schedule_runs', 'r');
    const { raw } = this.deps.db;
    raw
      .prepare(
        'INSERT INTO schedule_runs (id,schedule_id,owner_user,due_at,status,result,started_at,finished_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      )
      .run(
        id,
        schedule.id,
        schedule.ownerUser,
        dueAt,
        status,
        extra.result ?? null,
        extra.startedAt ?? null,
        extra.finishedAt ?? null,
        now(),
      );
    // Keep the newest runs; open and missed ones stay until they are handled.
    raw
      .prepare(
        `DELETE FROM schedule_runs WHERE schedule_id=? AND status NOT IN ('running','waiting_input','missed') AND id NOT IN (SELECT id FROM schedule_runs WHERE schedule_id=? ORDER BY created_at DESC, rowid DESC LIMIT ${RUNS_KEPT})`,
      )
      .run(schedule.id, schedule.id);
    if (status === 'missed' || status === 'failed') this.announce(id);
    return this.runRow(id)!;
  }

  // ---------- helpers ----------

  private workspaceView(workspaceId: string) {
    try {
      const workspace = this.deps.db.getWorkspace(workspaceId);
      return {
        id: workspace.id,
        name: workspace.displayName,
        kind: workspace.kind,
        node: workspace.hostId,
        online: workspaceOnline(this.deps.nodes, workspace),
      };
    } catch {
      return { id: workspaceId, name: workspaceId, kind: null, node: null, online: false };
    }
  }

  private label(workspaceId: string): string {
    try {
      const workspace = this.deps.db.getWorkspace(workspaceId);
      return `${workspace.displayName} on ${workspace.hostId}`;
    } catch {
      return workspaceId;
    }
  }

  private sessionName(sessionId: string): string | null {
    try {
      return this.deps.db.getSession(sessionId).name;
    } catch {
      return null;
    }
  }

  private newId(table: string, prefix: string): string {
    const exists = this.deps.db.raw.prepare(`SELECT 1 FROM ${table} WHERE id=?`);
    for (;;) {
      const id = `${prefix}${randomBytes(4).toString('hex')}`;
      if (!exists.get(id)) return id;
    }
  }
}

interface Proposal {
  id: string;
  ownerUser: string;
  sessionId: string;
  scheduleId: string | null;
  spec: ScheduleSpec;
  status: ProposalStatus;
  expiresAt: number;
  createdAt: number;
}
