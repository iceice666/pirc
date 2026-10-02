# Prompt customization: SOUL.md, CHAT.md and a context inspector

Status: proposal, nothing implemented. Baseline: `main@6b548a9`.

## Problem

A chat session's system prompt, rendered on 2026-10-02 with the harness (`role: 'chat'`, the real `~/.config/.pirc/AGENTS.md`), is:

1. `chatPrompt` (`apps/gateway/src/agent/config.ts`): identity, style and the private-directory fact, hard-coded.
2. `$PIRC_CONFIG_DIR/AGENTS.md`: the same file as for coding sessions, so a chat gets Tooling, Codebase interop, Testing & Commits and Constraints (in the maintainer's dotfiles, `common/home-base/agent-instructions.md`, also linked into pi and `~/.agents/AGENTS.md`).
3. `<cwd>/AGENTS.md` and `<workspace>/.pirc/AGENTS.md`: always absent for a chat (private session directory).
4. `sessionStart` hook output.
5. Feature sections in `features/index.ts` order: Project instructions, Role, Memory (USER/MEMORY) + Workspaces, Skills, Browser, Sandbox.
6. `Current working directory: …` (`agent.ts` `systemPrompt`).

The persona can only live in the project instructions or USER, so it lands mid-prompt after about 2 KB of coding rules. Only AGENTS.md, project instructions and memory entries are editable, and nothing shows the rendered prompt; reading it took a test harness.

## Decisions (maintainer, 2026-10-02)

- `SOUL.md`: **one global file**, `$PIRC_CONFIG_DIR/SOUL.md`. No per-project override.
- SOUL.md is **chat-only**; coding (directory workspace) sessions never load it.
- Chats stop reading `AGENTS.md` and read **`$PIRC_CONFIG_DIR/CHAT.md`** instead; `AGENTS.md` (global, workspace, `.pirc/`) becomes coding-only. SOUL.md holds persona only; CHAT.md holds general chat rules (cite sources, external content is untrusted, …).
- SOUL.md and CHAT.md are **also editable in the web UI**. They stay on the chat node (the files above; no gateway copy, the gateway only relays). When the node process cannot write a file (a Nix store path or a home-manager symlink), the web shows it read-only.
- The maintainer intends **exactly one chat node**; "global" means that node's files.
- Section order stays fixed for now; no reordering configuration.
- A **context inspector** in the side panel shows the system prompt by section with sources, the tool list with descriptions, and the context usage breakdown. When the agent is not running it shows the snapshot of the last request sent.

## 1. SOUL.md and CHAT.md

Chat prompt, top to bottom:

1. `SOUL.md` when present, otherwise the built-in identity and style lines (the first two lines of today's `chatPrompt`).
2. The built-in environment line (private working directory, read/write limits). Always present: it is a fact the user cannot change, not a persona.
3. `CHAT.md` when present.
4. Feature sections and cwd as today.

Coding prompt is unchanged: `basePrompt` + the three `AGENTS.md` files.

- Load in `loadAgentConfig` like `AGENTS.md` today (read at agent start, so an edit reaches the next agent start, same as `docs/deploy/upgrades.md` says for AGENTS.md). No per-chat freezing; project instructions keep theirs.
- `SOUL.md` and `CHAT.md` are configuration: add them to `protectedPaths` explicitly (they already sit in `configDir`, which agents cannot write, but list them so a future config-dir change keeps them protected).
- Nix: `services.pirc.soulPrompt` and `services.pirc.chatPrompt`, written next to `AGENTS.md` in the config store path (`nix/module.nix`), documented in `nix/README.md`, `docs/deploy/nixos.md`, `docs/deploy/node.md`, `docs/chat-projects.md`, README.
- Migration: the chat node stops seeing `AGENTS.md`. Release notes must say to move any chat-relevant rules into CHAT.md. Dotfiles (outside this repo) need a `SOUL.md` and `CHAT.md` for the chat node; the maintainer does that.
- Tests: chat prompt contains SOUL then environment then CHAT, never AGENTS.md text; coding prompt contains AGENTS.md and never SOUL/CHAT; absent SOUL falls back to the built-in identity.

### Web management

Same pattern as project instructions (`node/chat.ts` `writeProjectInstructions`, `node/app.ts`, `daemon/app.ts` relay, `ProjectInstructions.svelte`), but node-wide instead of per project.

- **Storage:** the files themselves, `$PIRC_CONFIG_DIR/SOUL.md` and `$PIRC_CONFIG_DIR/CHAT.md`. No second copy in the node state directory, so the file a user edits by hand and the one the web edits are the same, and there is no precedence rule to explain.
- **Writable check** (per file, on every GET and before every write, never cached): writable only when the config directory is writable by the node process (`access(W_OK)`), and the file is absent or a regular file (`lstat`, **not a symlink**) that is writable. A symlink is read-only even if its target is writable: the atomic temp-file-and-rename write would replace a home-manager or Nix link and the next activation would silently put the old text back. Read-only responses carry a reason (`nix-store` when the resolved path is under `/nix/store`, `symlink`, `permission`).
- **Write:** temp file `0600` with `wx`, then rename (as `writeProjectInstructions`); CRLF normalized, trimmed; empty text deletes the file (SOUL then falls back to the built-in identity). Limit 8000 characters each, matching project instructions; the agent also caps what it reads at that size.
- **Node routes** (only on a chat-role node, `pirc-chat`; a coding node answers 404): `GET /api/assistant/prompts` → `{ soul: {text, writable, reason?, path, maxChars}, chat: {...} }`; `PUT /api/assistant/prompts/:name` (`soul` | `chat`) `{text}`, 409 `read_only` when not writable.
- **Gateway:** relays to the chat node with the owner's authorization, strict body schema (`text` string), never stores the text. The gateway does not know a node's role today (`daemon/nodes.ts` registration has no role field): add `role: 'chat' | 'node'` to node registration, and reject registering a second chat-role node while one is registered (`409 chat_node_exists`), which also enforces the one-chat-node intent. 503 `node_offline` when the chat node is offline.
- **Takes effect:** at the next agent start of a chat (new chats, or a chat whose agent restarts), like AGENTS.md; the editor says so. The context inspector shows which version a running chat has.
- **Web UI:** Settings → Assistant, two editors (Soul, Chat rules) with character counters, Save/Revert, and a read-only state showing the reason and the file path ("Managed by Nix: edit `services.pirc.soulPrompt`").
- **Tests:** writable regular file round-trip; symlink and read-only directory → `writable:false` and PUT 409; empty text deletes; over-limit 413; coding node 404; second chat node rejected; gateway relay requires owner auth.

## 2. Context inspector

### Agent: sectioned prompt

Today `Agent.systemPrompt()` joins strings and features return `{ systemPrompt?: string }`. Change the internal shape to sections, keeping the joined string byte-identical (provider cache prefix and existing tests):

```ts
interface PromptSection {
  id: string; // 'base' | 'soul' | 'chat-env' | 'chat-md' | 'agents:global' | 'hook:sessionStart' | feature name | 'cwd'
  title: string; // shown in the inspector
  source: string; // file path, 'built-in', 'gateway', 'hook', 'feature:<name>'
  frozen?: boolean; // project instructions, Memory snapshot
  text: string;
}
```

- `loadAgentConfig` returns `systemPrompt` sections instead of a string; features may return `systemPrompt` as a string (wrapped with the feature name as source) or as sections.
- After each run's `beforeAgentStart`, the agent keeps `lastContext`: the sections, the tool specs actually sent (`toolSpecs()`), the model, and the usage breakdown below.

### Usage breakdown

Per bucket, estimated tokens with the same estimator as `messages.ts` `estimateTokens`, scaled to the provider's reported input tokens of the last response when available (show both the estimate and the reported figure):

- system prompt, per section;
- tool definitions, per tool;
- conversation messages (user, assistant, tool results);
- observational-memory observations/reflections in context (already counted by `memoryPanel`; reuse it rather than recount);
- remaining context window (`model.contextWindow`).

### Snapshot when the agent is stopped

- Written on every run to `<sessionDir>/context.json` (mode 0600, overwritten, not appended), **not** to `session.jsonl`: the snapshot repeats USER/MEMORY and the whole prompt on every run, and the session file is append-only and grows forever.
- The node's panel route reads the live `lastContext` when the runner is alive, otherwise `context.json`, and labels it with the time it was taken.
- `context.json` is cleared with the session directory; it needs no separate retention. It must stay node-local: the gateway only relays the HTTP response (as for Files/Git) and must not store it. Verify that nothing mirrors session directories to the gateway before shipping (see the companion-privacy notes on what nodes forward).

### Routes

- Agent RPC `get_context` → `lastContext`.
- Node `GET /api/sessions/:id/panel/context` in `node/panel-routes.ts`: live RPC, else `context.json`, else 404 `no_context` ("send a message first").
- Gateway: add `panel\/context` to `RELAYED_GET` in `daemon/app.ts`. Same owner/session authorization as the other panel routes.
- `panel_changed` with section `context` after each run so an open tab refreshes.

### Web

- New tab `context` (`PanelTab`), icon e.g. `ScanText`, shown for chats and coding sessions alike.
- Top: stacked usage bar (system / tools / messages / memory / free) with totals and the context window.
- Sections list: title, source (file path clickable when readable via Files), frozen badge, token count; expands to the text in a monospace block. Copy-all button for the joined prompt.
- Tools list: name, token count, expandable description and parameters schema.
- Stale banner when showing the snapshot of a stopped agent.

### Not in scope

Editing prompts from the inspector, reordering sections, overriding built-in section text and tool descriptions (`agent/prompts/tools/*.md`). Those are later steps of "everything customizable"; the inspector comes first so their effect is visible.

## Open questions

- Android: add the inspector tab later or never.
