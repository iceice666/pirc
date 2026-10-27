-- A transition's admission fence survives process/reply loss. It is not proof
-- of OS revocation or installation. Keep a tombstone after session deletion.
CREATE TABLE execution_fences (
 owner_user TEXT NOT NULL,
 operation_id TEXT NOT NULL,
 session_id TEXT NOT NULL,
 intent_json TEXT NOT NULL CHECK(json_valid(intent_json)),
 state TEXT NOT NULL CHECK(state IN ('fenced','stopping','blocked','supervisor_drained','deleted')),
 error_code TEXT,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 PRIMARY KEY(owner_user,operation_id)
);
CREATE UNIQUE INDEX execution_fence_active ON execution_fences(session_id) WHERE state!='deleted';
CREATE TRIGGER execution_fence_identity BEFORE UPDATE OF owner_user,operation_id,session_id,intent_json,created_at ON execution_fences BEGIN
 SELECT RAISE(ABORT,'Execution fence identity is immutable');
END;
CREATE TRIGGER execution_fence_retained BEFORE DELETE ON execution_fences BEGIN
 SELECT RAISE(ABORT,'Execution fences are retained for reconciliation');
END;
CREATE TRIGGER execution_fence_session_deleted AFTER DELETE ON sessions BEGIN
 UPDATE execution_fences SET state='deleted',error_code=NULL WHERE session_id=OLD.id;
END;
