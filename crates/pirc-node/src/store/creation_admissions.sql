-- One first-message command identity per durable creation. Hashes/stop fences
-- survive deletion; user text stays in the existing command/session stores.
CREATE TABLE creation_initial_admissions (
 owner_user TEXT NOT NULL, operation_id TEXT NOT NULL,
 session_id TEXT NOT NULL UNIQUE, command_id TEXT UNIQUE, input_hash TEXT,
 stop_requested INTEGER NOT NULL DEFAULT 0 CHECK(stop_requested IN (0,1)),
 stop_confirmed INTEGER NOT NULL DEFAULT 0 CHECK(stop_confirmed IN (0,1)),
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 PRIMARY KEY(owner_user,operation_id),
 CHECK((command_id IS NULL)=(input_hash IS NULL)),
 CHECK(stop_confirmed<=stop_requested)
);
