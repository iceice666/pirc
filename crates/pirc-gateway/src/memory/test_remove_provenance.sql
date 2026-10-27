-- Test-only reconstruction of schemas before 1023.
DROP TRIGGER memory_version_context_immutable;
DROP TRIGGER memory_proposal_context_immutable;
DROP TRIGGER memory_version_context_scrub;
DROP TRIGGER memory_proposal_context_scrub;
DROP TABLE memory_version_contexts;
DROP TABLE memory_proposal_contexts;
