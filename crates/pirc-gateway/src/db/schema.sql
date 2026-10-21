-- The gateway's SQLite schema, `pirc.sqlite` (plans/rewrite/01-rooms.md).
-- A new file, version 1: the old gateway.sqlite is neither read nor migrated
-- (decision #14). The engine's index (workspaces .. leases) keeps the old
-- shape; rooms and what belongs to them follow it.

-- The engine: workspaces and sessions live on the nodes; this is their index.
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY, host_id TEXT NOT NULL, display_name TEXT NOT NULL,
  canonical_path TEXT NOT NULL UNIQUE, defaults_json TEXT NOT NULL, created_at INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'directory',
  -- The repository's normalized origin (pirc_protocol::normalize_origin), as the node reports it.
  repo TEXT
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), pi_session_id TEXT,
  private_session_path TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  name_source TEXT NOT NULL DEFAULT 'user', runner_state TEXT NOT NULL DEFAULT 'stopped',
  runner_epoch INTEGER NOT NULL DEFAULT 0, partial_output_lost INTEGER NOT NULL DEFAULT 0,
  node_id TEXT, owner_user TEXT, pinned_at INTEGER, settled_at INTEGER,
  -- Unread: the agent finished something (activity_at) after the user last read it (read_at).
  activity_at INTEGER, read_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX sessions_node_id ON sessions(node_id);
CREATE UNIQUE INDEX sessions_remote_identity ON sessions(node_id, pi_session_id) WHERE node_id IS NOT NULL;

CREATE TABLE commands (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), payload_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL, status TEXT NOT NULL, result_json TEXT, error_text TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX commands_session_status ON commands(session_id, status);

-- The node's control lease, mirrored with the user who holds it.
CREATE TABLE leases (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id), client_id TEXT NOT NULL,
  generation INTEGER NOT NULL, expires_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  owner_user TEXT
);

CREATE TABLE device_tokens (
  id TEXT PRIMARY KEY, owner_user TEXT NOT NULL, name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);
CREATE INDEX device_tokens_owner ON device_tokens(owner_user);

-- The brain's memory (plans/rewrite/03-memory.md). Preferences: small, in
-- the brain's prompt, changed only on the person's word. created_in_room:
-- the room they said it in.
CREATE TABLE preferences (
  id TEXT PRIMARY KEY, owner_user TEXT NOT NULL, content TEXT NOT NULL,
  status TEXT NOT NULL, revision INTEGER NOT NULL, origins_json TEXT NOT NULL,
  sources_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  created_in_room TEXT
);
CREATE INDEX preferences_owner ON preferences(owner_user, status);
-- Every revision of a preference. actor: 'user:<email>', 'face:<id>' or 'om'.
CREATE TABLE memory_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, owner_user TEXT NOT NULL, entry_id TEXT NOT NULL,
  revision INTEGER NOT NULL, op TEXT NOT NULL, content TEXT, origins_json TEXT NOT NULL,
  sources_json TEXT NOT NULL, actor TEXT NOT NULL, at INTEGER NOT NULL
);
CREATE INDEX memory_log_entry ON memory_log(entry_id, revision);
-- Forgotten text (a preference's or a fact's), refused from then on.
CREATE TABLE memory_tombstones (
  owner_user TEXT NOT NULL, content_hash TEXT NOT NULL, forgotten_at INTEGER NOT NULL,
  PRIMARY KEY (owner_user, content_hash)
);

