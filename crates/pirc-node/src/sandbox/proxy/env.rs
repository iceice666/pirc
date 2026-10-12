//! The proxy environment of a sandboxed command. Ported from
//! sandbox-runtime 0.0.78 `sandbox-utils.js` `generateProxyEnvVars`
//! (Apache-2.0, see `crates/pirc-node/NOTICE`), for pirc's case: both
//! ports, the auth token, no TLS termination CA.
//!
//! Deviations from srt:
//!
//! - The proxy user is `srt`, never `srt.<base64 of the command>`: the
//!   label only attributed denials in srt's violation store, which pirc
//!   does not read.
//! - Linux's `GIT_SSH_COMMAND` runs this executable's
//!   `sandbox-bridge connect` instead of `socat - PROXY:` (the sandbox has
//!   no socat); it speaks the same HTTP `CONNECT` with the same credential
//!   through the bridge's HTTP port.
//! - `SANDBOX_RUNTIME` and `TMPDIR` are the backends' (they come first
//!   there, as in srt), and so is `JAVA_TOOL_OPTIONS` (srt's Java proxy
//!   agent jar is not shipped).

use std::path::Path;

use base64::Engine as _;

use super::ProxyAuth;

/// The proxy user every client presents (srt's `PROXY_AUTH_USER`).
pub const PROXY_USER: &str = "srt";

/// srt's `NO_PROXY`: localhost and private networks (`*.local` left out:
/// the sandbox has no resolver of its own).
pub const NO_PROXY: &str =
    "localhost,127.0.0.1,::1,169.254.0.0/16,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16";

/// What `GIT_SSH_COMMAND`'s `ProxyCommand` runs.
#[derive(Clone, Copy, Debug)]
pub enum EnvPlatform<'a> {
    /// `<helper> sandbox-bridge connect` through the HTTP port (srt: socat).
    Linux { helper: &'a Path },
    /// srt's BSD `nc -X 5` through the SOCKS port. `nc` cannot
    /// authenticate, so the proxy refuses it (on port 22 with an SSH
    /// disconnect message saying so): git over ssh fails, git over https
    /// works, as with srt.
    MacOs,
}

/// The sandboxed command's proxy variables, in srt's order.
pub fn env_vars(
    platform: EnvPlatform<'_>,
    http_port: u16,
    socks_port: u16,
    auth: &ProxyAuth,
) -> Vec<(String, String)> {
    let token = auth.token();
    let userinfo = format!("{PROXY_USER}:{token}@");
    let http = format!("http://{userinfo}localhost:{http_port}");
    let socks = format!("socks5h://{userinfo}localhost:{socks_port}");
    let ssh_mux = "-o ControlMaster=no -o ControlPath=none";
    let proxy_command = match platform {
        EnvPlatform::Linux { helper } => format!(
            "{} {} connect localhost:{http_port} {PROXY_USER}:{token} %h %p",
            // ssh expands `%` tokens in ProxyCommand, then runs it with a shell.
            shell_quote(&helper.display().to_string()).replace('%', "%%"),
            super::super::BRIDGE_SUBCOMMAND,
        ),
        EnvPlatform::MacOs => format!("nc -X 5 -x localhost:{socks_port} %h %p"),
    };
    let pairs: Vec<(&str, String)> = vec![
        ("NO_PROXY", NO_PROXY.to_owned()),
        ("no_proxy", NO_PROXY.to_owned()),
        ("HTTP_PROXY", http.clone()),
        ("HTTPS_PROXY", http.clone()),
        ("http_proxy", http.clone()),
        ("https_proxy", http.clone()),
        // Pre-sends Basic, so git never sees a 407.
        (
            "GIT_CONFIG_PARAMETERS",
            "'http.proxyAuthMethod=basic'".to_owned(),
        ),
        // The mux serves CONNECT and SOCKS on one port: an http:// URL
        // works for every client (httpx would crash on socks5h://).
        ("ALL_PROXY", http.clone()),
        ("all_proxy", http.clone()),
        ("GRPC_PROXY", http.clone()),
        ("grpc_proxy", http.clone()),
        (
            "GIT_SSH_COMMAND",
            format!(
                "ssh {ssh_mux} -o ProxyCommand={}",
                shell_quote(&proxy_command)
            ),
        ),
        // curl gateways ftp:// through an http:// proxy, which the proxy
        // does not do; socks5h is a plain tunnel.
        ("FTP_PROXY", socks.clone()),
        ("ftp_proxy", socks),
        // host:port only; rsync's CONNECT gets a 407 (srt's known gap).
        ("RSYNC_PROXY", format!("localhost:{socks_port}")),
        ("DOCKER_HTTP_PROXY", http.clone()),
        ("DOCKER_HTTPS_PROXY", http),
        ("CLOUDSDK_PROXY_TYPE", "http".to_owned()),
        ("CLOUDSDK_PROXY_ADDRESS", "localhost".to_owned()),
        ("CLOUDSDK_PROXY_PORT", http_port.to_string()),
        ("CLOUDSDK_PROXY_USERNAME", PROXY_USER.to_owned()),
        ("CLOUDSDK_PROXY_PASSWORD", token.to_owned()),
    ];
    pairs
        .into_iter()
        .map(|(name, value)| (name.to_owned(), value))
        .collect()
}

