-- One durable identity per actual spawn attempt, retained across deletion. An
-- absent supervisor is never proof of termination of this launch's descendants.
CREATE TABLE sandbox_launches (
 launch_id TEXT PRIMARY KEY,
 session_id TEXT NOT NULL,
 workspace_id TEXT NOT NULL,
 runner_epoch INTEGER NOT NULL,
 incarnation TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('launching','running','unconfirmed','terminated','not_started','legacy_untracked')),
 identity_json TEXT CHECK(identity_json IS NULL OR json_valid(identity_json)),
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 UNIQUE(session_id,runner_epoch),
 CHECK(state!='terminated' OR identity_json IS NOT NULL),
 CHECK(state!='not_started' OR identity_json IS NULL)
);
CREATE INDEX sandbox_launches_pending ON sandbox_launches(session_id,updated_at)
 WHERE state IN ('running','unconfirmed','launching') AND identity_json IS NOT NULL;
CREATE TRIGGER sandbox_launch_identity BEFORE UPDATE OF launch_id,session_id,workspace_id,runner_epoch,incarnation,created_at ON sandbox_launches BEGIN
 SELECT RAISE(ABORT,'Sandbox launch identity is immutable');
END;
CREATE TRIGGER sandbox_kernel_identity BEFORE UPDATE OF identity_json ON sandbox_launches
WHEN OLD.identity_json IS NOT NULL AND NEW.identity_json IS NOT OLD.identity_json BEGIN
 SELECT RAISE(ABORT,'Sandbox kernel identity is immutable');
END;
CREATE TRIGGER sandbox_launch_terminal BEFORE UPDATE OF state ON sandbox_launches
WHEN OLD.state IN ('terminated','not_started','legacy_untracked') AND NEW.state!=OLD.state BEGIN
 SELECT RAISE(ABORT,'Sandbox launch terminal evidence is immutable');
END;
CREATE TRIGGER sandbox_launch_retained BEFORE DELETE ON sandbox_launches BEGIN
 SELECT RAISE(ABORT,'Sandbox launch evidence is retained');
END;
-- Historical epochs lack kernel evidence. Never manufacture clean history from
-- an empty table or from runner_state='failed' during an upgrade.
INSERT INTO sandbox_launches
 SELECT 'legacy:'||id,id,workspace_id,runner_epoch,'legacy','legacy_untracked',NULL,updated_at,updated_at
 FROM sessions WHERE runner_epoch>0;
