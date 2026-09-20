import Database from 'better-sqlite3';
import type { GatewayConfig } from './config.js';
import { ApiError } from './errors.js';
import type {
  CommandStatus,
  InteractionStatus,
  RunStatus,
  SessionSummary,
  Workspace,
} from './types.js';
import { id, now, safeJson } from './util.js';

const migrations = [
  `
  CREATE TABLE workspaces (
    id TEXT PRIMARY KEY, host_id TEXT NOT NULL, display_name TEXT NOT NULL,
    canonical_path TEXT NOT NULL UNIQUE, defaults_json TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), pi_session_id TEXT,
    private_session_path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, runner_state TEXT NOT NULL DEFAULT 'stopped',
    runner_epoch INTEGER NOT NULL DEFAULT 0, partial_output_lost INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE runs (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), status TEXT NOT NULL,
    started_at INTEGER, ended_at INTEGER, failure_reason TEXT, created_at INTEGER NOT NULL
  );
  CREATE INDEX runs_session_status ON runs(session_id, status);
  CREATE TABLE commands (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), payload_hash TEXT NOT NULL,
    payload_json TEXT NOT NULL, status TEXT NOT NULL, result_json TEXT, error_text TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE INDEX commands_session_status ON commands(session_id, status);
  CREATE TABLE interactions (
    id TEXT PRIMARY KEY, rpc_id TEXT NOT NULL, session_id TEXT NOT NULL REFERENCES sessions(id), runner_epoch INTEGER NOT NULL,
    kind TEXT NOT NULL, status TEXT NOT NULL, request_json TEXT NOT NULL, answer_json TEXT,
    expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, answered_at INTEGER,
    UNIQUE(session_id, runner_epoch, rpc_id)
  );
  CREATE INDEX interactions_pending ON interactions(session_id, status, expires_at);
  CREATE TABLE leases (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id), client_id TEXT NOT NULL,
    generation INTEGER NOT NULL, expires_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE uploads (
    id TEXT PRIMARY KEY, owner_user TEXT NOT NULL, mime_type TEXT NOT NULL, byte_size INTEGER NOT NULL,
    storage_name TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  `,
];

const RUNNING: RunStatus[] = ['queued', 'running', 'waiting_input', 'stopping'];

export interface SessionRow extends SessionSummary {
  privateSessionPath: string;
  piSessionId: string | null;
  partialOutputLost: boolean;
}
export interface CommandRow {
  id: string;
  sessionId: string;
  payloadHash: string;
  payload: unknown;
  status: CommandStatus;
  result: unknown;
  error: string | null;
}
export interface InteractionRow {
  id: string;
  rpcId: string;
  sessionId: string;
  runnerEpoch: number;
  kind: string;
  status: InteractionStatus;
  request: Record<string, unknown>;
  expiresAt: number;
}

