-- Tests only: reconstruct pre-2016 schema.
DROP TRIGGER host_resources_immutable;
DROP TRIGGER host_resources_retained;
DROP TABLE host_command_resources;
DROP INDEX host_commands_pending;
