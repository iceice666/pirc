-- The brain's turns (plans/rewrite/02-brain-host.md), newest last per room:
-- kind 'user' answers what people said, 'wake' is the brain's own (plan 05).
-- message_ids_json: the user messages it took, steered-in ones included.
-- outcome is NULL while it runs; a turn still open at startup is
-- 'interrupted'. usage_json sums the model calls' token usage.
CREATE TABLE brain_turns (
  id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id),
  kind TEXT NOT NULL CHECK (kind IN ('user', 'wake')),
  message_ids_json TEXT NOT NULL DEFAULT '[]',
  started_at INTEGER NOT NULL, ended_at INTEGER,
  outcome TEXT CHECK (outcome IN ('done', 'failed', 'aborted', 'timeout', 'preempted', 'interrupted')),
  error TEXT, usage_json TEXT
);
CREATE INDEX brain_turns_room ON brain_turns(room_id, started_at);