-- Workers (plans/rewrite/06-workers.md): tasks the brain hands to a
-- workspace's session, at once. room_id/face_id: where it was asked for and
-- who said so; thread_id: the thread under its message (anchor_message_id).
-- status: queued (more than 4 run, or its node is offline: note says why),
-- running, waiting_input, completed or failed. notified_status: the status
-- the brain was last told of.
CREATE TABLE delegations (
  id TEXT PRIMARY KEY, owner_user TEXT NOT NULL, room_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL, title TEXT NOT NULL, task TEXT NOT NULL, follows TEXT,
  status TEXT NOT NULL, target_session_id TEXT, result TEXT, notified_status TEXT,
  expires_at INTEGER NOT NULL, dispatched_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  -- The model (and thinking level) it runs on, and the role its new session starts in.
  model_json TEXT, thinking TEXT, role TEXT,
  -- 1: the task counts as the user's own request for auto mode, for the run it starts.
  as_user_request INTEGER NOT NULL DEFAULT 0,
  -- How it started ('auto'); the origins of the brain's context when it
  -- called (JSON array), and the user's own words it verified (quote, JSON
  -- array of their message entry ids).
  dispatch TEXT, origins_json TEXT, quote TEXT, quote_entry_ids TEXT,
  face_id TEXT, thread_id TEXT, anchor_message_id TEXT,
  -- 1: it works read-only (a wake called it).
  read_only INTEGER NOT NULL DEFAULT 0,
  -- What the brain handed it besides the task: {facts, loops} as given.
  context_json TEXT, wake_id TEXT, note TEXT
);
CREATE INDEX delegations_owner ON delegations(owner_user, status);
CREATE INDEX delegations_follows ON delegations(follows);
CREATE INDEX delegations_target ON delegations(target_session_id, status);
CREATE INDEX delegations_room ON delegations(room_id, status);
CREATE INDEX delegations_thread ON delegations(thread_id);

-- Facts: a repository's notes, mirrored from the nodes' workspace ledgers
-- (scope 'repo'), and the household's facts the brain writes (scope
-- 'person'; node_id '' and ledger_key 'person'). origin: 'user',
-- 'tool:<source>', 'tool:delegation' or 'om:promoted';
-- source_entry_ids_json: the brain's session entries (or observations)
-- behind it. Room and face are labels.
CREATE TABLE memory_mirrors (
  node_id TEXT NOT NULL, ledger_key TEXT NOT NULL, watermark INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, PRIMARY KEY (node_id, ledger_key)
);
CREATE TABLE memory_records (
  node_id TEXT NOT NULL, ledger_key TEXT NOT NULL, id TEXT NOT NULL,
  content TEXT NOT NULL, relevance TEXT NOT NULL, recorded_at TEXT NOT NULL,
  git_json TEXT, source_ids_json TEXT NOT NULL, origins_json TEXT,
  node_session_id TEXT, session_id TEXT, workspace_id TEXT, owner_user TEXT,
  status TEXT NOT NULL,
  -- Its workspace's repo when recorded, so clones find each other's notes.
  repo TEXT,
  scope TEXT NOT NULL DEFAULT 'repo' CHECK (scope IN ('repo', 'person')),
  room_id TEXT, face_id TEXT, origin TEXT, source_entry_ids_json TEXT, created_at INTEGER,
  -- A demoted open loop's id (open_loops).
  open_loop_id TEXT,
  PRIMARY KEY (node_id, ledger_key, id)
);
CREATE INDEX memory_records_owner ON memory_records(owner_user, status);
CREATE INDEX memory_records_id ON memory_records(id);
CREATE INDEX memory_records_scope ON memory_records(owner_user, scope, status);

-- The search index (memory/text.rs index_terms; plans/memory-search.md),
-- kept by the gateway's own writes, rebuilt at startup when
-- search_index_meta.version is not the gateway's SEARCH_INDEX_VERSION.
CREATE VIRTUAL TABLE memory_records_fts USING fts5(
  node_id UNINDEXED, ledger_key UNINDEXED, id UNINDEXED, terms,
  tokenize = 'porter unicode61 remove_diacritics 0'
);
CREATE VIRTUAL TABLE delegations_fts USING fts5(
  id UNINDEXED, title, body,
  tokenize = 'porter unicode61 remove_diacritics 0'
);
CREATE TABLE search_index_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1), version INTEGER NOT NULL
);

