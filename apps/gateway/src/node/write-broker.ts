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

  acquire(sessionId: string, canonicalPath: string): WriteGrant {
    for (const [owner, paths] of this.held) {
      if (owner === sessionId) continue;
      for (const heldPath of paths)
        if (pathsOverlap(heldPath, canonicalPath))
          return { granted: false, holder: owner, path: heldPath };
    }
    let mine = this.held.get(sessionId);
    if (!mine) this.held.set(sessionId, (mine = new Set()));
    mine.add(canonicalPath);
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
    this.held.delete(sessionId);
  }
}
