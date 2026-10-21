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