export class GatewayDatabase {
  readonly raw: Database.Database;
  constructor(databasePath: string) {
    this.raw = new Database(databasePath);
    this.raw.pragma('journal_mode = WAL');
    this.raw.pragma('foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    const current = this.raw.pragma('user_version', { simple: true }) as number;
    for (let index = current; index < migrations.length; index++) {
      this.raw.transaction(() => {
        this.raw.exec(migrations[index]!);
        this.raw.pragma(`user_version = ${index + 1}`);
      })();
    }
  }

  close(): void {
    this.raw.close();
  }

  recoverStartup(): {
    interruptedRuns: number;
    staleInteractions: number;
    unknownCommands: number;
  } {
    return this.raw.transaction(() => {
      const stamp = now();
      const interruptedRuns = this.raw
        .prepare(
          `UPDATE runs SET status='interrupted', ended_at=?, failure_reason='gateway restarted' WHERE status IN (${RUNNING.map(() => '?').join(',')})`,
        )
        .run(stamp, ...RUNNING).changes;
      const staleInteractions = this.raw
        .prepare("UPDATE interactions SET status='stale' WHERE status='pending'")
        .run().changes;
      const unknownCommands = this.raw
        .prepare(
          "UPDATE commands SET status='outcome_unknown', error_text='gateway restarted before RPC acceptance was recorded', updated_at=? WHERE status='dispatched'",
        )
        .run(stamp).changes;
      this.raw
        .prepare(
          "UPDATE sessions SET runner_state='stopped', partial_output_lost=1, updated_at=? WHERE runner_state!='stopped'",
        )
        .run(stamp);
      this.raw.prepare('DELETE FROM leases').run();
      return { interruptedRuns, staleInteractions, unknownCommands };
    })();
  }

  syncWorkspaces(config: GatewayConfig): void {
    const insert = this.raw.prepare(
      'INSERT INTO workspaces (id,host_id,display_name,canonical_path,defaults_json,created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET host_id=excluded.host_id, display_name=excluded.display_name, canonical_path=excluded.canonical_path, defaults_json=excluded.defaults_json',
    );
    this.raw.transaction(() => {
      for (const workspace of config.workspaces)
        insert.run(
          workspace.id,
          config.hostId,
          workspace.displayName,
          workspace.path,
          JSON.stringify(workspace.defaults),
          now(),
        );
    })();
  }

  listWorkspaces(): Workspace[] {
    return (this.raw.prepare('SELECT * FROM workspaces ORDER BY display_name').all() as any[]).map(
      (row) => ({
        id: row.id,
        hostId: row.host_id,
        displayName: row.display_name,
        canonicalPath: row.canonical_path,
        defaults: safeJson(row.defaults_json, {}),
      }),
    );
  }

  getWorkspace(workspaceId: string): Workspace {
    const row = this.raw.prepare('SELECT * FROM workspaces WHERE id=?').get(workspaceId) as any;
    if (!row) throw new ApiError(404, 'not_found', 'Workspace not found');
    return {
      id: row.id,
      hostId: row.host_id,
      displayName: row.display_name,
      canonicalPath: row.canonical_path,
      defaults: safeJson(row.defaults_json, {}),
    };
  }

  createSession(workspaceId: string, name: string, privateSessionPath: string): SessionRow {
    this.getWorkspace(workspaceId);
    const sessionId = id('session');
    const stamp = now();
    this.raw
      .prepare(
        'INSERT INTO sessions (id,workspace_id,private_session_path,name,created_at,updated_at) VALUES (?,?,?,?,?,?)',
      )
      .run(sessionId, workspaceId, privateSessionPath, name, stamp, stamp);
    return this.getSession(sessionId);
  }

  private mapSession(row: any): SessionRow {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      name: row.name,
      runnerState: row.runner_state,
      runStatus: row.run_status ?? null,
      runnerEpoch: row.runner_epoch,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      privateSessionPath: row.private_session_path,
      piSessionId: row.pi_session_id ?? null,
      partialOutputLost: Boolean(row.partial_output_lost),
    };
  }

  listSessions(): SessionRow[] {
    return (
      this.raw
        .prepare(
          'SELECT s.*, (SELECT status FROM runs r WHERE r.session_id=s.id ORDER BY r.created_at DESC LIMIT 1) run_status FROM sessions s ORDER BY updated_at DESC',
        )
        .all() as any[]
    ).map((row) => this.mapSession(row));
  }

  getSession(sessionId: string): SessionRow {
    const row = this.raw
      .prepare(
        'SELECT s.*, (SELECT status FROM runs r WHERE r.session_id=s.id ORDER BY r.created_at DESC LIMIT 1) run_status FROM sessions s WHERE id=?',
      )
      .get(sessionId) as any;
    if (!row) throw new ApiError(404, 'not_found', 'Session not found');
    return this.mapSession(row);
  }

  renameSession(sessionId: string, name: string): SessionRow {
    this.getSession(sessionId);
    this.raw
      .prepare('UPDATE sessions SET name=?, updated_at=? WHERE id=?')
      .run(name, now(), sessionId);
    return this.getSession(sessionId);
  }
  setRunnerState(sessionId: string, state: string): void {
    this.raw
      .prepare('UPDATE sessions SET runner_state=?, updated_at=? WHERE id=?')
      .run(state, now(), sessionId);
  }
  incrementEpoch(sessionId: string): number {
    this.raw
      .prepare(
        'UPDATE sessions SET runner_epoch=runner_epoch+1, partial_output_lost=0, updated_at=? WHERE id=?',
      )
      .run(now(), sessionId);
    return this.getSession(sessionId).runnerEpoch;
  }
  setPiSession(sessionId: string, piSessionId: string | null): void {
    this.raw
      .prepare('UPDATE sessions SET pi_session_id=?, updated_at=? WHERE id=?')
      .run(piSessionId, now(), sessionId);
  }

