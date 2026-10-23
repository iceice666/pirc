-- How a worker ended is told in its room by the brain, in its own words
-- (plans/rewrite/06-workers.md), in a 'report' turn of its own when nobody
-- speaks there first. reported_at: when the room was told; workers that
-- ended before were shown their report as it was.
ALTER TABLE delegations ADD COLUMN reported_at INTEGER;
UPDATE delegations SET reported_at = updated_at WHERE status IN ('completed', 'failed');
CREATE TABLE brain_turns_report (
  id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id),
  kind TEXT NOT NULL CHECK (kind IN ('user', 'wake', 'report')),
  message_ids_json TEXT NOT NULL DEFAULT '[]',
  started_at INTEGER NOT NULL, ended_at INTEGER,
  outcome TEXT CHECK (outcome IN ('done', 'failed', 'aborted', 'timeout', 'preempted', 'interrupted')),
  error TEXT, usage_json TEXT
);
INSERT INTO brain_turns_report (id, room_id, kind, message_ids_json, started_at, ended_at, outcome, error, usage_json)
  SELECT id, room_id, kind, message_ids_json, started_at, ended_at, outcome, error, usage_json FROM brain_turns;
DROP TABLE brain_turns;
ALTER TABLE brain_turns_report RENAME TO brain_turns;
CREATE INDEX brain_turns_room ON brain_turns(room_id, started_at);
