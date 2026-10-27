-- Retry identity/predecessor only. Immutable input/files stay in the parent intent.
CREATE TABLE conversation_submission_retry_attempts (
 owner_user TEXT NOT NULL, operation_id TEXT NOT NULL, retry_id TEXT NOT NULL,
 command_id TEXT NOT NULL UNIQUE, previous_command_id TEXT NOT NULL,
 attempt_number INTEGER NOT NULL CHECK(attempt_number>0),
 created_at INTEGER NOT NULL,
 PRIMARY KEY(owner_user,operation_id,retry_id),
 UNIQUE(owner_user,operation_id,attempt_number),
 FOREIGN KEY(owner_user,operation_id) REFERENCES conversation_submissions(owner_user,operation_id),
 CHECK(command_id!=previous_command_id)
);
