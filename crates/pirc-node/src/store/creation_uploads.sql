-- Immutable transfer identities survive session/project deletion, like creations.
-- Reserve the storage name before file I/O; ready commits with the ordinary upload.
CREATE TABLE creation_uploads (
 owner_user TEXT NOT NULL, operation_id TEXT NOT NULL, attachment_id TEXT NOT NULL,
 session_id TEXT NOT NULL, upload_id TEXT NOT NULL UNIQUE,
 request_hash TEXT NOT NULL, upload_json TEXT CHECK(upload_json IS NULL OR json_valid(upload_json)),
 state TEXT NOT NULL CHECK(state IN ('reserved','ready','deleted')), created_at INTEGER NOT NULL,
 CHECK((state='deleted' AND upload_json IS NULL) OR (state!='deleted' AND upload_json IS NOT NULL)),
 PRIMARY KEY(owner_user,operation_id,attachment_id)
);
CREATE INDEX creation_uploads_session ON creation_uploads(session_id);
