import { ApiError } from './errors.js';
import { pathsOverlap } from './util.js';

export class WorkspaceLocks {
  private readonly held = new Map<string, string>();
  constructor(private readonly globalLimit: number) {}

  acquire(sessionId: string, canonicalPath: string): void {
    if (this.held.has(sessionId)) return;
    if (this.held.size >= this.globalLimit)
      throw new ApiError(503, 'runner_unavailable', 'Global runner limit reached');
    for (const [owner, heldPath] of this.held) {
      if (owner !== sessionId && pathsOverlap(heldPath, canonicalPath))
        throw new ApiError(409, 'workspace_busy', 'Workspace overlaps an active runner');
    }
    this.held.set(sessionId, canonicalPath);
  }

  /** Sessions whose held path overlaps `canonicalPath` (excluding `sessionId`). */
  overlapping(sessionId: string, canonicalPath: string): string[] {
    return [...this.held]
      .filter(([owner, heldPath]) => owner !== sessionId && pathsOverlap(heldPath, canonicalPath))
      .map(([owner]) => owner);
  }

  holders(): string[] {
    return [...this.held.keys()];
  }

  release(sessionId: string): void {
    this.held.delete(sessionId);
  }
  get activeCount(): number {
    return this.held.size;
  }
}
