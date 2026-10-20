-- Three-layer memory (plans/rewrite/03-memory.md) and its search index
-- (plans/memory-search.md phase 1).

-- Facts: one table for a repository's notes (mirrored from the nodes) and
-- the household's facts, which the brain writes (scope 'person'; node_id ''
-- and ledger_key 'person'). origin is who it came from: 'user', 'tool:<source>',
-- 'tool:delegation' or 'om:promoted'; source_entry_ids_json the brain's
-- session entries (or observations) behind it. Room and face are labels.
ALTER TABLE memory_records ADD COLUMN scope TEXT NOT NULL DEFAULT 'repo' CHECK (scope IN ('repo', 'person'));
ALTER TABLE memory_records ADD COLUMN room_id TEXT;
ALTER TABLE memory_records ADD COLUMN face_id TEXT;
ALTER TABLE memory_records ADD COLUMN origin TEXT;
ALTER TABLE memory_records ADD COLUMN source_entry_ids_json TEXT;
ALTER TABLE memory_records ADD COLUMN created_at INTEGER;
CREATE INDEX memory_records_scope ON memory_records(owner_user, scope, status);

-- Preferences: the USER entries of the old assistant memory, small and in
-- the brain's prompt. created_in_room: the room the person said it in.
CREATE TABLE preferences (
  id TEXT PRIMARY KEY, owner_user TEXT NOT NULL, content TEXT NOT NULL,
  status TEXT NOT NULL, revision INTEGER NOT NULL, origins_json TEXT NOT NULL,
  sources_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  created_in_room TEXT
);
CREATE INDEX preferences_owner ON preferences(owner_user, status);
INSERT INTO preferences (id, owner_user, content, status, revision, origins_json, sources_json, created_at, updated_at)
  SELECT id, owner_user, content, status, revision, origins_json, sources_json, created_at, updated_at
  FROM memory_entries WHERE kind = 'user';
-- MEMORY notes become the person's facts.
INSERT INTO memory_records (node_id, ledger_key, id, content, relevance, recorded_at, source_ids_json,
    origins_json, owner_user, status, scope, origin, created_at)
  SELECT '', 'person', id, content, 'medium', strftime('%Y-%m-%d %H:%M', created_at / 1000, 'unixepoch', 'localtime'),
    '[]', origins_json, owner_user, CASE status WHEN 'active' THEN 'active' ELSE 'forgotten' END,
    'person', CASE WHEN origins_json LIKE '%"user"%' THEN 'user' ELSE 'tool:assistant' END, created_at
  FROM memory_entries WHERE kind = 'note';
DROP TABLE memory_entries;

-- Tombstones refuse forgotten text; there are no project scopes any more.
CREATE TABLE memory_tombstones_new (
  owner_user TEXT NOT NULL, content_hash TEXT NOT NULL, forgotten_at INTEGER NOT NULL,
  PRIMARY KEY (owner_user, content_hash)
);
INSERT OR IGNORE INTO memory_tombstones_new (owner_user, content_hash, forgotten_at)
  SELECT owner_user, content_hash, forgotten_at FROM memory_tombstones WHERE scope_id = 'global';
DROP TABLE memory_tombstones;
ALTER TABLE memory_tombstones_new RENAME TO memory_tombstones;

-- The search index (memory/text.rs index_terms), kept by the gateway's own
-- writes; rebuilt at startup when search_index_meta.version is not the
-- gateway's SEARCH_INDEX_VERSION.
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
