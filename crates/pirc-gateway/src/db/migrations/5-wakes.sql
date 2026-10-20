-- Wakes (plans/rewrite/05-self-wake.md): the brain waking up without anyone
-- asking. kind: 'anchor' (an open loop's time came, or the day before an
-- autoClose time), 'source' (plan 09) or 'self' (it asked to come back).
-- trigger_json: what woke it ({loopId, moment, ...} or {at, why}). owner_user:
-- whom it is for (the push, the turn's speaker). attempt: 2 for a wake put
-- back after a user turn took over. outcome NULL: pending (started_at NULL)
-- or running.
CREATE TABLE wakes (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('anchor', 'source', 'self')),
  trigger_json TEXT NOT NULL, room_id TEXT NOT NULL, face_id TEXT, owner_user TEXT,
  scheduled_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER,
  outcome TEXT CHECK (outcome IN ('spoke', 'silent', 'preempted', 'failed', 'quota', 'cancelled')),
  note TEXT, attempt INTEGER NOT NULL DEFAULT 1, turn_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX wakes_pending ON wakes(scheduled_at) WHERE outcome IS NULL;
CREATE INDEX wakes_room ON wakes(room_id, scheduled_at);
CREATE INDEX wakes_started ON wakes(started_at) WHERE started_at IS NOT NULL;

-- The day before an autoClose time (a deadline, a meeting) the brain wakes
-- too: when, while that is still to come (NULL: none, or it came).
ALTER TABLE open_loops ADD COLUMN notice_at INTEGER;
