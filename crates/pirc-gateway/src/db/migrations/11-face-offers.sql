-- A workspace no face looks after is offered one once, in #general, when
-- its node first brings it (brain/faces.rs `offer_faces`). offered_at: when.
CREATE TABLE face_offers (
  workspace_id TEXT PRIMARY KEY, offered_at INTEGER NOT NULL
);
