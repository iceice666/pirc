# Changelog

User-facing changes are recorded here. See [release policy](docs/releasing.md).

## [Unreleased]

### Security

- Agents can no longer read more credential stores: `~/.local/pirc-node` (the macOS node's `agent.env`), `~/.config/op`, Cargo, RubyGems and Terraform credentials, Claude Code and Codex login files, shell histories and Microsoft Edge profiles. Auto mode and the sandbox now share one list, so a shell command that touches `~/.npmrc`, `~/.yarnrc.yml` or `~/.bundle/config` also needs approval (builds can still read them).
- The file tools refuse writes to the workspace's `.git/hooks`, and to `.git/config` unless `sandbox.filesystem.allowGitConfig` is set, as the sandbox already did for shell commands.
- The gateway database and its WAL files are created with mode 0600, and an existing database is tightened on start.
- Mermaid diagrams are passed through the same sanitizer as the rest of a message.

## [0.3.0] - 2026-10-07

### Added

- `/recap` reviews a bounded sample of recent sessions in the same owner's directory workspace and proposes evidence-linked skills, rules, settings or workflow improvements. It defaults to 14 days and at most 20 sessions, excludes background and recap-marked sessions, and uses a separate no-tools model request without applying changes or promoting the report into memory. Sampled text is sent to the configured model; coverage, truncation and best-effort redaction limits are disclosed.
- Programmatic tool calling: the model can write a `ptc` script, TypeScript run in an isolated QuickJS interpreter, that calls tools as `tools.<name>(args)` with typed results, `tools.par` for bounded parallel work, image attachments and `store`/`load` across scripts. Several reads, an edit and its test run, or filtering search results take one model round. The core tools (`read`, `write`, `edit`, `ls`, `grep`, `find`, `bash`, `web_search`, `web_fetch`) can still be called directly; every other tool is reachable only from a script, with full contracts from `ptc_docs`. On the evaluation tasks with OpenAI `gpt-6.1-sol`, coding used about 20% fewer tokens than before this change, with the same authorization results; on 19 held-out Aider polyglot Python exercises, a build with one more routing sentence passed as many as before (all 38 trials on both) with 32% fewer tokens and 43% fewer model rounds.
- The web and Android timelines show each script's operations nested under it, with running, waiting-for-approval and finished states.
- Setup guide for using `gh` and git (HTTPS with a token, or SSH with a dedicated key) inside the agent sandbox instead of approving `unsandboxed_bash` for each push, with `scripts/sandbox-ssh-proxy.py`, an ssh `ProxyCommand` that authenticates to srt's proxy. Tested on macOS only.

### Changed

- Chats get `ptc` scripts too, over the tools they already have; no capability that chat lacked is added.
- Hooks, auto mode, approvals, path rules and the write lease apply to every operation of a script as to the same direct call. Auto mode checks a script's own text only against your `deny` list.
- Writes only under temporary directories and build caches no longer take the workspace write lease, so sessions using `/tmp` do not block each other.
- Each tool's arguments are checked against its schema before it runs (direct calls still accept `null` for optional arguments and ignore unknown keys).

### Removed

- The `code` tool (scripts with full Bun access) and `features.code`.

### Fixed

- Observational-memory settings now warn once at agent startup when invalid fields cause the entire configuration to use defaults, including re-enabling memory. Diagnostics identify fields without exposing rejected values. Unknown fields are warned about and ignored while valid settings remain in effect; validation strictness and defaults are unchanged.

### Security

- A script has no authority of its own: it runs in a QuickJS interpreter with no file, network or process access, inside a child process with an empty environment that talks only to its agent, which checks every operation the script asks for. The interpreter is the boundary: its process keeps the agent's sandbox rights rather than a stricter profile. After an operation is refused, only read-only tools (`read`, `ls`, `grep`, `find`, `web_fetch`, …) run in the rest of that script, commands and writes are not started, and the refusal always reaches the model.
- What a script gets from web pages, search results or the browser, including values an earlier script stored after reading them and this one may have loaded, is fenced as untrusted in its result.

### Migration

- Upgrade the gateway (it ships the web bundle) and every chat and coding node from the same release, then reload web clients and update the Android app. Rename hook matchers that name `code` to `ptc` (they still apply, with a warning in the session). Scripts that relied on Bun or Node APIs must use tools instead. See [Upgrades](docs/deploy/upgrades.md#programmatic-tool-calling-the-code-tool-removed).

### Known limits

- Evaluated on one model (OpenAI `gpt-6.1-sol`); other providers get the same tools without their own evaluation. Against the pre-declared bounds, dependent multi-step edits on the fixture set did not take fewer rounds; chat used 7–15% more tokens; and chat replies to a request for a disabled capability passed the wording check less often (2/20 against 12/20), although the capability was blocked every time. These were accepted at cutover.
- Fixes made after these measurements (refusal handling, the attachment limit, lenient direct arguments) were not re-measured.
- Image attachments from a script are limited to 512 KiB together per result, so they fit the node's RPC line.

### Distribution

- macOS ARM64 gateway, chat and node executables plus web static assets; source archives are available from GitHub. Native binaries are not Developer ID signed/notarized and require external Chromium/Chrome and optional ffmpeg for browser features.
- Android versionName is 0.3.0 and versionCode is 3; no APK is published. No Linux/x86_64 binaries are included; Nix packaging is retained.
- Recap is a bounded review, not a full transcript audit: it excludes thinking and tool payloads, uses the loaded AGENTS.md snapshot and skill/role summaries, and does not automatically apply recommendations.

## [0.2.0] - 2026-10-02

This is the first tagged release. Earlier development used 0.1.0 without a published release; this entry summarizes the current release rather than inventing a historical 0.1.0 changelog.

### Added

- Global chat persona (`SOUL.md`) and general chat rules (`CHAT.md`), with node-local editors in Settings → Assistant and Nix options `services.pirc.soulPrompt` / `chatPrompt`.
- A Context side-panel tab for chats and coding sessions: system sections and sources, frozen-memory badges, tool descriptions/schemas, estimated and reported context usage, copy-all, and a node-local last-request snapshot available after an agent stops.
- Persistent binding of a single chat node, with an explicit confirmed release action in Settings → Assistant.
- Version synchronization/check tooling and a documented release/changelog policy.

### Changed

- Chats no longer read global or workspace `AGENTS.md`; coding sessions continue to use it and never load SOUL.md or CHAT.md.
- Gateway/node transport is now protocol **8**. Old registrations receive an explicit protocol mismatch rather than an ambiguous registration error.
- Global user-managed configuration and managed prompt symlink targets are protected from agent writes, including when located under an otherwise writable root.

### Security

- This release includes the mandatory, fail-closed agent sandbox and embedded sandbox runtime from recent development, plus project-configuration trust checks and auto-mode hardening. It does not claim that all security-audit limitations are resolved.
- Prompt management uses authenticated gateway/node `allowedUsers`; stale editors cannot silently save to a newly bound node.
- Context snapshots are atomically overwritten with mode `0600`, are not appended to session history, and are not mirrored or persisted by the gateway. Existing inference and assistant-memory data flows are unchanged.

### Migration

- Upgrade the gateway and **every chat/coding node together** for protocol 8. Back up state before upgrading; database changes are not guaranteed to be downgrade-compatible.
- Move chat-relevant rules from `AGENTS.md` into the chat node's `$PIRC_CONFIG_DIR/CHAT.md`; put persona text in global `SOUL.md`. Changes apply at the next agent start, not mid-run.
- Nix/store-managed files and symlinks are read-only in the web editor. Edit their original configuration instead.
- The first chat node registration is persistently bound. Before replacing that node, stop it and release the binding in Settings → Assistant; otherwise it may reconnect and reclaim the binding.

### Distribution and limits

- Local macOS ARM64 executables and web static assets accompany this release; source archives are provided by GitHub. Native archives are not Developer ID signed/notarized and do not bundle Chromium or ffmpeg.
- Android versionName is 0.2.0 and versionCode is 2. No Android APK or new native Android Context tab is included in this release.
- Linux/x86_64 binaries are not published or newly runtime-validated as part of this release. Nix packaging is retained.
- Token allocations are estimates scaled to matching provider input usage, not exact per-section tokenizer counts.

[Unreleased]: https://github.com/iceice666/pirc/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/iceice666/pirc/releases/tag/v0.3.0
[0.2.0]: https://github.com/iceice666/pirc/releases/tag/v0.2.0
