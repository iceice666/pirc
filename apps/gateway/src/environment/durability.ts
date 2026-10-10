import type { Database } from 'bun:sqlite';

/**
 * Immediate transaction committed with WAL `synchronous=NORMAL`, for writes that guard
 * no side effect and no replay decision: client projections/outbox cursors and node
 * progress/operation events. NORMAL commits survive a process crash; on power or OS
 * loss only a trailing suffix after the last FULL commit can be lost, never reordered,
 * because the next FULL commit fsyncs the shared WAL. Acceptance, claims, terminal
 * results, transcripts and intents must keep using ordinary FULL transactions.
 *
 * Requires a WAL connection (normally `synchronous=FULL`); the previous level is restored.
 * Inside an outer transaction the safety level cannot change, so the outer commit applies.
 */
export function relaxedTransaction<T>(db: Database, work: () => T): T {
  if (db.inTransaction) return db.transaction(work).immediate();
  const previous = (db.query('PRAGMA synchronous').get() as { synchronous: number }).synchronous;
  db.exec('PRAGMA synchronous=NORMAL');
  try {
    return db.transaction(work).immediate();
  } finally {
    db.exec(`PRAGMA synchronous=${Number(previous)}`);
  }
}
