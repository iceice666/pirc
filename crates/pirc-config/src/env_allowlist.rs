//! The environment of every process a node starts (agents, approved host
//! commands, panel terminals, git, later Chromium and ffmpeg), ported from
//! `apps/gateway/src/env-allowlist.ts` and `node/secrets.ts`.
//!
//! An explicit allowlist, not a denylist: the node's service environment may
//! hold its own tokens, provider keys, cloud credentials, an ssh-agent
//! socket, and none of that may reach code the model drives. What is kept is
//! what a development shell needs to find its tools, locale, terminal,
//! certificates and per-user directories. Users whose agent tools need a
//! credential put it in the agent config's `env`, or name it in
//! `PIRC_AGENT_ENV_ALLOW` (comma-separated) so it is passed on from the
//! node's environment. Proxy variables (`*_PROXY`) are dropped too: the
//! sandbox sets its own, and a proxy URL may carry credentials. Callers add
//! their own variables after this filter.
//!
//! Golden cases: `apps/gateway/test/node-secrets.test.ts` (all but the OAuth
//! worker case, which is the gateway's).

use std::collections::BTreeMap;
use std::sync::LazyLock;

use regex_lite::Regex;

use crate::Env;

/// pirc's own secrets (tokens, keys, passwords) and the gateway's web
/// search key (`SECRET_ENV`, case-sensitive).
static SECRET_ENV: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(PIRC_[A-Z0-9_]*(TOKENS?|SECRET|KEY|PASSWORD)[A-Z0-9_]*|EXA_API_KEY)$")
        .expect("SECRET_ENV")
});

/// A name that looks like a credential, whatever its prefix
/// (`CREDENTIAL_NAME`: case-insensitive, unanchored at the start).
static CREDENTIAL_NAME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)(TOKENS?|SECRETS?|PASSW(OR)?D|PASSPHRASE|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CREDENTIALS?|AUTH)(_|$)",
    )
    .expect("CREDENTIAL_NAME")
});

/// Exact names a development shell legitimately needs (`ALLOWED_NAMES`).
const ALLOWED_NAMES: &[&str] = &[
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LANGUAGE",
    "TERM",
    "COLORTERM",
    "TERMINFO",
    "TERMINFO_DIRS",
    "NO_COLOR",
    "FORCE_COLOR",
    "TZ",
    "TMPDIR",
    "PWD",
    "EDITOR",
    "VISUAL",
    "PAGER",
    "MANPATH",
    "INFOPATH",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "LOCALE_ARCHIVE",
    "__CF_USER_TEXT_ENCODING",
    // Nix and certificate bundles: without them TLS and nix tools break.
    "NIX_PATH",
    "NIX_PROFILES",
    "NIX_SSL_CERT_FILE",
    "NIX_USER_PROFILE_DIR",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "CURL_CA_BUNDLE",
    "REQUESTS_CA_BUNDLE",
    "NODE_EXTRA_CA_CERTS",
    // Chromium on Nix finds its fonts through these.
    "FONTCONFIG_FILE",
    "FONTCONFIG_PATH",
    // Toolchain locations (directories, never credentials).
    "CARGO_HOME",
    "RUSTUP_HOME",
    "GOPATH",
    "GOROOT",
    "GOMODCACHE",
    "JAVA_HOME",
    "BUN_INSTALL",
    // srt's temporary directory, when the node itself runs inside srt.
    "CLAUDE_CODE_TMPDIR",
];

/// Prefixes of variable families that only hold locale, terminal or
/// directory settings (`ALLOWED_PREFIXES`).
const ALLOWED_PREFIXES: &[&str] = &["LC_", "XDG_", "TERM_PROGRAM"];

/// Whether `name` is one of pirc's own secrets (`SECRET_ENV.test`).
pub fn is_secret_env(name: &str) -> bool {
    SECRET_ENV.is_match(name)
}

