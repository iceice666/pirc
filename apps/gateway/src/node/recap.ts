import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { GatewayDatabase } from '../database.js';
import { ApiError } from '../errors.js';
import { redactSecrets } from '../agent/features/memory/redact.js';

const MAX_FILE = 4 * 1024 * 1024;
const MAX_SCAN = 32 * 1024 * 1024;
const MAX_OUTPUT = 80_000;
const argsSchema = z.object({ days: z.number().int().min(1).max(90).default(14) }).strict();
const entrySchema = z
  .object({
    id: z.string().min(1).max(128),
    parentId: z.string().min(1).max(128).nullable(),
    timestamp: z.number().finite().nonnegative(),
    type: z.string(),
  })
  .passthrough();
type Entry = z.infer<typeof entrySchema>;
type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;

export interface RecapSource {
  entryId: string;
  timestamp: number;
  role: 'user' | 'assistant' | 'tool';
  text?: string;
  toolName?: string;
  isError?: boolean;
}
export interface RecapSessionEvidence {
  sessionId: string;
  evidence: RecapSource[];
  truncated: boolean;
}
export interface RecapEvidence {
  version: 1;
  scope: { workspaceId: string; days: number; since: number; until: number };
  sampling: string;
  sessions: RecapSessionEvidence[];
  skipped: Array<{ sessionId: string; reason: string }>;
  truncated: boolean;
  scannedBytes: number;
}

/** Reject every symlink component, not only the final file. Never walk session directories. */
function noSymlinks(file: string): void {
  if (!path.isAbsolute(file)) throw new Error('unsafe_path');
  let cursor = path.parse(file).root;
  const parts = file.slice(cursor.length).split(path.sep).filter(Boolean);
  for (const [index, part] of parts.entries()) {
    cursor = path.join(cursor, part);
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory()))
      throw new Error('unsafe_path');
  }
}

function branch(text: string, root: string): Entry[] {
  const entries: Entry[] = [];
  const byId = new Map<string, Entry>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    if (entries.length >= 20_000) throw new Error('entry_limit');
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error('invalid_jsonl');
    }
    const parsed = entrySchema.safeParse(value);
    if (!parsed.success || byId.has(parsed.data.id)) throw new Error('invalid_entries');
    const entry = parsed.data;
    const message = record(entry.message);
    // Origin tables live on the gateway in split deployments. The delivered
    // origin marker is the node-local authority; inspect all branches, too.
    const backgroundTypes = ['scheduled-run', 'assistant-delegation'];
    if (
      backgroundTypes.includes(String(entry.customType)) ||
      backgroundTypes.includes(String(message?.customType))
    )
      throw new Error('background_session');
    if (
      entry.customType === 'recap.run' ||
      entry.customType === 'recap.report' ||
      message?.customType === 'recap.report' ||
      message?.customType === 'recap.run'
    )
      throw new Error('recap_marked_session');
    entries.push(entry);
    byId.set(entry.id, entry);
  }
  const header = entries[0];
  if (
    header?.type !== 'session' ||
    header.version !== 1 ||
    header.cwd !== root ||
    header.parentId !== null
  )
    throw new Error('workspace_header_mismatch');
  const chain: Entry[] = [];
  const seen = new Set<string>();
  let cursor = entries.at(-1);
  while (cursor) {
    if (seen.has(cursor.id)) throw new Error('branch_cycle');
    seen.add(cursor.id);
    chain.push(cursor);
    if (cursor.parentId === null) break;
    const parent = byId.get(cursor.parentId);
    if (!parent) throw new Error('broken_branch');
    cursor = parent;
  }
  if (chain.at(-1) !== header) throw new Error('broken_branch');
  return chain.reverse();
}

function sources(entries: Entry[], since: number, until: number): RecapSource[] {
  const out: RecapSource[] = [];
  const tool = (entry: Entry, name: unknown, error: unknown) => {
    // Names only: no arguments, result bodies, error messages, or custom memory.
    if (typeof name === 'string' && /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(name))
      out.push({
        entryId: entry.id,
        timestamp: entry.timestamp,
        role: 'tool',
        toolName: redactSecrets(name),
        isError: error === true,
      });
  };
  for (const entry of entries) {
    if (entry.timestamp < since || entry.timestamp > until) continue;
    if (entry.type === 'custom' && entry.customType === 'ptc.operation') {
      const data = record(entry.data);
      tool(entry, data?.toolName, data?.isError);
    }
    if (entry.type !== 'message') continue;
    const message = record(entry.message);
    if (!message) continue;
    if (message.role === 'toolResult') tool(entry, message.toolName, message.isError);
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const parts = Array.isArray(message.content) ? message.content : [];
    const text =
      typeof message.content === 'string'
        ? message.content
        : parts
            .map(record)
            .filter((part) => part?.type === 'text' && typeof part.text === 'string')
            .map((part) => part!.text as string)
            .join('\n');
    if (text.trim())
      out.push({
        entryId: entry.id,
        timestamp: entry.timestamp,
        role: message.role,
        text: redactSecrets(text),
      });
    for (const part of parts) {
      const item = record(part);
      if (item?.type === 'toolCall') tool(entry, item.name, false);
    }
  }
  // Human evidence gets the budget first; within each tier prefer recent entries.
  return out.sort(
    (a, b) => Number(b.role === 'user') - Number(a.role === 'user') || b.timestamp - a.timestamp,
  );
}

