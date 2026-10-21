-- Workers (plans/rewrite/06-workers.md): the brain calls workers on its own;
-- a delegation belongs to a room (and the face that spoke there), not to a
-- chat session, and its progress lives in a thread under the message that
-- handed it out. status gains 'queued' (more than 4 run, or its node is
-- offline). read_only: the worker works read-only (a wake called it).
-- context_json: what the brain handed it (facts, loops, quotes). wake_id:
-- the wake that called it. note: why it waits.
ALTER TABLE delegations RENAME COLUMN assistant_session_id TO room_id;
DROP INDEX delegations_assistant;
CREATE INDEX delegations_room ON delegations(room_id, status);
ALTER TABLE delegations ADD COLUMN face_id TEXT;
ALTER TABLE delegations ADD COLUMN thread_id TEXT;
ALTER TABLE delegations ADD COLUMN anchor_message_id TEXT;
ALTER TABLE delegations ADD COLUMN read_only INTEGER NOT NULL DEFAULT 0;
ALTER TABLE delegations ADD COLUMN context_json TEXT;
ALTER TABLE delegations ADD COLUMN wake_id TEXT;
ALTER TABLE delegations ADD COLUMN note TEXT;
CREATE INDEX delegations_thread ON delegations(thread_id);

-- A thread's messages, numbered from 1 within the thread. speaker:
-- 'worker:<session>' (the worker's own session), 'worker:<session>/<name>'
-- (a teammate or subagent it started, depth 1), 'user' (user says who) or
-- 'face:<id>'. kind 'tool' is one thing a worker did, 'question' asks the
-- user (body.status pending|answered|cancelled).
CREATE TABLE thread_messages (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id), seq INTEGER NOT NULL,
  speaker TEXT NOT NULL, user TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('text', 'line', 'tool', 'question')),
  body_json TEXT NOT NULL, depth INTEGER NOT NULL DEFAULT 0 CHECK (depth IN (0, 1)),
  created_at INTEGER NOT NULL, updated_at INTEGER,
  UNIQUE (thread_id, seq)
);
