-- A pre-admission Stop can arrive before a creation has a Node session ID.
-- This is an execution fence, not a creation/deletion record. It holds no text,
-- credentials or files, and duplicates never abort later user work.
CREATE TABLE creation_pre_stops (
 owner_user TEXT NOT NULL, operation_id TEXT NOT NULL,
 workspace_id TEXT NOT NULL, submission_hash TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 PRIMARY KEY(owner_user, operation_id)
);