-- Push notifications (daemon/push.ts).
CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY, owner_user TEXT NOT NULL, endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL, auth TEXT NOT NULL, kind TEXT NOT NULL, name TEXT,
  device_id TEXT, created_at INTEGER NOT NULL, last_success_at INTEGER,
  failures INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX push_subscriptions_owner ON push_subscriptions(owner_user);

-- The directory workspaces a chat project is about (docs/architecture/assistant-memory.md): a
-- default and an ordering, never a permission. No foreign key on workspace_id: a
-- link to a workspace that went away stays, shown as such. repo is the workspace's
-- normalized origin, so a link also covers the other clones of its repository.
CREATE TABLE project_links (
  project_workspace_id TEXT NOT NULL REFERENCES workspaces(id), workspace_id TEXT NOT NULL,
  repo TEXT, created_at INTEGER NOT NULL,
  PRIMARY KEY (project_workspace_id, workspace_id)
);

-- Rooms (docs/architecture/direction.md §2.2): every room is one thread that
-- is always there. Rooms are the household's, not one user's; reads are per
-- user. Exactly one 'general' room exists (seeded with the schema) and it is
-- never archived. Archiving hides a room from the list and deletes nothing.
CREATE TABLE rooms (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('general', 'topic')),
  created_at INTEGER NOT NULL, archived_at INTEGER, last_activity_at INTEGER NOT NULL,
  -- The sources and workspaces the room is about (plan 09/10), opaque here.
  source_scope_json TEXT,
  -- A move (POST /api/rooms/:id/move): where the conversation went, and came from.
  moved_to_room_id TEXT REFERENCES rooms(id), moved_from_room_id TEXT REFERENCES rooms(id),
  -- The seq the room's next message gets.
  next_seq INTEGER NOT NULL DEFAULT 1,
  CHECK (kind != 'general' OR archived_at IS NULL)
);
CREATE UNIQUE INDEX rooms_one_general ON rooms(kind) WHERE kind = 'general';

-- A room's messages, numbered from 1 within the room. speaker is 'user' or
-- 'face:<id>'; user is who sent a 'user' message. kind 'line' is a small
-- expandable note, 'progress' is updated in place, 'question' asks the user.
CREATE TABLE room_messages (
  id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), seq INTEGER NOT NULL,
  speaker TEXT NOT NULL, user TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('text', 'line', 'progress', 'question')),
  body_json TEXT NOT NULL, thread_id TEXT REFERENCES threads(id),
  created_at INTEGER NOT NULL, edited_at INTEGER, pinned_at INTEGER,
  UNIQUE (room_id, seq)
);
CREATE INDEX room_messages_pinned ON room_messages(room_id, pinned_at) WHERE pinned_at IS NOT NULL;

-- What each user has read of a room, and since when it waits for their reply.
CREATE TABLE room_reads (
  room_id TEXT NOT NULL REFERENCES rooms(id), user TEXT NOT NULL,
  last_seq INTEGER NOT NULL DEFAULT 0, waiting_since INTEGER,
  PRIMARY KEY (room_id, user)
);

-- The user's messages not yet handed to the brain as a turn (decision #16):
-- the typing debounce accumulates here, plan 02 consumes it. message_ids_json
-- is a JSON array in send order.
CREATE TABLE room_pending (
  room_id TEXT NOT NULL REFERENCES rooms(id), user TEXT NOT NULL,
  message_ids_json TEXT NOT NULL, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL,
  -- 1: a message was sent with "send now" (Cmd+Enter) and skips the debounce.
  immediate INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (room_id, user)
);

-- Threads under a message (plan 06): a worker's progress, its team's talk
-- and its questions, under the message that handed the work out.
CREATE TABLE threads (
  id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id),
  anchor_message_id TEXT NOT NULL, created_at INTEGER NOT NULL, closed_at INTEGER
);

-- Faces the brain speaks through (plan 10); only the host, seeded with the schema.
CREATE TABLE faces (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, bio TEXT NOT NULL DEFAULT '', tone TEXT NOT NULL DEFAULT '',
  avatar TEXT, color TEXT, created_at INTEGER NOT NULL
);

