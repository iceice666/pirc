-- Commands retain the configured environment they were admitted against.
-- No backfill: an old command row cannot prove a historical environment.
CREATE TABLE command_environments (
 command_id TEXT PRIMARY KEY REFERENCES commands(id) ON DELETE CASCADE,
 binding_json TEXT NOT NULL CHECK(json_valid(binding_json) AND COALESCE(json_extract(binding_json,'$.version')=1,0))
);
CREATE TRIGGER command_environment_immutable BEFORE UPDATE ON command_environments BEGIN
 SELECT RAISE(ABORT,'Command environments are immutable');
END;
