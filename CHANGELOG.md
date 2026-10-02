# Changelog

User-facing changes are recorded here. See [release policy](docs/releasing.md).

## [Unreleased]

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

[Unreleased]: https://github.com/iceice666/pirc/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/iceice666/pirc/releases/tag/v0.2.0
