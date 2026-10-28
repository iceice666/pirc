-- Origin paths are coordination metadata, never permission to access files.
-- Missing pre-2016 snapshots stay unknown; do not infer from mutable workspaces.
CREATE TABLE host_command_resources (
 run_id TEXT PRIMARY KEY REFERENCES host_command_runs(id),
 paths_json TEXT NOT NULL CHECK(json_valid(paths_json) AND json_type(paths_json)='array')
);
CREATE TRIGGER host_resources_immutable BEFORE UPDATE ON host_command_resources BEGIN
 SELECT RAISE(ABORT,'Host resource origins are immutable');
END;
CREATE TRIGGER host_resources_retained BEFORE DELETE ON host_command_resources BEGIN
 SELECT RAISE(ABORT,'Host resource origins are retained');
END;
CREATE INDEX host_commands_pending ON host_command_runs(id)
 WHERE state IN ('launching','running','unconfirmed');
