//! The environment of every process a node starts (agents, approved host
//! commands, panel terminals, git, later Chromium and ffmpeg), ported from
//! `apps/gateway/src/env-allowlist.ts` and `node/secrets.ts`.
//!
//! Owner: **runner** (M6). Panels (terminals, git) call [`without_secrets`].
//!
//! An explicit allowlist, not a denylist: the node's service environment may
//! hold its own tokens, provider keys, cloud credentials, an ssh-agent
//! socket, and none of that may reach code the model drives. Port the TS
//! module exactly:
//!
//! - `SECRET_ENV` = `^(PIRC_[A-Z0-9_]*(TOKENS?|SECRET|KEY|PASSWORD)[A-Z0-9_]*|EXA_API_KEY)$`
//!   (case-sensitive), never kept, not even when named in `extra`;
//! - `CREDENTIAL_NAME` = `(TOKENS?|SECRETS?|PASSW(OR)?D|PASSPHRASE|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CREDENTIALS?|AUTH)(_|$)`
//!   (case-insensitive, unanchored at the start);
//! - `ALLOWED_NAMES` (PATH, HOME, ..., CLAUDE_CODE_TMPDIR) and
//!   `ALLOWED_PREFIXES` (`LC_`, `XDG_`, `TERM_PROGRAM`);
//! - `PIRC_AGENT_ENV_ALLOW`: comma-separated names matching
//!   `^[A-Za-z_][A-Za-z0-9_]*$`, added to `extra`.
//!
//! Golden cases: `apps/gateway/test/node-secrets.test.ts` (all but the OAuth
//! worker case, which is the gateway's).

use std::collections::BTreeMap;

use crate::Env;

/// Whether `name` may be passed to a process the node starts
/// (`allowedEnvName`): a `PIRC_` name unless secret or credential-like;
/// otherwise not credential-like and allowlisted by name or prefix.
pub fn allowed_env_name(name: &str) -> bool {
    let _ = name;
    todo!("runner: port allowedEnvName")
}

/// `allowlistedEnv`: `env` reduced to the allowlist plus the names in
/// `extra`; pirc's own secrets (`SECRET_ENV`) are never kept.
pub fn allowlisted_env(env: &Env, extra: &[&str]) -> BTreeMap<String, String> {
    let _ = (env, extra);
    todo!("runner: port allowlistedEnv")
}

/// `operatorAllowedEnv`: the valid names in `PIRC_AGENT_ENV_ALLOW`.
pub fn operator_allowed_env(env: &Env) -> Vec<String> {
    let _ = env;
    todo!("runner: port operatorAllowedEnv")
}

/// `withoutSecrets`: the environment of the processes a node starts, the
/// allowlist plus what the operator named in `PIRC_AGENT_ENV_ALLOW` plus
/// `extra`. Callers add their own variables after this.
pub fn without_secrets(env: &Env, extra: &[&str]) -> BTreeMap<String, String> {
    let _ = (env, extra);
    todo!("runner: port withoutSecrets")
}
