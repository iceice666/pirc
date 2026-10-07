/** Session IDs are retained only in memory; reports contain fixed owner classes/counts. */
export type RequestOwner = 'parent' | 'child' | 'auxiliary' | 'unknown';
export class RequestLedger {
  private parent = '';
  private children = new Set<string>();
  private rows = new Map<
    string,
    { session: string; attempts: number; complete: number; ended: boolean }
  >();
  private failed = false;
  private deniedRequests = new Set<string>();
  deny(id: string): void {
    if (!this.rows.has(id)) this.failed = true;
    this.deniedRequests.add(id);
    // Nonbillable and explained, but not a valid evaluation request.
    this.failed = true;
  }
  invalidate(): void {
    this.failed = true;
  }
  parentSession(id: string): void {
    this.parent = id;
  }
  childSession(id: string): void {
    this.children.add(id);
  }
  start(id: string, session: string): void {
    if (this.rows.has(id) || this.rows.size >= 1000) {
      this.failed = true;
      throw new Error('Evaluation request ledger limit');
    }
    this.rows.set(id, { session, attempts: 0, complete: 0, ended: false });
  }
  end(id: string): void {
    const row = this.rows.get(id);
    if (!row || row.ended) this.failed = true;
    else row.ended = true;
  }
  attempt(id: string, complete: boolean): void {
    const row = this.rows.get(id);
    if (!row) {
      this.failed = true;
      return;
    }
    row.attempts++;
    if (complete) row.complete++;
  }
  private owner(session: string): RequestOwner {
    if (session === this.parent && this.parent) return 'parent';
    if (this.children.has(session)) return 'child';
    if (
      [this.parent, ...this.children]
        .filter(Boolean)
        .some((base) =>
          ['-title', '-memory', '-auto-mode'].some((suffix) => session === base + suffix),
        )
    )
      return 'auxiliary';
    return 'unknown';
  }
  summary() {
    const counts: Record<RequestOwner, number> = { parent: 0, child: 0, auxiliary: 0, unknown: 0 };
    let attempts = 0,
      completeAttempts = 0,
      pending = 0,
      unmatchedRequests = 0;
    for (const [id, row] of this.rows) {
      counts[this.owner(row.session)]++;
      attempts += row.attempts;
      completeAttempts += row.complete;
      if (!row.ended) pending++;
      if (!row.attempts && !this.deniedRequests.has(id)) unmatchedRequests++;
    }
    return {
      verified:
        !this.failed &&
        !!this.parent &&
        this.rows.size > 0 &&
        counts.unknown === 0 &&
        pending === 0 &&
        unmatchedRequests === 0 &&
        attempts === completeAttempts,
      requests: this.rows.size,
      owners: counts,
      attempts,
      completeAttempts,
      pending,
      unmatchedRequests,
      localDeniedRequests: this.deniedRequests.size,
    };
  }
}
