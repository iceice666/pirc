
-- Backend-only dispatch provenance and durable at-most-once send fences.
-- No FK cascade: deletion must never allow re-creation or replay.
CREATE TABLE pots_dispatches (
  owner TEXT NOT NULL, dispatch_id TEXT NOT NULL, binding_id TEXT NOT NULL,
  generation INTEGER NOT NULL, workspace_id TEXT, content TEXT, expires_at INTEGER,
  session_id TEXT UNIQUE, state TEXT NOT NULL, fenced INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(owner, dispatch_id)
);
