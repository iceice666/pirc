-- No historical backfill: current membership cannot prove a past write's origin.
CREATE TABLE memory_version_contexts (
 log_seq INTEGER PRIMARY KEY REFERENCES memory_log(seq) ON DELETE CASCADE,
 origin_json TEXT NOT NULL CHECK(json_valid(origin_json) AND COALESCE(json_extract(origin_json,'$.version')=1,0))
);
CREATE TABLE memory_proposal_contexts (
 proposal_id TEXT PRIMARY KEY REFERENCES memory_proposals(id) ON DELETE CASCADE,
 origin_json TEXT NOT NULL CHECK(json_valid(origin_json) AND COALESCE(json_extract(origin_json,'$.version')=1,0))
);
CREATE TRIGGER memory_version_context_immutable BEFORE UPDATE ON memory_version_contexts BEGIN
 SELECT RAISE(ABORT,'Memory version origins are immutable');
END;
CREATE TRIGGER memory_proposal_context_immutable BEFORE UPDATE ON memory_proposal_contexts BEGIN
 SELECT RAISE(ABORT,'Memory proposal origins are immutable');
END;
-- Redaction and forgetting erase origin snapshots along with their source data.
CREATE TRIGGER memory_version_context_scrub AFTER UPDATE OF content ON memory_log
 WHEN NEW.content IS NULL BEGIN
 DELETE FROM memory_version_contexts WHERE log_seq=NEW.seq;
END;
CREATE TRIGGER memory_proposal_context_scrub AFTER UPDATE OF quote,sources_json ON memory_proposals
 WHEN NEW.quote='' AND NEW.sources_json='{}' BEGIN
 DELETE FROM memory_proposal_contexts WHERE proposal_id=NEW.id;
END;
