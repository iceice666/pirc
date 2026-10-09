import type { GatewaySessionAuthority } from './authority.js';
import type { WriterLease } from './contracts.js';
import { emptyReducedState, reducePiEvent, type ReducedSessionState } from '../node/reducer.js';
import type { RuntimeEvent } from './runtime.js';
import type { ExecutionEvent } from '../environment/protocol.js';
import { canonicalJson, parseJson } from '../environment/json.js';
import { ENTRY_BYTES } from './contracts.js';
import { panel as todoPanel } from '../agent/features/todo/index.js';
import { parseState } from '../agent/features/todo/model.js';
import { goalWidget, GOAL_WIDGET } from '../agent/features/goal/index.js';
import { parseGoal } from '../agent/features/goal/model.js';

/** Shared Web/Android wire projection. State and cursor commit on the authority connection.
 * Only trusted runtime and authorized Environment events may enter this projector.
 */
export class GatewayClientProjection {
  private readonly db;
  constructor(private readonly authority: GatewaySessionAuthority) {
    this.db = authority.inner.operations.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS runtime_client_state (
      session TEXT NOT NULL, branch TEXT NOT NULL, state TEXT NOT NULL,
      PRIMARY KEY(session,branch));
      CREATE TABLE IF NOT EXISTS runtime_client_receipts (
      session TEXT NOT NULL, branch TEXT NOT NULL, source TEXT NOT NULL, seq INTEGER NOT NULL,
      payload TEXT NOT NULL, PRIMARY KEY(session,branch,source,seq));`);
  }
  private state(lease: WriterLease): ReducedSessionState {
    const row = this.db
      .query('SELECT state FROM runtime_client_state WHERE session=? AND branch=?')
      .get(lease.binding.sessionId, lease.branchId) as { state: string } | null;
    return row
      ? (parseJson(row.state, ENTRY_BYTES) as unknown as ReducedSessionState)
      : emptyReducedState();
  }
  private commit(lease: WriterLease, source: string, seq: number, value: Record<string, unknown>) {
    if (!Number.isSafeInteger(seq) || seq < 1) throw new Error('Invalid client event sequence');
    this.db
      .transaction(() => {
        this.authority.assertWriter(lease);
        const encoded = canonicalJson(value, ENTRY_BYTES);
        const old = this.db
          .query(
            'SELECT payload FROM runtime_client_receipts WHERE session=? AND branch=? AND source=? AND seq=?',
          )
          .get(lease.binding.sessionId, lease.branchId, source, seq) as { payload: string } | null;
        if (old) {
          if (old.payload !== encoded) throw new Error('Client event identity conflict');
          return;
        }
        const latest = this.db
          .query(
            'SELECT MAX(seq) AS seq FROM runtime_client_receipts WHERE session=? AND branch=? AND source=?',
          )
          .get(lease.binding.sessionId, lease.branchId, source) as { seq: number | null };
        if (latest.seq !== null && seq <= latest.seq)
          throw new Error('Stale client event sequence');
        const state = this.state(lease);
        reducePiEvent(state, value);
        // Transcript owns completed messages. Do not duplicate images/history in mutable state.
        state.history = [];
        if (
          value.type === 'agent_start' ||
          value.type === 'agent_settled' ||
          value.type === 'agent_end'
        ) {
          state.partialMessage = null;
          state.operations = [];
          state.queue = { steering: [], followUp: [] };
        }
        this.db
          .query('INSERT OR REPLACE INTO runtime_client_state VALUES (?,?,?)')
          .run(lease.binding.sessionId, lease.branchId, canonicalJson(state, ENTRY_BYTES));
        this.db
          .query('INSERT INTO runtime_client_receipts VALUES (?,?,?,?,?)')
          .run(lease.binding.sessionId, lease.branchId, source, seq, encoded);
        let wire: unknown = { type: 'pi_event', data: value };
        if (Buffer.byteLength(canonicalJson(wire, ENTRY_BYTES)) > 60000)
          wire = { type: 'reset', reason: 'cursor_expired' };
        this.authority.publishClientEvent(lease, wire);
      })
      .immediate();
  }
  runtime(lease: WriterLease, event: RuntimeEvent) {
    if (event.sessionId !== lease.binding.sessionId)
      throw new Error('Client event binding mismatch');
    this.commit(lease, `runtime:${event.callId}`, event.seq, event);
  }
  environment(event: ExecutionEvent): void {
    const intent = this.authority.executionIntent(event.binding, event.executionId),
      owner = this.authority.sessionOwner(event.binding.sessionId),
      branchId = this.authority.executionBranch(intent),
      lease = { binding: intent.binding, branchId };
    this.authority.assertOwner(event.binding.sessionId, owner);
    const parentToolCallId = this.authority.modelToolId(event.binding, event.executionId);
    const payload = event.payload as Record<string, unknown>;
    if (!payload || typeof payload !== 'object') return;
    if (event.kind === 'operation') {
      this.operation(lease, event.executionId, payload, event.seq);
      return;
    }
    if (event.kind !== 'progress') return;
    // Node progress text cannot supply a different operation identity or parent.
    this.commit(lease, `environment:${event.executionId}`, event.seq, {
      type: 'tool_execution_update',
      toolCallId: parentToolCallId,
      toolName: intent.capability,
      partialResult: payload,
    });
  }
  operation(lease: WriterLease, executionId: string, event: Record<string, unknown>, seq: number) {
    const intent = this.authority.executionIntent(lease.binding, executionId);
    if (this.authority.executionBranch(intent) !== lease.branchId || intent.capability !== 'ptc')
      throw new Error('Client operation parent mismatch');
    const id = event.toolCallId;
    const suffix = typeof id === 'string' ? id.slice(executionId.length + 1) : '';
    if (
      typeof id !== 'string' ||
      !/^op[1-9][0-9]{0,2}$/.test(suffix) ||
      Number(suffix.slice(2)) > 200 ||
      !id.startsWith(`${executionId}:`)
    )
      throw new Error('Client operation identity mismatch');
    if (
      !['tool_execution_start', 'tool_execution_end'].includes(String(event.type)) ||
      !this.authority
        .executionDescriptor(intent)
        .capabilityCatalog.some((cap) => cap.name === event.toolName)
    )
      throw new Error('Invalid client operation projection');
    this.commit(lease, `ptc:${executionId}`, seq, {
      ...event,
      parentToolCallId: this.authority.modelToolId(lease.binding, executionId),
    });
  }
  snapshot(lease: WriterLease, owner: string) {
    this.authority.assertOwner(lease.binding.sessionId, owner);
    if (
      !this.db
        .query('SELECT id FROM runtime_branches WHERE id=? AND session=?')
        .get(lease.branchId, lease.binding.sessionId)
    )
      throw new Error('Invalid branch');
    return this.state(lease);
  }
  events(
    lease: WriterLease,
    owner: string,
    after = 0,
  ): Array<
    Record<string, unknown> & {
      sessionId: string;
      epoch: string;
      sequence: number;
      timestamp: number;
    }
  > {
    return this.authority
      .events(lease.binding.sessionId, owner, after, lease.branchId)
      .map(({ seq, event }) => ({
        sessionId: lease.binding.sessionId,
        epoch: lease.binding.writerEpoch,
        sequence: seq,
        timestamp: Date.now(),
        ...(event && typeof event === 'object' && 'type' in event && event.type === 'client.event'
          ? (event as { event: Record<string, unknown> }).event
          : { type: 'reset', reason: 'cursor_expired' }),
      }));
  }
}

/** Snapshot compatibility projection. It never substitutes historical admission sandbox
 * status for live environment health, nor conceals that older history is paginated.
 */
export function runtimeClientSnapshot(options: {
  authority: GatewaySessionAuthority;
  lease: WriterLease;
  owner: string;
  running: boolean;
  live?: ReducedSessionState;
  goalArmed?: boolean;
  sandbox?: { active: boolean; reason?: string };
}) {
  const { authority, lease, owner } = options;
  authority.assertOwner(lease.binding.sessionId, owner);
  const settings = authority.settings(lease.binding.sessionId, owner, lease.branchId),
    run = authority.latestRun(lease.binding.sessionId, owner, lease.branchId);
  const status =
    run?.state === 'completed'
      ? 'succeeded'
      : run?.state === 'running'
        ? 'running'
        : run?.state === 'failed'
          ? 'failed'
          : run
            ? 'interrupted'
            : undefined;
  const updatedAt = Date.now();
  const feature = (name: string) => {
    const entry = authority
      .customEntries(
        lease.binding.sessionId,
        owner,
        lease.branchId,
        `runtime.feature.${name}`,
        1,
        true,
      )
      .at(-1);
    return entry?.type === 'custom' ? entry.data : undefined;
  };
  const widgets = { ...options.live?.widgets },
    todo = parseState(feature('todo')),
    goal = parseGoal(feature('goal'));
  delete widgets['local-todo'];
  delete widgets[GOAL_WIDGET];
  if (todo?.todos.length) widgets['local-todo'] = todoPanel(todo);
  if (goal) widgets[GOAL_WIDGET] = goalWidget(goal, options.goalArmed ?? false);
  return {
    authority: 'gateway',
    session: {
      id: lease.binding.sessionId,
      workspaceId: lease.binding.workspaceId,
      name: settings.title ?? 'New session',
      runnerState: options.running ? 'running' : 'stopped',
      runStatus: status,
      updatedAt,
    },
    run: run ? { id: run.id, status, failureReason: run.reason } : null,
    ...authority.recentHistory(lease.binding.sessionId, owner, lease.branchId),
    operations: options.running ? (options.live?.operations ?? []) : [],
    partialMessage: options.running ? (options.live?.partialMessage ?? null) : null,
    interactions: [],
    queue: options.running
      ? (options.live?.queue ?? { steering: [], followUp: [] })
      : { steering: [], followUp: [] },
    notifications: options.live?.notifications ?? [],
    widgets,
    statuses: options.live?.statuses ?? {},
    watermark: {
      epoch: lease.binding.writerEpoch,
      sequence: authority.watermark(lease.binding.sessionId, owner, lease.branchId),
    },
    agent: { model: settings.model, thinkingLevel: settings.thinking },
    ...(options.sandbox ? { sandbox: options.sandbox } : {}),
    runtime: { location: 'gateway', environmentNodeId: lease.binding.nodeId },
  };
}
