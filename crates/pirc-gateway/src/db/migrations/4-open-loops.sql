-- Open loops (plans/rewrite/04-open-loops.md): what is still open between
-- the brain and the people, always in its prompt. owner_user: whose it is
-- (the turn's first speaker), where it goes when demoted. origin: 'user' or
-- 'tool:<source>', worked out by the gateway. anchor_json: none, a time
-- {at, zone, autoClose, passed?} or a recurrence {cron, zone, until?, nextAt};
-- due_at: when its anchor fires next while open (NULL: none, or passed).
-- closed_reason: the brain's words, the person's, or 'elapsed',
-- 'recurrence_ended' or 'demoted'.
CREATE TABLE open_loops (
  id TEXT PRIMARY KEY, owner_user TEXT NOT NULL, room_id TEXT, face_id TEXT,
  what TEXT NOT NULL, why TEXT NOT NULL DEFAULT '',
  origin TEXT NOT NULL, anchor_json TEXT, next_check TEXT,
  status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
  closed_reason TEXT, closed_at INTEGER,
  created_at INTEGER NOT NULL, last_touched_at INTEGER NOT NULL,
  source_entry_ids_json TEXT NOT NULL DEFAULT '[]', due_at INTEGER
);
CREATE INDEX open_loops_status ON open_loops(status, last_touched_at);
CREATE INDEX open_loops_due ON open_loops(due_at) WHERE status = 'open';

-- A fact that was an open loop, demoted when too many were open: the loop's
-- id, so reopening it takes the fact back.
ALTER TABLE memory_records ADD COLUMN open_loop_id TEXT;
