-- Origins describe saved bytes, not a new grant. Existing uploads are not
-- backfilled from current workspace/session associations.
CREATE TABLE upload_origins (
 upload_id TEXT PRIMARY KEY REFERENCES uploads(id) ON DELETE CASCADE,
 version INTEGER NOT NULL CHECK(version=1),
 scope TEXT NOT NULL CHECK(scope IN ('workspace','conversation','legacy_owner')),
 node_id TEXT,
 mode_id TEXT,
 upload_json TEXT NOT NULL CHECK(json_valid(upload_json))
);
CREATE TRIGGER upload_origin_capture AFTER INSERT ON uploads BEGIN
 INSERT INTO upload_origins(upload_id,version,scope,node_id,mode_id,upload_json)
 SELECT NEW.id,1,
  CASE WHEN EXISTS(SELECT 1 FROM creation_uploads WHERE upload_id=NEW.id)
       THEN 'conversation' WHEN NEW.workspace_id IS NULL THEN 'legacy_owner' ELSE 'workspace' END,
  (SELECT host_id FROM workspaces WHERE id=NEW.workspace_id),
  (SELECT kind FROM workspaces WHERE id=NEW.workspace_id),
  json_object('id',NEW.id,'ownerUser',NEW.owner_user,'mimeType',NEW.mime_type,
   'byteSize',NEW.byte_size,'storageName',NEW.storage_name,'sha256',NEW.sha256,
   'kind',NEW.kind,'filename',NEW.filename,'workspaceId',NEW.workspace_id,'sessionId',NEW.session_id);
END;
CREATE TRIGGER upload_origin_immutable BEFORE UPDATE ON upload_origins BEGIN
 SELECT RAISE(ABORT,'Upload origins are immutable');
END;
CREATE TRIGGER upload_origin_remove BEFORE DELETE ON upload_origins
 WHEN EXISTS(SELECT 1 FROM uploads WHERE id=OLD.upload_id) BEGIN
 SELECT RAISE(ABORT,'Remove an upload through its owning record');
END;
CREATE TRIGGER upload_record_immutable BEFORE UPDATE ON uploads
 WHEN EXISTS(SELECT 1 FROM upload_origins WHERE upload_id=OLD.id) BEGIN
 SELECT RAISE(ABORT,'Saved upload content and scope are immutable');
END;
