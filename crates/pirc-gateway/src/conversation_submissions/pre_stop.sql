-- This lease authorizes only pre-allocation first-input Stop, never Node commands.
CREATE TABLE conversation_submission_stop_controls (
 owner_user TEXT NOT NULL, operation_id TEXT NOT NULL,
 client_id TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation>0),
 expires_at INTEGER NOT NULL,
 PRIMARY KEY(owner_user,operation_id),
 FOREIGN KEY(owner_user,operation_id) REFERENCES conversation_submissions(owner_user,operation_id)
);
-- The narrowly authorized Stop survives device loss and Gateway restart.
CREATE TABLE conversation_submission_pending_stops (
 owner_user TEXT NOT NULL, operation_id TEXT NOT NULL,
 node_id TEXT NOT NULL, node_operation_id TEXT NOT NULL,
 local_workspace_id TEXT NOT NULL, submission_hash TEXT NOT NULL,
 created_at INTEGER NOT NULL, last_attempt_at INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(owner_user,operation_id),
 FOREIGN KEY(owner_user,operation_id) REFERENCES conversation_submissions(owner_user,operation_id)
);
CREATE TRIGGER submission_pre_stop_cancelled AFTER UPDATE OF state ON conversation_submissions
 WHEN NEW.state='cancelled' BEGIN
 DELETE FROM conversation_submission_pending_stops WHERE owner_user=NEW.owner_user AND operation_id=NEW.operation_id;
 DELETE FROM conversation_submission_stop_controls WHERE owner_user=NEW.owner_user AND operation_id=NEW.operation_id;
END;