  createRun(sessionId: string): string {
    const active = this.raw
      .prepare(
        `SELECT id FROM runs WHERE session_id=? AND status IN (${RUNNING.map(() => '?').join(',')})`,
      )
      .get(sessionId, ...RUNNING);
    if (active) throw new ApiError(409, 'conflict', 'Session already has an active run');
    const runId = id('run');
    this.raw
      .prepare("INSERT INTO runs (id,session_id,status,created_at) VALUES (?,?,'queued',?)")
      .run(runId, sessionId, now());
    return runId;
  }
  updateRun(runId: string, status: RunStatus, failureReason?: string): void {
    const stamp = now();
    const startedAt = status === 'running' ? stamp : null;
    const terminal = ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(status)
      ? stamp
      : null;
    this.raw
      .prepare(
        'UPDATE runs SET status=?, started_at=COALESCE(started_at,?), ended_at=COALESCE(?,ended_at), failure_reason=COALESCE(?,failure_reason) WHERE id=?',
      )
      .run(status, startedAt, terminal, failureReason ?? null, runId);
  }
  latestRun(sessionId: string): Record<string, unknown> | null {
    return (
      (this.raw
        .prepare(
          'SELECT id,status,started_at AS startedAt,ended_at AS endedAt,failure_reason AS failureReason,created_at AS createdAt FROM runs WHERE session_id=? ORDER BY created_at DESC LIMIT 1',
        )
        .get(sessionId) as Record<string, unknown> | undefined) ?? null
    );
  }

  receiveCommand(
    commandId: string,
    sessionId: string,
    hash: string,
    payload: unknown,
  ): { row: CommandRow; duplicate: boolean } {
    return this.raw.transaction(() => {
      const existing = this.raw.prepare('SELECT * FROM commands WHERE id=?').get(commandId) as any;
      if (existing) {
        if (existing.session_id !== sessionId || existing.payload_hash !== hash)
          throw new ApiError(
            409,
            'conflict',
            'commandId was already used with a different payload',
          );
        return { row: this.mapCommand(existing), duplicate: true };
      }
      const stamp = now();
      this.raw
        .prepare(
          "INSERT INTO commands (id,session_id,payload_hash,payload_json,status,created_at,updated_at) VALUES (?,?,?,?,'received',?,?)",
        )
        .run(commandId, sessionId, hash, JSON.stringify(payload), stamp, stamp);
      return { row: this.getCommand(commandId), duplicate: false };
    })();
  }
  private mapCommand(row: any): CommandRow {
    return {
      id: row.id,
      sessionId: row.session_id,
      payloadHash: row.payload_hash,
      payload: safeJson(row.payload_json, null),
      status: row.status,
      result: row.result_json ? safeJson(row.result_json, null) : null,
      error: row.error_text ?? null,
    };
  }
  getCommand(commandId: string): CommandRow {
    const row = this.raw.prepare('SELECT * FROM commands WHERE id=?').get(commandId) as any;
    if (!row) throw new ApiError(404, 'not_found', 'Command not found');
    return this.mapCommand(row);
  }
  updateCommand(commandId: string, status: CommandStatus, result?: unknown, error?: string): void {
    this.raw
      .prepare('UPDATE commands SET status=?, result_json=?, error_text=?, updated_at=? WHERE id=?')
      .run(
        status,
        result === undefined ? null : JSON.stringify(result),
        error ?? null,
        now(),
        commandId,
      );
  }
  markDispatchedUnknown(sessionId: string, reason: string): number {
    return this.raw
      .prepare(
        "UPDATE commands SET status='outcome_unknown', error_text=?, updated_at=? WHERE session_id=? AND status='dispatched'",
      )
      .run(reason, now(), sessionId).changes;
  }

  createInteraction(
    sessionId: string,
    epoch: number,
    rpcId: string,
    kind: string,
    request: Record<string, unknown>,
    expiresAt: number,
  ): InteractionRow {
    const interactionId = id('interaction');
    this.raw
      .prepare(
        "INSERT INTO interactions (id,rpc_id,session_id,runner_epoch,kind,status,request_json,expires_at,created_at) VALUES (?,?,?,?,?,'pending',?,?,?)",
      )
      .run(interactionId, rpcId, sessionId, epoch, kind, JSON.stringify(request), expiresAt, now());
    return this.getInteraction(interactionId);
  }
  getInteraction(interactionId: string): InteractionRow {
    const row = this.raw.prepare('SELECT * FROM interactions WHERE id=?').get(interactionId) as any;
    if (!row) throw new ApiError(404, 'not_found', 'Interaction not found');
    return {
      id: row.id,
      rpcId: row.rpc_id,
      sessionId: row.session_id,
      runnerEpoch: row.runner_epoch,
      kind: row.kind,
      status: row.status,
      request: safeJson(row.request_json, {}),
      expiresAt: row.expires_at,
    };
  }
  pendingInteractions(sessionId: string): InteractionRow[] {
    return (
      this.raw
        .prepare(
          "SELECT * FROM interactions WHERE session_id=? AND status='pending' AND expires_at>? ORDER BY created_at",
        )
        .all(sessionId, now()) as any[]
    ).map((row) => ({
      id: row.id,
      rpcId: row.rpc_id,
      sessionId: row.session_id,
      runnerEpoch: row.runner_epoch,
      kind: row.kind,
      status: row.status,
      request: safeJson(row.request_json, {}),
      expiresAt: row.expires_at,
    }));
  }
  claimInteraction(
    interactionId: string,
    sessionId: string,
    epoch: number,
    answer: unknown,
  ): InteractionRow {
    return this.raw.transaction(() => {
      const interaction = this.getInteraction(interactionId);
      if (
        interaction.sessionId !== sessionId ||
        interaction.runnerEpoch !== epoch ||
        interaction.status !== 'pending' ||
        interaction.expiresAt <= now()
      )
        throw new ApiError(409, 'stale_interaction', 'Interaction is no longer answerable');
      const changed = this.raw
        .prepare(
          "UPDATE interactions SET status='answered', answer_json=?, answered_at=? WHERE id=? AND status='pending' AND runner_epoch=?",
        )
        .run(JSON.stringify(answer), now(), interactionId, epoch).changes;
      if (changed !== 1)
        throw new ApiError(409, 'stale_interaction', 'Interaction was already answered');
      return interaction;
    })();
  }
  staleEpochInteractions(sessionId: string, epoch: number): void {
    this.raw
      .prepare(
        "UPDATE interactions SET status='stale' WHERE session_id=? AND status='pending' AND runner_epoch!=?",
      )
      .run(sessionId, epoch);
  }

