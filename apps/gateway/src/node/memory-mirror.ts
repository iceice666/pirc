/**
 * Mirrors this node's workspace memory to the gateway (plans/assistant.md), so
 * the assistant can search what coding sessions noted, on every machine. Each
 * ledger is append-only JSON lines. The gateway acknowledges the byte offset
 * it holds, and the node sends the complete lines after it, one frame at a
 * time. No path leaves the node: an item names the node session that wrote it
 * instead of its session directory, and its git state drops the worktree.
 */
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  parseWorkspaceLines,
  type WorkspaceItem,
  type WorkspaceLine,
} from '../agent/features/memory/workspace.js';
import type { GatewayDatabase } from '../database.js';
import {
  MIRROR_CHUNK_BYTES,
  type MirroredItem,
  type MirroredLine,
  type NodeToDaemon,
} from '../protocol.js';

const LEDGER_FILE = /^([0-9a-f]{16})\.jsonl$/;
/** A frame the gateway never acknowledged is sent again after this long. */
const ACK_TIMEOUT_MS = 60_000;
/** A single line longer than a chunk is read whole, up to this size. */
const LINE_MAX_BYTES = 8 * 1024 * 1024;

export class MemoryMirror {
  private send: ((message: NodeToDaemon) => boolean) | undefined;
  private acked = new Map<string, number>();
  /** Ledgers with a frame on its way, and when it was sent. */
  private readonly sent = new Map<string, number>();
  private timer: NodeJS.Timeout | undefined;
  /** Session directory → node session id (or null when no session of this node wrote it). */
  private readonly sessions = new Map<string, string | null>();

  constructor(
    private readonly dir: string,
    private readonly db: GatewayDatabase,
    private readonly scanMs: number,
  ) {}

  /** Registered with the gateway, which already holds `watermarks` (by ledger key). */
  connect(send: (message: NodeToDaemon) => boolean, watermarks: Record<string, number>): void {
    this.send = send;
    this.acked = new Map(Object.entries(watermarks));
    this.sent.clear();
    if (!this.timer) {
      this.timer = setInterval(() => this.scan(), this.scanMs);
      this.timer.unref();
    }
    this.scan();
  }

  disconnect(): void {
    this.send = undefined;
    this.sent.clear();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** The gateway stored up to `watermark`: send what follows, if anything. */
  receive(ack: { ledgerKey: string; watermark: number }): void {
    this.acked.set(ack.ledgerKey, ack.watermark);
    this.sent.delete(ack.ledgerKey);
    this.mirror(ack.ledgerKey);
  }

  scan(): void {
    if (!this.send || !existsSync(this.dir)) return;
    for (const name of readdirSync(this.dir)) {
      const match = LEDGER_FILE.exec(name);
      if (match) this.mirror(match[1]!);
    }
  }

  private mirror(key: string): void {
    const send = this.send;
    const sentAt = this.sent.get(key);
    if (!send || (sentAt !== undefined && Date.now() - sentAt < ACK_TIMEOUT_MS)) return;
    const file = path.join(this.dir, `${key}.jsonl`);
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      return;
    }
    let from = this.acked.get(key) ?? 0;
    // Shrank: replaced or truncated, so the gateway starts this ledger over.
    const reset = size < from;
    if (reset) from = 0;
    if (size === from && !reset) return;
    const bytes = read(file, from, Math.min(size - from, MIRROR_CHUNK_BYTES));
    // Complete lines only: one being written now goes out with the next scan.
    let end = bytes.lastIndexOf(0x0a) + 1;
    let text = bytes.subarray(0, end).toString('utf8');
    if (end === 0 && bytes.length === MIRROR_CHUNK_BYTES) {
      const whole = read(file, from, Math.min(size - from, LINE_MAX_BYTES));
      end = whole.indexOf(0x0a) + 1;
      text = whole.subarray(0, end).toString('utf8');
    }
    if (end === 0 && !reset) return;
    const lines = parseWorkspaceLines(text).map((line) => this.convert(line));
    this.sent.set(key, Date.now());
    const delivered = send({
      type: 'memory_mirror',
      ledgerKey: key,
      offset: from,
      end: from + end,
      ...(reset ? { reset: true } : {}),
      lines,
    });
    if (!delivered) this.sent.delete(key);
  }

  private convert(line: WorkspaceLine): MirroredLine {
    if (line.type === 'recorded')
      return { type: 'recorded', items: line.items.map((item) => this.item(item)) };
    if (line.type === 'retired')
      return {
        type: 'retired',
        ids: line.ids,
        reason: line.reason === 'forgotten' ? 'forgotten' : 'superseded',
      };
    return { type: 'cleared' };
  }

  private item(item: WorkspaceItem): MirroredItem {
    const sessionId = this.nodeSession(item.sessionDir);
    return {
      id: item.id,
      content: item.content,
      relevance: item.relevance,
      timestamp: item.timestamp,
      ...(sessionId ? { sessionId } : {}),
      ...(item.git
        ? {
            git: {
              head: item.git.head,
              ...(item.git.branch ? { branch: item.git.branch } : {}),
              dirty: item.git.dirty,
            },
          }
        : {}),
      sourceMemoryIds: item.sourceMemoryIds,
      ...(item.origins ? { origins: item.origins } : {}),
    };
  }

  private nodeSession(sessionDir: string): string | undefined {
    if (!this.sessions.has(sessionDir)) {
      const row = this.db.raw
        .prepare('SELECT id FROM sessions WHERE private_session_path=?')
        .get(sessionDir) as { id: string } | undefined;
      this.sessions.set(sessionDir, row?.id ?? null);
    }
    return this.sessions.get(sessionDir) ?? undefined;
  }
}

function read(file: string, from: number, length: number): Buffer {
  const bytes = Buffer.alloc(length);
  if (!length) return bytes;
  const fd = openSync(file, 'r');
  try {
    const got = readSync(fd, bytes, 0, length, from);
    return bytes.subarray(0, got);
  } finally {
    closeSync(fd);
  }
}
