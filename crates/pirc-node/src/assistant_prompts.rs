//! The assistant's editable prompts on the chat node
//! (`apps/gateway/src/assistant-prompts.ts`): `SOUL.md` and `CHAT.md` in
//! the config directory, at most 8000 characters, with whether each can be
//! written (a Nix store path, a symlink or permissions may forbid it). The
//! routes (`GET /api/assistant/prompts`, `PUT /api/assistant/prompts/:name`)
//! exist on the chat node only. Owner: **core**; reading a prompt is
//! `pirc_agent::config::read_assistant_prompt`.
