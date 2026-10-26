-- The cancellation may precede allocation. This identity permanently fences
-- delayed creation/transfer/admission without allocating a replacement session.
CREATE TABLE creation_cancellations (
 owner_user TEXT NOT NULL, operation_id TEXT NOT NULL,
 workspace_id TEXT NOT NULL, submission_hash TEXT NOT NULL,
 session_id TEXT, complete INTEGER NOT NULL DEFAULT 0 CHECK(complete IN (0,1)),
 last_error_code TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 PRIMARY KEY(owner_user,operation_id)
);
