-- First-message delivery identities carry no extra prompt or file contents.
-- commands is the existing receipt mirror; this fence survives its deletion.
CREATE TABLE conversation_submission_dispatches (
 owner_user TEXT NOT NULL,operation_id TEXT NOT NULL,command_id TEXT NOT NULL UNIQUE,
 input_hash TEXT,
 state TEXT NOT NULL CHECK(state IN ('dispatched','accepted','rejected','outcome_unknown','stopping','stopped','cancelled')),
 outcome TEXT NOT NULL CHECK(outcome IN ('pending','admitted','not_admitted','outcome_unknown')),
 stop_requested INTEGER NOT NULL DEFAULT 0 CHECK(stop_requested IN (0,1)),
 stop_confirmed INTEGER NOT NULL DEFAULT 0 CHECK(stop_confirmed IN (0,1)),
 admitted_at INTEGER, last_error_code TEXT,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 PRIMARY KEY(owner_user,operation_id),
 FOREIGN KEY(owner_user,operation_id) REFERENCES conversation_submissions(owner_user,operation_id),
 CHECK(stop_confirmed<=stop_requested)
);
CREATE TRIGGER submission_dispatch_cancelled AFTER UPDATE OF state ON conversation_submissions
 WHEN NEW.state='cancelled' BEGIN
 UPDATE conversation_submission_dispatches SET state='cancelled',last_error_code=NULL,updated_at=NEW.updated_at
 WHERE owner_user=NEW.owner_user AND operation_id=NEW.operation_id;
END;
