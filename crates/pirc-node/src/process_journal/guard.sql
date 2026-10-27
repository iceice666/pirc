-- Earlier launches have no trusted pre-execution gate evidence.
ALTER TABLE sandbox_launches ADD COLUMN guard_state TEXT NOT NULL DEFAULT 'untracked'
 CHECK(guard_state IN ('untracked','waiting','released','denied'));
CREATE INDEX sandbox_guard_pending ON sandbox_launches(session_id,created_at) WHERE guard_state='waiting';
CREATE TRIGGER sandbox_guard_monotonic BEFORE UPDATE OF guard_state ON sandbox_launches
WHEN NEW.guard_state!=OLD.guard_state AND NOT (OLD.guard_state='waiting' AND NEW.guard_state IN ('released','denied')) BEGIN
 SELECT RAISE(ABORT,'Sandbox launch guard cannot be reset');
END;
