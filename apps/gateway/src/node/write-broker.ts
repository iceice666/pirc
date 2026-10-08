import { pathsOverlap } from '../util.js';

export type WriteGrant = { granted: true } | { granted: false; holder: string; path: string };

/**
 * Write-permission broker. Runners start freely; a session must hold a lease
 * on a path before its agent writes under it, and no two sessions may hold
 * overlapping paths. Leases last until the session's run settles or its
 * runner exits.
 */
export class WriteBroker {
  private readonly held = new Map<string, Set<string>>();
  private readonly quarantined = new Set<string>();
  private readonly listeners = new Set<(holders: string[]) => void>();

  acquire(sessionId: string, canonicalPath: string): WriteGrant {
    if (this.quarantined.has(sessionId))
      return { granted: false, holder: sessionId, path: canonicalPath };
    for (const [owner, paths] of this.held) {
      if (owner === sessionId) continue;
      for (const heldPath of paths)
        if (pathsOverlap(heldPath, canonicalPath))
          return { granted: false, holder: owner, path: heldPath };
    }
    let mine = this.held.get(sessionId);
    const first = !mine;
    if (!mine) this.held.set(sessionId, (mine = new Set()));
    mine.add(canonicalPath);
    if (first) this.changed();
    return { granted: true };
  }

  /** Paths currently leased by `sessionId`. */
  leases(sessionId: string): string[] {
    return [...(this.held.get(sessionId) ?? [])];
  }

  holders(): string[] {
    return [...this.held.keys()];
  }

  release(sessionId: string): void {
    if (this.quarantined.has(sessionId)) return;
    if (this.held.delete(sessionId)) this.changed();
  }

  /** Supervisor-only: retain roots and deny even the same session after an unverified fence. */
  quarantine(sessionId: string, canonicalPaths = this.leases(sessionId)): void {
    this.quarantined.add(sessionId);
    const paths = this.held.get(sessionId) ?? new Set<string>();
    for (const root of canonicalPaths) paths.add(root);
    this.held.set(sessionId, paths);
    this.changed();
  }

  /** Called with every holder whenever a session gains its first lease or loses them all. */
  onChange(listener: (holders: string[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    const holders = this.holders();
    for (const listener of this.listeners) listener(holders);
  }
}
