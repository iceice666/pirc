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

-- The assistant's memory (daemon/memory.ts).
CREATE TABLE memory_entries (
  id TEXT PRIMARY KEY, owner_user TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL,
  status TEXT NOT NULL, revision INTEGER NOT NULL, origins_json TEXT NOT NULL,
  sources_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  -- Creation provenance is immutable even when later revisions come from other chats.
  created_by_session TEXT
);
CREATE INDEX memory_entries_owner ON memory_entries(owner_user, kind, status);
CREATE INDEX memory_entries_creator ON memory_entries(owner_user, created_by_session);
CREATE TABLE memory_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, owner_user TEXT NOT NULL, entry_id TEXT NOT NULL,
  revision INTEGER NOT NULL, op TEXT NOT NULL, content TEXT, origins_json TEXT NOT NULL,
  sources_json TEXT NOT NULL, actor TEXT NOT NULL, at INTEGER NOT NULL
);
CREATE INDEX memory_log_entry ON memory_log(entry_id, revision);
CREATE TABLE memory_tombstones (
  -- 'global' (Forget) refuses the text from then on.
  owner_user TEXT NOT NULL, scope_id TEXT NOT NULL DEFAULT 'global', content_hash TEXT NOT NULL,
  forgotten_at INTEGER NOT NULL,
  PRIMARY KEY (owner_user, scope_id, content_hash)
);

-- Tasks the assistant hands to other workspaces (daemon/delegations.ts).
CREATE TABLE delegations (
  id TEXT PRIMARY KEY, owner_user TEXT NOT NULL, assistant_session_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL, title TEXT NOT NULL, task TEXT NOT NULL, follows TEXT,
  status TEXT NOT NULL, target_session_id TEXT, result TEXT, notified_status TEXT,
  expires_at INTEGER NOT NULL, dispatched_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  -- The model (and thinking level) it runs on, and the role its new session starts in.
  model_json TEXT, thinking TEXT, role TEXT,
  -- 1: the user approved it as their own request for auto mode, for the run it starts.
  as_user_request INTEGER NOT NULL DEFAULT 0,
  -- How it started: 'approved' (the user's card), 'auto' (the chat's delegation
  -- approval policy), NULL before it started. The origins of the chat's context
  -- the agent reported (JSON array), and the user's own words it verified
  -- (quote, JSON array of their message entry ids).
  dispatch TEXT, origins_json TEXT, quote TEXT, quote_entry_ids TEXT
);
CREATE INDEX delegations_owner ON delegations(owner_user, status);
CREATE INDEX delegations_follows ON delegations(follows);
CREATE INDEX delegations_assistant ON delegations(assistant_session_id, status);
CREATE INDEX delegations_target ON delegations(target_session_id, status);

-- Workspace memory mirrored from the nodes (daemon/memory-records.ts).
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
  PRIMARY KEY (node_id, ledger_key, id)
);
CREATE INDEX memory_records_owner ON memory_records(owner_user, status);
CREATE INDEX memory_records_id ON memory_records(id);

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

-- Threads under a message (plan 06); created here, unused until then.
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
-- on): name and type as sniffed, the file under <state>/room-uploads/<id>.
CREATE TABLE room_uploads (
  id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), user TEXT NOT NULL,
  name TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL,
  message_id TEXT REFERENCES room_messages(id), created_at INTEGER NOT NULL
);
CREATE INDEX room_uploads_room ON room_uploads(room_id);
