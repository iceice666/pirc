-- One global-memory cleanup per project deletion. No copied text or decisions.
CREATE TABLE project_memory_cleanup (
 workspace_id TEXT PRIMARY KEY REFERENCES workspace_deletions(workspace_id),
 owner_user TEXT NOT NULL,
 version INTEGER NOT NULL CHECK(version=1),
 completed_at INTEGER NOT NULL
);
-- Preserve the selected project cleanup semantics if a standalone chat deletion
-- overlaps or retries after the project request; never rerun creator-based purge.
CREATE TABLE project_memory_cleanup_sessions (
 session_id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES project_memory_cleanup(workspace_id)
);
