-- A missing client nonce can be retired without creating or executing a command.
-- Keep identity-only tombstones with the parent intent so delayed requests cannot revive it.
CREATE TABLE conversation_submission_retry_retirements (
 owner_user TEXT NOT NULL, operation_id TEXT NOT NULL, retry_id TEXT NOT NULL,
 previous_command_id TEXT NOT NULL, retired_at INTEGER NOT NULL,
 PRIMARY KEY(owner_user,operation_id,retry_id),
 FOREIGN KEY(owner_user,operation_id) REFERENCES conversation_submissions(owner_user,operation_id)
);
