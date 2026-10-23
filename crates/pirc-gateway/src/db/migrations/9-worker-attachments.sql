-- Files a room message carried travel with the worker the brain called for
-- it (plans/rewrite/06-workers.md): the gateway keeps what the room's uploads
-- said of each ([{id, kind, filename, mimeType, byteSize}]), copies the bytes
-- to the worker's node session when it starts, and delivers their node ids, so
-- the node puts them in the agent's .pirc/uploads.
ALTER TABLE delegations ADD COLUMN attachments_json TEXT;