/// Whether `name` may be passed to a process the node starts
/// (`allowedEnvName`): a `PIRC_` name unless secret or credential-like;
/// otherwise not credential-like and allowlisted by name or prefix.
pub fn allowed_env_name(name: &str) -> bool {
    if name.starts_with("PIRC_") {
        return !SECRET_ENV.is_match(name) && !CREDENTIAL_NAME.is_match(name);
    }
    if CREDENTIAL_NAME.is_match(name) {
        return false;
    }
    ALLOWED_NAMES.contains(&name)
        || ALLOWED_PREFIXES
            .iter()
            .any(|prefix| name.starts_with(prefix))
}

/// `allowlistedEnv`: `env` reduced to the allowlist plus the names in
/// `extra`; pirc's own secrets (`SECRET_ENV`) are never kept.
pub fn allowlisted_env(env: &Env, extra: &[&str]) -> BTreeMap<String, String> {
    env.vars()
        .filter(|(name, _)| {
            !SECRET_ENV.is_match(name) && (allowed_env_name(name) || extra.contains(name))
        })
        .map(|(name, value)| (name.to_owned(), value.to_owned()))
        .collect()
}

/// `operatorAllowedEnv`: the valid names in `PIRC_AGENT_ENV_ALLOW`.
pub fn operator_allowed_env(env: &Env) -> Vec<String> {
    env.get("PIRC_AGENT_ENV_ALLOW")
        .unwrap_or_default()
        .split(',')
        // `String.prototype.trim` (JS whitespace).
        .map(|name| name.trim_matches(crate::text::is_space))
        .filter(|name| valid_name(name))
        .map(str::to_owned)
        .collect()
}

