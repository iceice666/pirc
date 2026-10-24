-- pots checkpoint: durable tracking only; no dispatch/session side effects.
CREATE TABLE pots_responsibilities (
 id TEXT PRIMARY KEY, owner_user TEXT NOT NULL, create_key TEXT NOT NULL, create_spec TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision > 0), generation INTEGER NOT NULL CHECK(generation > 0),
 data TEXT NOT NULL CHECK(json_valid(data)), UNIQUE(id,owner_user), UNIQUE(owner_user,create_key)
);
CREATE INDEX pots_responsibilities_owner ON pots_responsibilities(owner_user,id);
CREATE TABLE pots_suggestions (
 id TEXT PRIMARY KEY, owner_user TEXT NOT NULL, responsibility_id TEXT NOT NULL,
 condition_key TEXT NOT NULL, occurrence_key TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision > 0), data TEXT NOT NULL CHECK(json_valid(data)),
 FOREIGN KEY(responsibility_id,owner_user) REFERENCES pots_responsibilities(id,owner_user),
 UNIQUE(owner_user,condition_key,occurrence_key), UNIQUE(id,owner_user)
);
CREATE INDEX pots_suggestions_owner ON pots_suggestions(owner_user,id);
CREATE TABLE pots_tasks (
 id TEXT PRIMARY KEY, owner_user TEXT NOT NULL, origin_suggestion_id TEXT NOT NULL UNIQUE,
 revision INTEGER NOT NULL CHECK(revision > 0), generation INTEGER NOT NULL CHECK(generation > 0),
 data TEXT NOT NULL CHECK(json_valid(data)),
 FOREIGN KEY(origin_suggestion_id,owner_user) REFERENCES pots_suggestions(id,owner_user)
);
CREATE INDEX pots_tasks_owner ON pots_tasks(owner_user,id);
CREATE TRIGGER pots_task_origin_immutable BEFORE UPDATE ON pots_tasks
 WHEN NEW.origin_suggestion_id != OLD.origin_suggestion_id OR NEW.owner_user != OLD.owner_user
 BEGIN SELECT RAISE(ABORT,'immutable task origin'); END;
