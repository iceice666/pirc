-- Tests only: reconstruct pre-2016 schema.
DROP TRIGGER host_resources_immutable;
DROP TRIGGER host_resources_retained;
DROP TABLE host_command_resources;
DROP INDEX host_commands_pending;
-- Test fixtures only: reconstruct the pre-2015 schema before migration.
DROP TRIGGER host_command_identity;
DROP TRIGGER host_command_terminal;
DROP TRIGGER host_command_retained;
DROP TABLE host_command_runs;