/** Node-local only. The caller binds currentSessionId; args cannot select another scope. */
export function collectRecap(
  db: GatewayDatabase,
  currentSessionId: string,
  args: unknown,
): RecapEvidence {
  const parsed = argsSchema.safeParse(args);
  if (!parsed.success)
    throw new ApiError(400, 'invalid_input', 'Recap accepts only days (integer 1–90)');
  const current = db.getSession(currentSessionId);
  const workspace = db.getWorkspace(current.workspaceId);
  if (workspace.kind !== 'directory')
    throw new ApiError(400, 'invalid_input', 'Recap requires a directory workspace');
  if (!current.ownerUser)
    throw new ApiError(403, 'forbidden', 'Recap requires a known session owner');
  const until = Date.now();
  const since = until - parsed.data.days * 86_400_000;
  const result: RecapEvidence = {
    version: 1,
    scope: { workspaceId: workspace.id, days: parsed.data.days, since, until },
    sampling:
      'Bounded sample of recent owned sessions in this exact workspace; active branch only, user text prioritized. Entire recap-marked, oversized, malformed, or changing sessions are excluded. Not full history coverage. Redaction is best-effort.',
    sessions: [],
    skipped: [],
    truncated: false,
    scannedBytes: 0,
  };
  const rows = db.raw
    .query(
      `SELECT id, private_session_path AS dir FROM sessions s
    WHERE workspace_id=? AND owner_user=? AND id<>? AND updated_at>=?
      AND NOT EXISTS (SELECT 1 FROM schedule_runs r WHERE r.session_id=s.id)
      AND NOT EXISTS (SELECT 1 FROM delegations d WHERE d.target_session_id=s.id)
    ORDER BY updated_at DESC, id DESC LIMIT 21`,
    )
    .all(workspace.id, current.ownerUser, currentSessionId, since) as Array<{
    id: string;
    dir: string;
  }>;
  result.truncated = rows.length > 20;
  for (const row of rows.slice(0, 20)) {
    let fd: number | undefined;
    try {
      const file = path.join(row.dir, 'session.jsonl');
      noSymlinks(file);
      fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (!stat.isFile()) throw new Error('unsafe_path');
      if (stat.size > MAX_FILE) throw new Error('file_byte_limit');
      if (result.scannedBytes + stat.size > MAX_SCAN) throw new Error('scan_byte_limit');
      const buffer = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < buffer.length) {
        const count = readSync(fd, buffer, offset, buffer.length - offset, offset);
        if (!count) throw new Error('changed_session');
        offset += count;
        result.scannedBytes += count;
      }
      const after = fstatSync(fd);
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs)
        throw new Error('changed_session');
      const candidates = sources(
        branch(buffer.toString('utf8'), workspace.canonicalPath),
        since,
        until,
      );
      const session: RecapSessionEvidence = { sessionId: row.id, evidence: [], truncated: false };
      for (const source of candidates) {
        const item = {
          ...source,
          ...(source.text === undefined ? {} : { text: source.text.slice(0, 1800) }),
        };
        if (source.text && source.text.length > 1800) session.truncated = true;
        session.evidence.push(item);
        if (JSON.stringify(session).length > 5000) {
          session.evidence.pop();
          session.truncated = true;
        }
      }
      if (!session.evidence.length) throw new Error('no_in_window_evidence');
      result.sessions.push(session);
      if (JSON.stringify(result).length > MAX_OUTPUT - 4000) {
        result.sessions.pop();
        throw new Error('output_limit');
      }
      result.truncated ||= session.truncated;
    } catch (error) {
      const reason =
        error instanceof Error && /^[a-z_]+$/.test(error.message)
          ? error.message
          : 'unreadable_session';
      result.skipped.push({ sessionId: row.id, reason });
      result.truncated = true;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  return result;
}
