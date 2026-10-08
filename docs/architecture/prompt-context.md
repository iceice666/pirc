# Prompt configuration and Context snapshots

This reference preserves the implemented contracts from the completed 2026-10-02 prompt-customization plan (baseline `main@69ae62c`), checked against the Context types and transport. User-facing instructions are in [Chat projects](../guides/chat-projects.md); upgrade requirements are in [Upgrades](../deploy/upgrades.md).

## Prompt files and authority

Chat sessions load global `$PIRC_CONFIG_DIR/SOUL.md` (persona), then the fixed private-directory environment description, then `$PIRC_CONFIG_DIR/CHAT.md` (chat rules), followed by feature sections and cwd. Absent Soul uses the built-in identity/style. Coding sessions use AGENTS.md instead and do not load Soul/Chat. There is no project Soul override or configurable section ordering. Edits apply at the next agent start, not immediately to running agents; frozen project instructions have their own lifecycle.

Settings → Assistant manages the same node-local files users edit by hand, not another state-directory or gateway copy. Each is limited to 8,000 characters; input is CRLF-normalized and trimmed, and empty content deletes the file. Writes use an exclusive mode-0600 temporary file and rename. The files are explicitly protected configuration paths.

Writability is checked per file on reads and before writes: the configuration directory must be writable, and an existing file must be a writable regular file, not a symlink. A writable symlink target is still read-only because atomic replacement would destroy its managed link. Reasons include `nix-store`, `symlink`, and `permission`. For Nix, use `services.pirc.soulPrompt` and `services.pirc.chatPrompt`.

Prompt management routes are `GET /api/assistant/prompts` and `PUT /api/assistant/prompts/:name` (`soul` or `chat`, body `{text}`). Reads return text, path, maximum size, writability and optional reason; writes to read-only files return `409 read_only`, and over-limit content returns 413. Coding nodes do not expose these chat-node routes (404); an unavailable chat node returns `503 node_offline` through the gateway. The gateway validates and relays; both gateway and node `allowedUsers` apply, not a separate sole-owner field.

The gateway persistently binds the first chat-node ID across disconnects/restarts. A second ID receives `409 chat_node_exists` in a WebSocket registration frame, not an HTTP error after upgrade. Replacement requires stopping the old node and explicitly releasing its binding in Settings → Assistant; otherwise the old process may reclaim it. Only the binding ID is stored at the gateway.

## Section and snapshot contracts

`apps/gateway/src/agent/context.ts` defines `PromptSection`: `id`, `title`, `source`, optional `frozen`, and `text`. Sections join with blank lines; trimming preserves interior whitespace. Features can supply section arrays or a string wrapped with their feature source. Sectioning is for inspection, not permission to reorder or rewrite the provider prompt.

A version-1 `ContextSnapshot` records an ID, timestamp, request model/context window, sections with estimated tokens, the actual provider tool specifications with estimates, optional internal capability metadata, and input-usage buckets. The hybrid surface's provider tools and script capabilities are distinct: capability metadata is not an extra provider schema list.

Estimates use the message estimator. Observational-memory tokens are allocated out of compaction-summary messages, bounded by their size, rather than counted twice. USER/MEMORY prompt sections remain system tokens. Matching provider usage supplies reported input including cache reads/writes, not output; the scale is reported input divided by estimated input. Remaining space uses the snapshot's request model window. These are approximate allocations, not exact tokenizer attribution.

## Node-local storage and relay

The agent retains `lastContext` and atomically replaces `<sessionDir>/context.json` with a mode-0600 exclusive temporary file and rename. The duplicated prompt and tool content is not appended to `session.jsonl`. Snapshots contain prompt/tool information, not raw conversation or provider credentials. They are removed with the session directory; there is no additional automatic retention policy.

Agent RPC `get_context` returns the live snapshot only below its bounded size allowance (at most 512 KiB). Node `GET /api/sessions/:id/panel/context` tries the live runner with an allowance below the RPC line limit, then falls back to the disk snapshot for large, stopped or older agents. Missing context returns `404 no_context` with a send-a-message-first explanation. The gateway relays under the existing session authorization and does not store the snapshot. Context updates use `panel_changed`.

The web Context panel shows sections, sources, frozen badges, tool definitions and usage. Workspace-readable sources can link to Files; global configuration sources are plain text. Copy all returns the joined prompt. Disk snapshots are labeled with their timestamp, not presented as freshly loaded configuration. Editing/reordering prompts from the inspector is not supported. Native Android inspector scope remains a [backlog decision](../../plans/backlog.md#android).

## Regression expectations and provenance

The completed design required chat-vs-coding loading/order and fallback tests; writable-file round trips; symlink/read-only rejection; empty deletion; size limits; coding-node route exclusion; chat-node binding and authorized relay; byte-preserving section joins; usage allocation without memory double counting; and node-local stopped-agent fallback. These are preservation requirements, not a claim that this documentation change reran the suites.

The historical proposal's transient single-connected-node wording is superseded by persistent ID binding, and its owner wording by gateway/node `allowedUsers`. The original plan's source investigation and tentative API descriptions are not new implementation authorization.
