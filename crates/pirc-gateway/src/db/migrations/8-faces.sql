-- Faces (plans/rewrite/10-faces.md): the names the brain speaks through.
-- role_md is what the face does (its instructions); territory_json holds the
-- rooms it answers in and the sources it watches ({"rooms": [...],
-- "sources": [...]}); the workspaces it is about are its project_links.
-- Exactly one face is the host (is_host), seeded with the schema; it is
-- never archived. An archived face stays listed, greyed out, until someone
-- hides it (hidden_at; decision #18).
ALTER TABLE faces ADD COLUMN role_md TEXT NOT NULL DEFAULT '';
ALTER TABLE faces ADD COLUMN territory_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE faces ADD COLUMN is_host INTEGER NOT NULL DEFAULT 0;
ALTER TABLE faces ADD COLUMN archived_at INTEGER;
ALTER TABLE faces ADD COLUMN hidden_at INTEGER;
UPDATE faces SET is_host = 1 WHERE id = 'host';
CREATE UNIQUE INDEX faces_one_host ON faces(is_host) WHERE is_host = 1;

-- Links belong to faces now, not to chat projects (gone in plan 00). Nothing
-- in this database ever wrote a project's link (the chat projects lived in
-- the old gateway.sqlite, which stays where it was), so the table is empty
-- and is made again with its new owner.
DROP TABLE project_links;
CREATE TABLE project_links (
  face_id TEXT NOT NULL REFERENCES faces(id), workspace_id TEXT NOT NULL,
  repo TEXT, created_at INTEGER NOT NULL,
  PRIMARY KEY (face_id, workspace_id)
);

-- Topics (decision #18): the brain tags what a turn was about with its
-- `topic` tool; the turn's messages carry the name. room_topics keeps
-- what each topic touches (a workspace or a source, as the brain said) and
-- when moving it elsewhere was last suggested (once a day at most, decision
-- #11). hint_room_id: the room the next turn's host is asked to suggest.
ALTER TABLE room_messages ADD COLUMN topic TEXT;
CREATE INDEX room_messages_topic ON room_messages(room_id, topic) WHERE topic IS NOT NULL;
CREATE TABLE room_topics (
  room_id TEXT NOT NULL REFERENCES rooms(id), name TEXT NOT NULL,
  workspace_id TEXT, source_id TEXT, updated_at INTEGER NOT NULL,
  suggested_at INTEGER, hint_room_id TEXT REFERENCES rooms(id),
  PRIMARY KEY (room_id, name)
);