/// `Basic <base64(user:password)>` for a `user:password` credential.
pub fn basic_authorization(credential: &str) -> String {
    format!(
        "Basic {}",
        base64::engine::general_purpose::STANDARD.encode(credential)
    )
}

/// One shell word: as it is when it needs no quoting, else single-quoted.
fn shell_quote(text: &str) -> String {
    let plain = !text.is_empty()
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"/._-+:@,=%".contains(&b));
    if plain {
        text.to_owned()
    } else {
        format!("'{}'", text.replace('\'', r"'\''"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn auth() -> ProxyAuth {
        ProxyAuth {
            token: "0123456789abcdef0123456789abcdef".to_owned(),
        }
    }

    fn names(vars: &[(String, String)]) -> Vec<&str> {
        vars.iter().map(|(name, _)| name.as_str()).collect()
    }

    fn get<'a>(vars: &'a [(String, String)], name: &str) -> &'a str {
        &vars.iter().find(|(n, _)| n == name).unwrap().1
    }

    #[test]
    fn linux_variables_in_srts_order() {
        let vars = env_vars(
            EnvPlatform::Linux {
                helper: Path::new("/nix/store/x-pirc/bin/pirc-node"),
            },
            3128,
            1080,
            &auth(),
        );
        assert_eq!(
            names(&vars),
            [
                "NO_PROXY",
                "no_proxy",
                "HTTP_PROXY",
                "HTTPS_PROXY",
                "http_proxy",
                "https_proxy",
                "GIT_CONFIG_PARAMETERS",
                "ALL_PROXY",
                "all_proxy",
                "GRPC_PROXY",
                "grpc_proxy",
                "GIT_SSH_COMMAND",
                "FTP_PROXY",
                "ftp_proxy",
                "RSYNC_PROXY",
                "DOCKER_HTTP_PROXY",
                "DOCKER_HTTPS_PROXY",
                "CLOUDSDK_PROXY_TYPE",
                "CLOUDSDK_PROXY_ADDRESS",
                "CLOUDSDK_PROXY_PORT",
                "CLOUDSDK_PROXY_USERNAME",
                "CLOUDSDK_PROXY_PASSWORD",
            ]
        );
        let http = "http://srt:0123456789abcdef0123456789abcdef@localhost:3128";
        for name in [
            "HTTP_PROXY",
            "https_proxy",
            "ALL_PROXY",
            "grpc_proxy",
            "DOCKER_HTTPS_PROXY",
        ] {
            assert_eq!(get(&vars, name), http, "{name}");
        }
        assert_eq!(
            get(&vars, "FTP_PROXY"),
            "socks5h://srt:0123456789abcdef0123456789abcdef@localhost:1080"
        );
        assert_eq!(get(&vars, "RSYNC_PROXY"), "localhost:1080");
        assert_eq!(get(&vars, "NO_PROXY"), NO_PROXY);
        assert_eq!(
            get(&vars, "GIT_CONFIG_PARAMETERS"),
            "'http.proxyAuthMethod=basic'"
        );
        assert_eq!(get(&vars, "CLOUDSDK_PROXY_PORT"), "3128");
        assert_eq!(
            get(&vars, "GIT_SSH_COMMAND"),
            "ssh -o ControlMaster=no -o ControlPath=none -o ProxyCommand='/nix/store/x-pirc/bin/pirc-node sandbox-bridge connect localhost:3128 srt:0123456789abcdef0123456789abcdef %h %p'"
        );
    }

    #[test]
    fn macos_uses_nc_on_the_socks_port() {
        let vars = env_vars(EnvPlatform::MacOs, 49152, 49152, &auth());
        assert_eq!(
            get(&vars, "GIT_SSH_COMMAND"),
            "ssh -o ControlMaster=no -o ControlPath=none -o ProxyCommand='nc -X 5 -x localhost:49152 %h %p'"
        );
        assert_eq!(get(&vars, "RSYNC_PROXY"), "localhost:49152");
        assert_eq!(vars.len(), 22);
    }

    #[test]
    fn odd_helper_paths_survive_both_shells_and_ssh() {
        let vars = env_vars(
            EnvPlatform::Linux {
                helper: Path::new("/opt/it's 100%/pirc-node"),
            },
            3128,
            1080,
            &auth(),
        );
        let command = get(&vars, "GIT_SSH_COMMAND");
        // What git's shell gives ssh as the option's value...
        let output = std::process::Command::new("/bin/sh")
            .args(["-c", &format!("set -- {command}; printf %s \"$7\"")])
            .output()
            .unwrap();
        let option = String::from_utf8(output.stdout).unwrap();
        let proxy_command = option.strip_prefix("ProxyCommand=").unwrap();
        // ...after ssh's `%%` expansion, is a command whose first word is the helper.
        let expanded = proxy_command.replace("%%", "%");
        let output = std::process::Command::new("/bin/sh")
            .args(["-c", &format!("set -- {expanded}; printf %s \"$1\"")])
            .output()
            .unwrap();
        assert_eq!(
            String::from_utf8(output.stdout).unwrap(),
            "/opt/it's 100%/pirc-node"
        );
    }

    #[test]
    fn basic_credentials() {
        assert_eq!(basic_authorization("srt:tok"), "Basic c3J0OnRvaw==");
        let auth = auth();
        assert!(auth.accepts_basic(Some(&basic_authorization(&format!("srt:{}", auth.token())))));
        assert!(auth.accepts_basic(Some(&format!(
            "basic   {}  ",
            basic_authorization(&format!("anyone:{}", auth.token()))
                .strip_prefix("Basic ")
                .unwrap()
                .trim_end_matches('=')
        ))));
        assert!(!auth.accepts_basic(Some(&basic_authorization(&format!(":{}", auth.token())))));
        assert!(!auth.accepts_basic(Some(&basic_authorization("srt:wrong"))));
        assert!(!auth.accepts_basic(Some(&basic_authorization(auth.token()))));
        assert!(!auth.accepts_basic(Some("Bearer x")));
        assert!(!auth.accepts_basic(Some("Basic !!!")));
        assert!(!auth.accepts_basic(None));
        assert!(auth.accepts_socks(b"srt", auth.token().as_bytes()));
        assert!(auth.accepts_socks(b"srt.Y2F0", auth.token().as_bytes()));
        assert!(!auth.accepts_socks(b"srtx", auth.token().as_bytes()));
        assert!(!auth.accepts_socks(b"srt", b"wrong"));
    }
}