-- Files sent into rooms, kept by the gateway (it has no node to keep them
-- on) under PIRC_UPLOADS_DIR/<storage_name>, with the session uploads' rules:
-- kind 'image' (sniffed) or 'file' (named). message_id: the message that
-- carries it, once sent. Nothing deletes them yet (no retention).
CREATE TABLE room_uploads (
  id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), user TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'file')), filename TEXT,
  mime_type TEXT NOT NULL, byte_size INTEGER NOT NULL, sha256 TEXT NOT NULL,
  storage_name TEXT NOT NULL UNIQUE,
  message_id TEXT REFERENCES room_messages(id), created_at INTEGER NOT NULL
);
CREATE INDEX room_uploads_room ON room_uploads(room_id);

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

-- Open loops (plans/rewrite/04-open-loops.md): what is still open between
-- the brain and the people, always in its prompt. owner_user: whose it is
-- (the turn's first speaker), where it goes when demoted. origin: 'user' or
-- 'tool:<source>', worked out by the gateway. anchor_json: none, a time
-- {at, zone, autoClose, passed?} or a recurrence {cron, zone, until?, nextAt};
-- due_at: when its anchor fires next while open (NULL: none, or passed);
-- notice_at: the day before an autoClose time, while still to come.
-- closed_reason: the brain's words, the person's, or 'elapsed',
-- 'recurrence_ended' or 'demoted'.
CREATE TABLE open_loops (
  id TEXT PRIMARY KEY, owner_user TEXT NOT NULL, room_id TEXT, face_id TEXT,
  what TEXT NOT NULL, why TEXT NOT NULL DEFAULT '',
  origin TEXT NOT NULL, anchor_json TEXT, next_check TEXT,
  status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
  closed_reason TEXT, closed_at INTEGER,
  created_at INTEGER NOT NULL, last_touched_at INTEGER NOT NULL,
  source_entry_ids_json TEXT NOT NULL DEFAULT '[]', due_at INTEGER,
  notice_at INTEGER
);
CREATE INDEX open_loops_status ON open_loops(status, last_touched_at);
CREATE INDEX open_loops_due ON open_loops(due_at) WHERE status = 'open';

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

-- Sources (plans/rewrite/09-sources.md): read-only connectors the gateway
-- polls (email over IMAP, calendars as ICS or CalDAV, Moodle's web service
-- API, a workspace's git history). config_json never holds a credential:
-- passwords, tokens and ICS addresses live in $PIRC_STATE_DIR/sources/
-- secrets.json. owner_user: who added it (whom its wakes are for).
-- cursor_json: where the last poll got to (NULL: never polled; the first
-- poll only takes a baseline). failures: polls failed in a row; noted_at:
-- when the room was told it cannot be read (once, until a poll succeeds).
CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('email', 'calendar', 'moodle', 'workspace')),
  name TEXT NOT NULL, owner_user TEXT NOT NULL, config_json TEXT NOT NULL DEFAULT '{}',
  paused_at INTEGER, cursor_json TEXT, last_polled_at INTEGER, last_error TEXT,
  failures INTEGER NOT NULL DEFAULT 0, noted_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

-- What the polls saw: one row per message, event, deadline, notification or
-- commit (updated in place when it changes), searchable, origin
-- 'tool:<source_id>'. Only headers and times: no message bodies.
CREATE TABLE source_items (
  id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('message', 'event', 'assignment', 'notification', 'commit')),
  title TEXT NOT NULL, who TEXT, at INTEGER, summary TEXT NOT NULL DEFAULT '', url TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE (source_id, external_id)
);
CREATE INDEX source_items_at ON source_items(source_id, at);
CREATE VIRTUAL TABLE source_items_fts USING fts5(
  id UNINDEXED, terms,
  tokenize = 'porter unicode61 remove_diacritics 0'
);