  getLease(sessionId: string): Record<string, unknown> | null {
    const row = this.raw
      .prepare(
        'SELECT client_id AS clientId,generation,expires_at AS expiresAt FROM leases WHERE session_id=?',
      )
      .get(sessionId) as any;
    if (!row) return null;
    return { ...row, expired: row.expiresAt <= now() };
  }
  acquireLease(
    sessionId: string,
    clientId: string,
    force: boolean,
    ttlMs: number,
  ): Record<string, unknown> {
    this.getSession(sessionId);
    return this.raw.transaction(() => {
      const current = this.raw
        .prepare('SELECT * FROM leases WHERE session_id=?')
        .get(sessionId) as any;
      if (current && current.expires_at > now() && current.client_id !== clientId && !force)
        throw new ApiError(409, 'lost_control', 'Another client holds control');
      const generation = (current?.generation ?? 0) + 1;
      const expiresAt = now() + ttlMs;
      this.raw
        .prepare(
          'INSERT INTO leases (session_id,client_id,generation,expires_at,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET client_id=excluded.client_id,generation=excluded.generation,expires_at=excluded.expires_at,updated_at=excluded.updated_at',
        )
        .run(sessionId, clientId, generation, expiresAt, now());
      return { clientId, generation, expiresAt };
    })();
  }
  validateLease(sessionId: string, clientId: string, generation: number): void {
    const lease = this.raw.prepare('SELECT * FROM leases WHERE session_id=?').get(sessionId) as any;
    if (
      !lease ||
      lease.client_id !== clientId ||
      lease.generation !== generation ||
      lease.expires_at <= now()
    )
      throw new ApiError(409, 'lost_control', 'Control lease is missing, expired, or superseded');
  }
  heartbeatLease(
    sessionId: string,
    clientId: string,
    generation: number,
    ttlMs: number,
  ): Record<string, unknown> {
    this.validateLease(sessionId, clientId, generation);
    const expiresAt = now() + ttlMs;
    this.raw
      .prepare(
        'UPDATE leases SET expires_at=?,updated_at=? WHERE session_id=? AND client_id=? AND generation=?',
      )
      .run(expiresAt, now(), sessionId, clientId, generation);
    return { clientId, generation, expiresAt };
  }
  releaseLease(sessionId: string, clientId: string, generation: number): void {
    this.validateLease(sessionId, clientId, generation);
    this.raw
      .prepare('DELETE FROM leases WHERE session_id=? AND client_id=? AND generation=?')
      .run(sessionId, clientId, generation);
  }

  createUpload(
    uploadId: string,
    user: string,
    mimeType: string,
    byteSize: number,
    storageName: string,
    sha256: string,
  ): void {
    this.raw
      .prepare(
        'INSERT INTO uploads (id,owner_user,mime_type,byte_size,storage_name,sha256,created_at) VALUES (?,?,?,?,?,?,?)',
      )
      .run(uploadId, user, mimeType, byteSize, storageName, sha256, now());
  }
  getUpload(uploadId: string): Record<string, any> {
    const row = this.raw
      .prepare(
        'SELECT id,owner_user AS ownerUser,mime_type AS mimeType,byte_size AS byteSize,storage_name AS storageName,sha256 FROM uploads WHERE id=?',
      )
      .get(uploadId) as Record<string, any> | undefined;
    if (!row) throw new ApiError(404, 'not_found', 'Upload not found');
    return row;
  }
}
