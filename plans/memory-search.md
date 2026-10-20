# Workspace-memory search quality

[Plans](README.md) · [Assistant memory](../docs/architecture/assistant-memory.md)

Goal: `memory_search` finds the notes and delegation reports a chat is looking for, including Chinese queries without spaces and paraphrases, without changing who can see what. The gateway stays on SQLite.

This file is the work queue for the change, not authorization: each phase needs the user's go-ahead. Phase 2 also needs a decision on where embeddings come from, because it sends note text to an embeddings endpoint.

## Today

`crates/pirc-gateway/src/memory_records.rs` `search_in` → `find_hits`:

- The query is folded (`memory/text.rs` `fold`: NFKC + lowercase), split on JavaScript whitespace (`words`), deduplicated and cut to 8 terms (`MAX_TERMS`).
- Each term becomes `content LIKE '%term%'` (and `title || task || result` for delegations), joined with `OR`, inside the owner/status/scope filter.
- Hits are ranked by how many distinct terms appear, then active before superseded, then newest. Up to 20 are returned (8 by default), each clipped to 600 characters (`HIT_CHARS`).

Weaknesses this plan addresses:

1. **CJK without spaces.** `資料庫遷移問題` is one term, so only notes that contain that exact string match.
2. **No term weighting.** A common word counts the same as a rare one. Term frequency and note length are ignored.
3. **No semantics.** `db migration` does not find `資料庫遷移`, and synonyms never match.

Scope, ownership, the linked-workspaces-first fallback (`Searched`), the `everywhere` flag, unknown-owner exclusion and the per-node quota (`NODE_MAX_ROWS`, `NODE_MAX_BYTES`) stay as they are in every phase.

## Rejected alternatives

