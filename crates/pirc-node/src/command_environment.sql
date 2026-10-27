-- Trusted Gateway intent, immutable for the life of this command. Old commands
-- have no invented origin; no environment is inferred from today's workspace.
CREATE TABLE command_environments (
 command_id TEXT PRIMARY KEY REFERENCES commands(id) ON DELETE CASCADE,
 binding_json TEXT NOT NULL CHECK(json_valid(binding_json))
);
CREATE TRIGGER command_environment_immutable BEFORE UPDATE ON command_environments BEGIN
 SELECT RAISE(ABORT,'Command environments are immutable');
END;
