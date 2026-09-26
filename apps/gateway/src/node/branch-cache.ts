import { statSync } from 'node:fs';
import path from 'node:path';
import { readSessionBranch, SESSION_FILE, type SessionEntry } from '../agent/session-store.js';

/**
 * Session branches read straight from the agent's `session.jsonl`, keyed by
 * file size + mtime: snapshots and the panel poll after every turn, and
 * session files only grow, so an unchanged stat means unchanged content.
 *
 * The file is the authority for history: it survives the agent process, and
 * reading it never pushes the whole transcript through the RPC pipe.
 */
export class BranchCache {
  private readonly entries = new Map<
    string,
    { size: number; mtimeMs: number; branch: SessionEntry[] }
  >();

  read(dir: string): SessionEntry[] {
    let stat: { size: number; mtimeMs: number };
    try {
      stat = statSync(path.join(dir, SESSION_FILE));
    } catch {
      return [];
    }
    const cached = this.entries.get(dir);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs)
      return cached.branch;
    const branch = readSessionBranch(dir);
    this.entries.delete(dir);
    this.entries.set(dir, { size: stat.size, mtimeMs: stat.mtimeMs, branch });
    // Small LRU: a handful of sessions are viewed at a time.
    if (this.entries.size > 16) this.entries.delete(this.entries.keys().next().value!);
    return branch;
  }
}