- **PostgreSQL + pgvector.** It would replace the whole synchronous rusqlite store (`db.rs`, `schema.sql`, migrations, node store), the backup/restore procedure, `secure_delete` behavior and the NixOS module, all for a corpus of a few thousand notes. `tsvector` does not segment CJK without `pg_bigm` or zhparser either. It also breaks the "two native executables" deployment.
- **sqlite-vec now.** The project is still pre-v1. Its own tracker has recent cosine ±Inf ranking, delete and musl build issues (asg017/sqlite-vec #324, #301, #314). Registering it requires `unsafe { sqlite3_auto_extension(..) }` under the workspace's `unsafe_code = "forbid"`. Brute-force cosine in Rust is fast enough at this size. See "Revisit" below.
- **FTS5's `trigram` tokenizer.** It cannot match two-character Chinese words, which are the common case.
- **A bundled local embedding model.** It does not fit the gateway's 16 MiB size budget (`crates/size-budget.json`).

## Phase 0: evaluation set (prerequisite)

A fixed, synthetic corpus and query set, so each phase is measured rather than judged by feel.

- `crates/pirc-gateway/src/memory_records/eval/`: about 150 synthetic notes and delegations (English, Traditional Chinese, mixed, code identifiers and paths) and 30–40 queries with the ids that should be found. **No real user notes.**
- A `#[test]` that loads the corpus into a temp gateway database and reports recall@8 and MRR per query class (`en`, `zh`, `mixed`, `identifier`, `paraphrase`). It asserts a floor that each phase raises; it is not an exact snapshot.
- Record the `LIKE` baseline in this file before Phase 1 lands.

**Done 2026-10-20** (with plans/rewrite/03-memory.md, which adds the `recall` class: a user's whole message, as the brain's automatic recall sends it, against household facts). `crates/pirc-gateway/src/memory_records/eval/`: 121 notes, 47 queries; `cargo test -p pirc-gateway search_evaluation -- --nocapture` prints the table. Some expected hits are cross-language (an English query for a Chinese note) on purpose: no lexical search finds them, they measure Phase 2.

`LIKE` baseline:

| class      | queries | recall@8 | MRR  |
| ---------- | ------- | -------- | ---- |
| en         | 10      | 0.77     | 0.93 |
| zh         | 9       | 0.89     | 0.89 |
| mixed      | 6       | 1.00     | 0.92 |
| identifier | 10      | 1.00     | 1.00 |
| paraphrase | 5       | 0.80     | 0.75 |
| recall     | 7       | 0.36     | 0.43 |

`資料庫遷移問題` finds nothing (weakness 1); whole-sentence queries fill the top 8 with notes sharing `I`, `on`, `do`.

## Phase 1: FTS5 + BM25 with CJK bigrams

**Done 2026-10-20** with plans/rewrite/03-memory.md, in the new `pirc.sqlite` (schema 3, `db/migrations/3-memory.sql`, not "migration 1005"; the design below is otherwise what landed). Differences found on the evaluation set:

- The tokenizer is `porter unicode61 remove_diacritics 0`: without stemming, `erase` missed `erased` and `switch` missed `switched`.
- A spaceless run in a query is its pairs as separate phrases joined with `OR`, not one phrase: `資料庫遷移問題` as one phrase only finds that exact string, as `LIKE` did.
- Ranking: how many of the query's phrases a hit holds first, then BM25 scaled to each table's best match (raw BM25 of notes and delegations does not compare, so a one-word delegation outranked a two-word note), a superseded note counting half.
- The `LIKE` fallback stays, for words of three characters or more (or non-ASCII): short words (`I`, `on`) as substrings matched every note.
- Validation: `cargo test -p pirc-gateway` (segmentation, index rebuild on a version change, a forgotten fact's token gone from the file after a checkpoint, the migration from schema 1), conformance `memory`, `brain_memory`.

| class      | recall@8 | MRR  | (`LIKE`)    |
| ---------- | -------- | ---- | ----------- |
| en         | 0.80     | 0.93 | 0.77 / 0.93 |
| zh         | 1.00     | 1.00 | 0.89 / 0.89 |
| mixed      | 1.00     | 1.00 | 1.00 / 0.92 |
| identifier | 1.00     | 1.00 | 1.00 / 1.00 |
| paraphrase | 0.80     | 1.00 | 0.80 / 0.75 |
| recall     | 0.64     | 0.71 | 0.36 / 0.43 |

The remaining misses are cross-language (an English query for a Chinese note) or synonyms (`午餐` for `訂餐`): Phase 2's.

The bundled `libsqlite3-sys` 0.35 already compiles with `SQLITE_ENABLE_FTS5`, so no new dependencies are needed.

### Segmentation (`memory/text.rs`, new `search_terms`)

The same function prepares both indexed text and queries, so they cannot drift:

1. `fold` (unchanged: NFKC + lowercase).
2. Runs of Han, Hiragana, Katakana and Hangul become overlapping bigrams plus the run's last character alone (`資料庫` → `資料 料庫 庫`). Single characters are kept so a one-character query can match as a prefix (`庫*`).
3. Other text is passed through. FTS5's `unicode61` tokenizer (`remove_diacritics 0`, matching today's diacritic-sensitive `fold`) splits it on punctuation, so `foo_bar` and `src/db.rs` become word sequences.

The output is plain text for one FTS column. Changing the algorithm bumps a `SEARCH_INDEX_VERSION` constant, which causes a rebuild (see below).

### Schema (migration 1005)

```sql
CREATE VIRTUAL TABLE memory_records_fts USING fts5(
  node_id UNINDEXED, ledger_key UNINDEXED, id UNINDEXED, terms,
  tokenize = 'unicode61 remove_diacritics 0'
);
CREATE VIRTUAL TABLE delegations_fts USING fts5(
  id UNINDEXED, title, body,
  tokenize = 'unicode61 remove_diacritics 0'
);
CREATE TABLE search_index_meta (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), version INTEGER NOT NULL);
```

- Rows are keyed by the records' own keys, not `rowid`. `memory_records` has a composite primary key, so its `rowid` is not stable across `VACUUM`.
- Index maintenance happens in Rust, in the same transaction as each write, with no SQL triggers. The terms come from Rust, and a trigger calling a Rust function would break the documented `sqlite3` CLI repairs in [backup and recovery](../docs/deploy/backup-and-recovery.md).
- Write sites to cover:
  - `memory_records.rs`: ledger reset, re-fold delete, supersede, forget, forgotten-tombstone insert, active insert.
  - `db.rs`: `repo` backfill (no index change) and session/assistant deletes.
  - `project_deletion.rs`: delegations and records.
  - `delegations.rs`: insert, result update, retention delete.
  - Status-only updates need no index change, because status is filtered by joining the base table.
- **Rebuild at open:** after `migrate`, if `search_index_meta.version != SEARCH_INDEX_VERSION` (or the row is missing), clear both FTS tables and refill them from `memory_records` (`status IN ('active','superseded')`) and `delegations` in one transaction. Migration 1005 itself stays plain SQL like the others.

### Query

- `search_terms(query)` gives up to `MAX_TERMS` words. Each whitespace word becomes one FTS5 phrase: `"資料 料庫"`, or `"庫"*` for a lone CJK character. Every phrase is double-quoted with `"` escaped, so FTS5 syntax in user input is never interpreted.
- Phrases are joined with `OR`. Ranking is `bm25(memory_records_fts)`, and `bm25(delegations_fts, 2.0, 1.0)` weighting titles. Tie-breaks stay the same: active before superseded, then newest.
- Records join back to `memory_records` on `(node_id, ledger_key, id)` with today's owner, status and scope `WHERE` clauses unchanged. Delegations join on `id`. Records and delegations are merged by BM25 score (comparable enough at this size). Check the merge against the eval set and switch to rank interleaving if it skews.
- Open question, decided by the eval set: whether to fall back to today's `LIKE` when FTS returns nothing, for substring needs such as part of a hash or identifier.

### Forgetting and secure deletion

"Forget/clear records remove searchable content" must keep holding. FTS5 deletes only add delete markers, so old segments keep the tokens until a merge.

- After a forget, ledger reset, clear or project deletion, run `INSERT INTO memory_records_fts(memory_records_fts) VALUES('optimize')` (and the same for `delegations_fts`) in the same transaction. Cheap at this size.
- `secure_delete` (already on) then zeroes the freed pages.
- Extend the existing sentinel test in `db.rs` (around `secure_delete`) so a forgotten note's distinctive token is absent from the database file after the operation and a checkpoint.

### Docs and prompts

- `pirc-agent/prompts/tools/memory_search.md`: replace "Each word matches anywhere… notes holding more of the words come first" with the new behavior (words and Chinese phrases, ranked by relevance).
- Update `docs/architecture/assistant-memory.md` (the `LIKE` paragraph), the module comment at the top of `memory_records.rs`, and `CHANGELOG.md`.

### Validation

- `cargo test -p pirc-gateway memory_records` (existing tests plus segmentation unit tests: CJK runs, mixed scripts, quotes/FTS operators in queries, one-character queries).
- Eval set: recall@8/MRR at or above baseline for every class, and clearly better for `zh`.
- `cargo test -p pirc-conformance --test agent_assistant_ptc --test memory` (the `memory_search` request/response shapes and `Searched`).
- Migration tests in `db.rs`: 1004 → 1005, a fresh schema matching `schema.sql`, and an index rebuild when the version changes.
- Repo-wide `cargo fmt --check` / `cargo clippy` as CI runs them.

## Phase 2: optional semantic search (hybrid)

Off by default. Without configuration, search is exactly Phase 1.

### Embedding source (decision needed before starting)

An OpenAI-compatible `POST {base}/embeddings` called by the gateway only, like `web_search` and its `EXA_API_KEY`, so the key never reaches a node:

- `PIRC_EMBEDDINGS_URL`, `PIRC_EMBEDDINGS_MODEL`, optional `PIRC_EMBEDDINGS_DIMENSIONS`, and `PIRC_EMBEDDINGS_API_KEY`. The key is added to the secret list in `pirc-config/src/env_allowlist.rs` and parsed next to `exa_api_key` in `pirc-config/src/lib.rs`.
- The recommended deployment is a local server on the private network (for example Ollama with a multilingual model such as `bge-m3`). A hosted API sends every note and query to that provider; the deploy docs must say so.
- Alternative to decide: an `embeddings` entry in `models.json` / Settings instead of environment variables.

The subscription backends (Claude, Copilot, ChatGPT/Codex) do not offer embeddings.

### Storage (migration 1006)

```sql
CREATE TABLE search_embeddings (
  kind TEXT NOT NULL,            -- 'record' | 'delegation'
  key TEXT NOT NULL,             -- node_id/ledger_key/id, or the delegation id
  owner_user TEXT NOT NULL,
  model TEXT NOT NULL,           -- model + dimensions; a change re-embeds everything
  content_hash TEXT NOT NULL,    -- memory/text.rs content_hash of the embedded text
  vector BLOB NOT NULL,          -- L2-normalized little-endian f32
  PRIMARY KEY (kind, key)
);
```

- Size: a few thousand notes × 1024 dims × 4 B ≈ 16 MB. Cap embedded rows per node (start at 20,000). Past the cap, rows stay FTS-only and the gateway logs it. Consider int8 quantization only if the cap binds.
- Forgetting, ledger resets, project and session deletion delete the embedding row in the same transaction as the record. Covered by the same sentinel-style test (vector bytes absent after forget).

### Indexing

- A background tokio task in the gateway selects rows missing an embedding or with a stale `content_hash`/`model`, embeds them in batches of 32 with a timeout and exponential backoff, and writes the results.
- It never holds the `Db` lock across an `await` (per `db.rs`), and the mirror-apply path never waits on the network.
- Errors are logged without note content. A row that keeps failing is skipped until its content changes.

### Query

1. Embed the query (3 s timeout; cache identical queries for 15 minutes like `web_search`). On failure or without configuration, use FTS only.
2. Load the vectors for rows passing today's owner/status/scope filter. Compute brute-force cosine in Rust and keep the top 50.
3. Fuse with the FTS top 50 by reciprocal rank fusion (`1/(60 + rank)`). Tie-break active before superseded, then newest.
4. Hits found only by vector need cosine ≥ a threshold tuned on the eval set, so an unrelated query still returns nothing instead of the nearest noise.
5. Optionally add a `match: "text" | "semantic" | "both"` field per hit, which the tool description explains. Whether hits carry it is a decision for this phase.

The linked-first scope logic is unchanged: "found nothing in linked workspaces" means the fused result is empty.

### Constraints

- No `unsafe` code and no SQLite extension. The only new code is HTTP via the existing `reqwest`/`rustls`, `f32` math, and BLOB encoding. Check the binary against `size-budget.json`.
- Tests use an in-process fake embeddings server with deterministic vectors (as `web_search.rs` tests inject the URL). Real-model evaluation needs the user's approval and endpoint (README: no paid evaluation without it).
- Docs to update:
  - `docs/deploy/gateway.md`: the variables and the data-leaves-the-gateway warning.
  - `nix/module.nix`: options/`environmentFile`.
  - `docs/deploy/backup-and-recovery.md`: vectors are derived from notes and are as sensitive.
  - `docs/architecture/assistant-memory.md`, the tool prompt and `CHANGELOG.md`.

### Validation

- Eval set: the `paraphrase` and cross-language classes improve, and no class drops below its Phase 1 result.
- Search latency stays under 50 ms p95 at 20,000 vectors on the CI runner, excluding the query embedding call.
- Gateway and conformance tests as in Phase 1, plus configuration parsing and the FTS-only fallback when the endpoint is down.

## Revisit sqlite-vec / ANN when

- embedded rows routinely exceed about 50,000 per user, or
- brute-force scoring exceeds about 50 ms p95,

and sqlite-vec has a stable release whose registration does not need `unsafe` in this workspace (or the policy changes).