/// `^[A-Za-z_][A-Za-z0-9_]*$`.
fn valid_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// `withoutSecrets`: the environment of the processes a node starts, the
/// allowlist plus what the operator named in `PIRC_AGENT_ENV_ALLOW` plus
/// `extra`. Callers add their own variables after this.
pub fn without_secrets(env: &Env, extra: &[&str]) -> BTreeMap<String, String> {
    let operator = operator_allowed_env(env);
    let mut names: Vec<&str> = extra.to_vec();
    names.extend(operator.iter().map(String::as_str));
    allowlisted_env(env, &names)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(vars: &[(&str, &str)]) -> Env {
        Env::new(vars.iter().copied(), "/")
    }

    fn map(vars: &[(&str, &str)]) -> BTreeMap<String, String> {
        vars.iter()
            .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
            .collect()
    }

    // node-secrets.test.ts: "drops the node secrets, credentials and
    // everything not allowlisted"
    #[test]
    fn drops_secrets_credentials_and_everything_not_allowlisted() {
        let kept = [
            ("PIRC_NODE_ID", "n"),
            ("PIRC_WORKSPACE_KIND", "directory"),
            ("PIRC_CONFIG_DIR", "/home/u/.config/.pirc"),
            ("HOME", "/home/u"),
            ("PATH", "/usr/bin:/bin"),
            ("USER", "u"),
            ("LANG", "en_US.UTF-8"),
            ("LC_ALL", "C"),
            ("TERM", "xterm-256color"),
            ("TERM_PROGRAM", "iTerm.app"),
            ("TMPDIR", "/tmp/u"),
            ("XDG_RUNTIME_DIR", "/run/user/1000"),
            ("NIX_SSL_CERT_FILE", "/etc/ssl/certs/ca-bundle.crt"),
            (
                "LOCALE_ARCHIVE",
                "/run/current-system/sw/lib/locale/locale-archive",
            ),
            ("__CF_USER_TEXT_ENCODING", "0x1F5:0x0:0x0"),
            ("CLAUDE_CODE_TMPDIR", "/tmp/srt"),
            ("EDITOR", "vim"),
        ];
        let mut all = vec![
            ("PIRC_NODE_TOKEN", "a"),
            ("PIRC_NODE_TOKENS", "{}"),
            ("PIRC_OAUTH_SECRET_KEY", "b"),
            (
                "PIRC_CLIPROXYAPI_KEY",
                "provider key in a shared environment file",
            ),
            ("PIRC_VAPID_PRIVATE_KEY", "c"),
            ("PIRC_PROXY_SECRET", "p"),
            ("EXA_API_KEY", "d"),
            ("ANTHROPIC_API_KEY", "e"),
            ("OPENAI_API_KEY", "f"),
            ("GITHUB_TOKEN", "g"),
            ("GH_TOKEN", "h"),
            ("NPM_TOKEN", "i"),
            ("AWS_SECRET_ACCESS_KEY", "j"),
            ("AWS_ACCESS_KEY_ID", "k"),
            ("AWS_PROFILE", "l"),
            ("SSH_AUTH_SOCK", "/tmp/agent.sock"),
            ("GIT_SSH_COMMAND", "ssh -i key"),
            ("GIT_CONFIG_PARAMETERS", "'core.hooksPath=x'"),
            ("HTTPS_PROXY", "http://user:pass@proxy:3128"),
            ("http_proxy", "http://proxy"),
            ("NODE_OPTIONS", "--require evil.js"),
            ("LD_PRELOAD", "/tmp/x.so"),
            ("DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/1000/bus"),
            ("XDG_CONFIG_TOKEN", "never, whatever the prefix"),
        ];
        all.extend(kept);
        assert_eq!(without_secrets(&env(&all), &[]), map(&kept));
    }

    // "keeps extra names a caller asks for, but never pirc secrets"
    #[test]
    fn keeps_extra_names_but_never_pirc_secrets() {
        assert_eq!(
            without_secrets(
                &env(&[
                    ("SSH_AUTH_SOCK", "/s"),
                    ("PIRC_NODE_TOKEN", "t"),
                    ("HOME", "/h")
                ]),
                &["SSH_AUTH_SOCK", "PIRC_NODE_TOKEN"],
            ),
            map(&[("SSH_AUTH_SOCK", "/s"), ("HOME", "/h")])
        );
    }

    // "passes on what the operator names in PIRC_AGENT_ENV_ALLOW"
    #[test]
    fn passes_on_operator_names() {
        let allow = " GITHUB_TOKEN, NPM_TOKEN ,PIRC_NODE_TOKEN,bad-name";
        assert_eq!(
            without_secrets(
                &env(&[
                    ("PIRC_AGENT_ENV_ALLOW", allow),
                    ("GITHUB_TOKEN", "g"),
                    ("NPM_TOKEN", "n"),
                    ("GH_TOKEN", "not named"),
                    ("PIRC_NODE_TOKEN", "never"),
                ]),
                &[],
            ),
            map(&[
                ("PIRC_AGENT_ENV_ALLOW", allow),
                ("GITHUB_TOKEN", "g"),
                ("NPM_TOKEN", "n"),
            ])
        );
        assert_eq!(
            operator_allowed_env(&env(&[("PIRC_AGENT_ENV_ALLOW", allow)])),
            ["GITHUB_TOKEN", "NPM_TOKEN", "PIRC_NODE_TOKEN"]
        );
    }

    // "treats credential-looking PIRC_ names as secret"
    #[test]
    fn credential_looking_pirc_names_are_secret() {
        assert!(allowed_env_name("PIRC_SANDBOX_POLICY"));
        assert!(!allowed_env_name("PIRC_NODE_TOKEN"));
        assert!(!allowed_env_name("PIRC_SOMETHING_PASSWORD"));
        assert!(!allowed_env_name("PIRC_UPSTREAM_CREDENTIALS"));
        // Case-insensitive, unanchored at the start.
        assert!(!allowed_env_name("xdg_api_key"));
        assert!(!allowed_env_name("LC_AUTH"));
        assert!(is_secret_env("EXA_API_KEY"));
        assert!(!is_secret_env("pirc_node_token"));
    }
}
