//! The native Linux backend (`spikes/linux-sandbox`). Owner: **linux-fs** (M7).
//!
//! bubblewrap with srt's argument order and the session policy's paths, a
//! network namespace whose only way out is a filtering HTTP/CONNECT proxy
//! on a Unix socket served by the node itself, and the in-sandbox bridge
//! (`pirc-node sandbox-bridge`, [`super::bridge`]) that exposes the proxy
//! as `127.0.0.1:3128` and then runs the agent. The proxy's allowlist is
//! shared with the session's [`super::NetworkControl`], so an approval
//! widens it in place (no control fd). The agent's stdio passes through
//! unchanged; `--die-with-parent`, and the agent runs in its own PID
//! namespace, so killing bubblewrap (the runner's process group) ends
//! everything inside.
//!
//! # What the native backend does not enforce yet (M7)
//!
//! It applies the policy's paths with a simpler mount plan than srt's
//! `generateFilesystemArgs` (see [`filesystem_args`]), and its proxy is
//! HTTP/CONNECT only. M7 ports srt's algorithm and proxy; until then:
//!
//! - `paths.denyWrite`/`denyRead` entries that do not exist when the agent
//!   starts are not mounted over (srt puts `/dev/null` stubs there), so a
//!   missing `<workspace>/.pirc`, `.git/hooks` or `.git/config` can be
//!   created by the agent; symlinked spellings of denied paths are not
//!   covered either. (Existing ones cannot be renamed away: their writable
//!   ancestors are mount points, see [`filesystem_args`].)
//! - No mandatory deny scan: dangerous files (`.bashrc`, nested
//!   `.git/hooks`, ...) anywhere below a write root other than the listed
//!   paths stay writable.
//! - Rules under `/proc` and `/dev` are dropped (both are mounted afresh),
//!   and a denied `/` is expanded into its children without srt's special
//!   cases.
//! - `--cap-drop ALL` is passed, but the uid-0 and missing-`CAP_SETFCAP`
//!   cases are neither detected nor tested.
//! - `network`: no SOCKS5 (so no `ssh`, `GIT_SSH_COMMAND`, `FTP_PROXY`,
//!   `RSYNC_PROXY`), no TLS termination or resolved-address checks, plain
//!   HTTP only through absolute-form `http://` requests (one request per
//!   connection). `deniedDomains` are checked before the allowlist.
//!   `allowLocalBinding` and `allowUnixSockets` have no effect: the agent
//!   has its own network namespace (its localhost is its own) and Unix
//!   sockets are filtered only by the read rules, as with srt on Linux.
//! - `allowGitConfig` acts only through the policy's `denyWrite` (srt also
//!   used it for its mandatory deny list).

use std::ffi::OsString;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use pirc_config::{Env, NodeConfig};
use pirc_policy::{PathPolicy, is_inside, read_allowed, write_allowed};

use super::common::{self, ProbeCache, Session};
use super::proxy::{self, Allowlist, ProxyListener};
use super::{
    BRIDGE_SUBCOMMAND, BoxFuture, NetworkControl, PrepareInput, Prepared, ReadonlyInput, Sandbox,
    SandboxStatus,
};
use crate::error::{ApiError, ApiResult};

/// Where the in-sandbox bridge listens for HTTP, as srt's socat did.
pub const BRIDGE_PORT: u16 = 3128;
/// Where the in-sandbox bridge listens for SOCKS5, as srt's socat did
/// (the same proxy socket: the proxy tells the protocols apart).
pub const BRIDGE_SOCKS_PORT: u16 = 1080;

/// The proxy socket's name in the session's temporary directory (srt kept
/// its sockets in the temp directory too).
const PROXY_SOCKET: &str = "proxy.sock";

/// `bwrap` on `PATH` (the node's environment), as an executable file.
pub fn find_bwrap(env: &Env) -> Option<PathBuf> {
    env.get("PATH")?
        .split(':')
        .filter(|dir| dir.starts_with('/'))
        .map(|dir| Path::new(dir).join("bwrap"))
        .find(|file| {
            std::fs::metadata(file)
                .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
        })
}

/// What a path's mount gives the agent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Access {
    Hidden,
    ReadOnly,
    Writable,
}

fn access(paths: &PathPolicy, path: &str) -> Access {
    if !read_allowed(paths, path) {
        Access::Hidden
    } else if write_allowed(paths, path) {
        Access::Writable
    } else {
        Access::ReadOnly
    }
}

/// Mounts outside bubblewrap's reach here: `--dev /dev` and `--proc /proc`
/// come after the filesystem and replace them.
fn kernel_path(path: &str) -> bool {
    ["/proc", "/dev"].iter().any(|root| is_inside(path, root))
}

/// bubblewrap's filesystem arguments for `paths`.
///
/// Every existing rule path is a mount point, shallowest first, and gets
/// what [`read_allowed`] and [`write_allowed`] say about it: hidden (a
/// read-only `--tmpfs`, or `/dev/null` over a file), read-only (`--ro-bind`) or
/// writable (`--bind`); a point that would give what its closest mounted
/// ancestor already gives is skipped. Since the rules containing an
/// existing path are exactly those containing its deepest mount point,
/// every path inside the sandbox gets the verdict the file tools compute
/// (a deny-write inside a denied region cannot re-expose it, as the spike's
/// fixed order could). srt's own algorithm (symlinks, missing paths,
/// mandatory deny scan) is M7's; see the module documentation.
///
/// A mount only covers the dentry it sits on, and renaming a directory
/// that merely *contains* mount points is allowed (the mounts move with
/// it; only a mount point itself is `EBUSY`). So a read-only
/// `<ws>/.git/config` would be bypassed by `mv .git .git.bak; mkdir .git`
/// (the host then sees a `.git/config` the agent wrote, and the Git panel
/// runs its filters). Every path the agent may not write whose parent is
/// writable is therefore a mount point, and so is each of its ancestors
/// whose own parent is writable ([`pinned`]): none of them can be renamed,
/// removed or replaced. srt binds the protected files only, so the srt
/// backend (and the TS build) keep this hole (security audit S7).
pub fn filesystem_args(paths: &PathPolicy) -> Vec<String> {
    let mut points: Vec<String> = paths
        .allow_write
        .iter()
        .chain(&paths.deny_read)
        .chain(&paths.allow_read)
        .chain(&paths.deny_write)
        .filter(|path| path.starts_with('/') && *path != "/" && !kernel_path(path))
        .filter(|path| Path::new(path).exists())
        .cloned()
        .collect();
    let root = access(paths, "/");
    if root == Access::Hidden
        && let Ok(entries) = std::fs::read_dir("/")
    {
        // srt expands a denied `/` into its children.
        for entry in entries.flatten() {
            let path = format!("/{}", entry.file_name().to_string_lossy());
            if !kernel_path(&path) {
                points.push(path);
            }
        }
    }
    let pinned = pinned(paths, &points);
    points.extend(pinned.iter().cloned());
    let depth = |path: &str| path.matches('/').count();
    points.sort_by(|a, b| depth(a).cmp(&depth(b)).then_with(|| a.cmp(b)));
    points.dedup();
    let mut args: Vec<String> = Vec::new();
    let mut push = |items: &[&str]| args.extend(items.iter().map(|item| (*item).to_owned()));
    let root_mount = if root == Access::Writable {
        Access::Writable
    } else {
        Access::ReadOnly
    };
    push(&[
        if root_mount == Access::Writable {
            "--bind"
        } else {
            "--ro-bind"
        },
        "/",
        "/",
    ]);
    let mut placed: Vec<(String, Access)> = vec![("/".to_owned(), root_mount)];
    // Hidden directories become read-only once everything inside them is
    // mounted (bubblewrap creates the mount points of nested binds there).
    let mut read_only = Vec::new();
    for point in points {
        let want = access(paths, &point);
        let around = placed
            .iter()
            .filter(|(mounted, _)| is_inside(&point, mounted))
            .max_by_key(|(mounted, _)| mounted.len())
            .map_or(root_mount, |(_, access)| *access);
        // A pinned point inside a region of its own verdict (a directory on
        // the way to a protected path) is bound onto itself.
        if want != around || pinned.contains(&point) {
            match want {
                Access::Hidden if Path::new(&point).is_dir() => {
                    push(&["--tmpfs", &point]);
                    read_only.push(point.clone());
                }
                Access::Hidden => push(&["--ro-bind", "/dev/null", &point]),
                Access::ReadOnly => push(&["--ro-bind", &point, &point]),
                Access::Writable => push(&["--bind", &point, &point]),
            }
        }
        placed.push((point, want));
    }
    for point in read_only {
        args.extend(["--remount-ro".to_owned(), point]);
    }
    args
}

/// The paths that must be mount points so nothing the agent may not write
/// can be renamed away (see [`filesystem_args`]): each existing point the
/// agent may not write, and every ancestor of it, whose parent directory is
/// writable. Ancestors exist since the point does. Symlinks are left out:
/// bubblewrap refuses to mount onto one (`<ws>/.git` may be a link to the
/// real repository), and a symlinked ancestor stays renamable, as with the
/// other symlink cases left to M7.
fn pinned(paths: &PathPolicy, points: &[String]) -> Vec<String> {
    let writable_parent = |path: &Path| {
        path.parent()
            .and_then(Path::to_str)
            .is_some_and(|parent| access(paths, parent) == Access::Writable)
    };
    let mut pinned: Vec<String> = Vec::new();
    for point in points {
        if access(paths, point) == Access::Writable {
            continue;
        }
        for path in Path::new(point).ancestors() {
            if path == Path::new("/") {
                break;
            }
            let Some(text) = path.to_str() else {
                continue;
            };
            let symlink = std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink());
            if !symlink
                && writable_parent(path)
                && !kernel_path(text)
                && !pinned.iter().any(|p| p == text)
            {
                pinned.push(text.to_owned());
            }
        }
    }
    pinned
}

/// bubblewrap's arguments up to the command, in srt's order (namespaces,
/// environment, filesystem, `/dev`, PID and user namespaces, capabilities,
/// `/proc`). The proxy socket is bound after the filesystem rather than
/// before it, so no mount of the plan can cover it.
pub fn bwrap_args(
    paths: &PathPolicy,
    tmp: &str,
    socket: &str,
    proxy_env: &[(String, String)],
) -> Vec<OsString> {
    let mut args: Vec<String> = ["--new-session", "--die-with-parent", "--unshare-net"]
        .map(String::from)
        .to_vec();
    let mut setenv: Vec<(String, String)> = vec![
        ("SANDBOX_RUNTIME".to_owned(), "1".to_owned()),
        ("TMPDIR".to_owned(), tmp.to_owned()),
    ];
    setenv.extend(proxy_env.iter().cloned());
    // Not srt's: says which kind of sandbox this is.
    setenv.push(("PIRC_SANDBOX_BACKEND".to_owned(), "native".to_owned()));
    for (name, value) in setenv {
        args.extend(["--setenv".to_owned(), name, value]);
    }
    args.extend(filesystem_args(paths));
    args.extend(["--bind".to_owned(), socket.to_owned(), socket.to_owned()]);
    args.extend(
        [
            "--dev",
            "/dev",
            "--unshare-pid",
            "--unshare-user",
            // What keeps a command running as uid 0 from unmounting a
            // denial, without srt's seccomp helper (pirc's case).
            "--cap-drop",
            "ALL",
            "--proc",
            "/proc",
        ]
        .map(String::from),
    );
    args.into_iter().map(OsString::from).collect()
}

/// The native backend.
pub struct NativeSandbox {
    config: NodeConfig,
    env: Env,
    /// The `pirc-node` executable that has the `sandbox-bridge` subcommand.
    helper: PathBuf,
    probe: ProbeCache,
    /// Connections every session's proxy may still open together.
    connections: Arc<tokio::sync::Semaphore>,
}

impl NativeSandbox {
    pub fn new(config: NodeConfig, env: Env, helper: PathBuf) -> Self {
        Self {
            config,
            env,
            helper,
            probe: ProbeCache::default(),
            connections: Arc::new(tokio::sync::Semaphore::new(proxy::MAX_NODE_CONNECTIONS)),
        }
    }

    /// The proxy variables for the bridge's ports (`GIT_SSH_COMMAND` runs
    /// the helper's `sandbox-bridge connect`).
    fn proxy_env(&self, auth: &proxy::ProxyAuth) -> Vec<(String, String)> {
        let platform = proxy::EnvPlatform::Linux {
            helper: &self.helper,
        };
        proxy::env_vars(platform, BRIDGE_PORT, BRIDGE_SOCKS_PORT, auth)
    }

    /// `bwrap` with `args`, then the bridge on `socket` running `command`.
    fn command_args(
        &self,
        args: Vec<OsString>,
        socket: &Path,
        command: &[OsString],
    ) -> Vec<OsString> {
        let mut out = args;
        out.extend([
            "--".into(),
            self.helper.clone().into(),
            BRIDGE_SUBCOMMAND.into(),
            socket.into(),
            "--".into(),
        ]);
        out.extend(command.iter().cloned());
        out
    }

    /// `/bin/sh -c 'exit 0'` through the whole stack (namespaces, the
    /// bridge's listener), with nothing allowed.
    async fn probe(&self) -> SandboxStatus {
        let Some(bwrap) = find_bwrap(&self.env) else {
            return SandboxStatus::Unavailable {
                reason: "bubblewrap (bwrap) was not found on PATH".to_owned(),
            };
        };
        let tmp = match common::make_temp_dir(&common::tmpdir(&self.env), "pirc-") {
            Ok(tmp) => tmp,
            Err(error) => {
                return SandboxStatus::Unavailable {
                    reason: format!("bubblewrap: {error}"),
                };
            }
        };
        let socket = tmp.join(PROXY_SOCKET);
        // Bound but never served: the probe only needs the file to bind.
        let status = match std::os::unix::net::UnixListener::bind(&socket) {
            Err(error) => SandboxStatus::Unavailable {
                reason: format!("bubblewrap: {error}"),
            },
            Ok(_listener) => {
                let tmp_text = tmp.display().to_string();
                let proxy_env = self.proxy_env(&proxy::ProxyAuth::generate());
                let args = self.command_args(
                    bwrap_args(
                        &PathPolicy::default(),
                        &tmp_text,
                        &socket.display().to_string(),
                        &proxy_env,
                    ),
                    &socket,
                    &["/bin/sh".into(), "-c".into(), "exit 0".into()],
                );
                let mut command = tokio::process::Command::new(&bwrap);
                command.args(args);
                common::run_probe(
                    "bubblewrap",
                    command,
                    format!("bubblewrap: {}", bwrap.display()),
                )
                .await
            }
        };
        Session::remove_tmp(&tmp);
        status
    }
}

impl Sandbox for NativeSandbox {
    fn check(&self) -> BoxFuture<'_, SandboxStatus> {
        Box::pin(self.probe.get(|| self.probe()))
    }

    fn prepare(&self, input: PrepareInput) -> BoxFuture<'_, ApiResult<Prepared>> {
        Box::pin(async move {
            let Session {
                tmp,
                policy,
                warnings,
            } = common::session(&self.config, &self.env, &input)?;
            let bwrap = match self.check().await {
                SandboxStatus::Unavailable { reason } => {
                    Session::remove_tmp(&tmp);
                    return Err(super::unavailable_error(&reason));
                }
                SandboxStatus::Active { .. } => find_bwrap(&self.env),
            };
            let Some(bwrap) = bwrap else {
                Session::remove_tmp(&tmp);
                return Err(super::unavailable_error(
                    "bubblewrap (bwrap) was not found on PATH",
                ));
            };
            let socket = tmp.join(PROXY_SOCKET);
            let listener = match tokio::net::UnixListener::bind(&socket) {
                Ok(listener) => listener,
                Err(error) => {
                    Session::remove_tmp(&tmp);
                    crate::log::error(&format!("cannot start the sandbox proxy: {error}"));
                    return Err(ApiError::internal());
                }
            };
            let allowlist = Arc::new(Allowlist::new(
                policy.network.allowed_domains.clone(),
                policy.network.denied_domains.clone(),
            ));
            let auth = Arc::new(proxy::ProxyAuth::generate());
            let proxy_env = self.proxy_env(&auth);
            let proxy = tokio::spawn(proxy::serve(
                ProxyListener::Unix(listener),
                allowlist.clone(),
                auth,
                self.connections.clone(),
            ));
            let tmp_text = tmp.display().to_string();
            let mut agent: Vec<OsString> = vec![self.config.agent_command.clone().into()];
            agent.extend(self.config.agent_args.iter().map(OsString::from));
            let args = self.command_args(
                bwrap_args(
                    &policy.paths,
                    &tmp_text,
                    &socket.display().to_string(),
                    &proxy_env,
                ),
                &socket,
                &agent,
            );
            Ok(Prepared::new(
                bwrap,
                args,
                vec![("CLAUDE_CODE_TMPDIR".to_owned(), tmp_text)],
                policy,
                warnings,
                Some(Box::new(NativeControl { allowlist })),
                move || {
                    proxy.abort();
                    Session::remove_tmp(&tmp);
                },
            ))
        })
    }

    fn prepare_readonly(&self, input: ReadonlyInput) -> BoxFuture<'_, ApiResult<Prepared>> {
        // M7 (linux-fs): bubblewrap with `common::readonly_session`'s
        // policy (`filesystem_args`), `--unshare-net` and no proxy or
        // bridge, running `input.command` in `input.cwd`.
        let _ = input;
        todo!("M7 linux-fs: the read-only sandbox for panel git")
    }
}

/// Approvals widen the proxy's allowlist directly.
struct NativeControl {
    allowlist: Arc<Allowlist>,
}

impl NetworkControl for NativeControl {
    fn prepare_command(&self, command: &mut tokio::process::Command) -> std::io::Result<()> {
        let _ = command;
        Ok(())
    }

    fn is_open(&self) -> bool {
        true
    }

    fn approve(&self, approved: &[String]) -> Result<(), String> {
        self.allowlist.set_approved(approved);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    fn rules(root: &str) -> PathPolicy {
        let p = |rest: &str| format!("{root}/{rest}");
        PathPolicy {
            deny_read: vec![
                p("home/.ssh"),
                p("state"),
                p("state/sessions"),
                p("secret.txt"),
            ],
            allow_read: vec![p("ws"), p("state/sessions/s1"), p("state/i-1")],
            allow_write: vec![p("ws"), p("state/sessions/s1"), p("missing")],
            deny_write: vec![
                p("ws/.pirc"),
                p("ws/.git/config"),
                p("home/.ssh"),
                p("home/.bashrc"),
            ],
            shared_write: None,
        }
    }

    #[test]
    fn mounts_follow_the_policy_verdicts() {
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap().display().to_string();
        let p = |rest: &str| format!("{root}/{rest}");
        for dir in ["home/.ssh", "state/sessions/s1", "state/i-1", "ws/.git"] {
            fs::create_dir_all(p(dir)).unwrap();
        }
        for file in ["home/.bashrc", "secret.txt", "ws/.git/config"] {
            fs::write(p(file), "").unwrap();
        }
        let args = filesystem_args(&rules(&root));
        let expected: Vec<String> = [
            "--ro-bind",
            "/",
            "/",
            "--ro-bind",
            "/dev/null",
            &p("secret.txt"),
            "--tmpfs",
            &p("state"),
            "--bind",
            &p("ws"),
            &p("ws"),
            // Denied for writing and reading: hidden stays hidden (the
            // spike's order re-exposed it read-only).
            "--tmpfs",
            &p("home/.ssh"),
            "--ro-bind",
            &p("state/i-1"),
            &p("state/i-1"),
            // Pinned, so `.git` cannot be renamed away from `config`.
            "--bind",
            &p("ws/.git"),
            &p("ws/.git"),
            // Hidden inside hidden: nothing to do. The session dir comes back.
            "--bind",
            &p("state/sessions/s1"),
            &p("state/sessions/s1"),
            "--ro-bind",
            &p("ws/.git/config"),
            &p("ws/.git/config"),
            "--remount-ro",
            &p("state"),
            "--remount-ro",
            &p("home/.ssh"),
        ]
        .map(String::from)
        .to_vec();
        // `home/.bashrc` is read-only, as `/` already is; `ws/.pirc` and
        // `missing` do not exist (M7).
        assert_eq!(args, expected);
    }

    #[test]
    fn every_writable_directory_above_a_protected_path_is_a_mount_point() {
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap().display().to_string();
        let p = |rest: &str| format!("{root}/{rest}");
        for dir in ["home/.config/.pirc", "home/a/b", "home/.ssh/keys", "ro/x"] {
            fs::create_dir_all(p(dir)).unwrap();
        }
        fs::write(p("home/a/b/c"), "").unwrap();
        fs::write(p("ro/x/y"), "").unwrap();
        let paths = PathPolicy {
            deny_read: vec![p("home/.ssh")],
            allow_write: vec![p("home")],
            deny_write: vec![
                p("home/.config/.pirc"),
                p("home/a/b/c"),
                p("home/.ssh"),
                // Inside a hidden directory, or with a read-only parent:
                // nothing to rename.
                p("home/.ssh/keys"),
                p("ro/x/y"),
            ],
            ..PathPolicy::default()
        };
        let args = filesystem_args(&paths);
        let expected: Vec<String> = [
            "--ro-bind",
            "/",
            "/",
            "--bind",
            &p("home"),
            &p("home"),
            "--bind",
            &p("home/.config"),
            &p("home/.config"),
            "--tmpfs",
            &p("home/.ssh"),
            "--bind",
            &p("home/a"),
            &p("home/a"),
            "--ro-bind",
            &p("home/.config/.pirc"),
            &p("home/.config/.pirc"),
            "--bind",
            &p("home/a/b"),
            &p("home/a/b"),
            "--ro-bind",
            &p("home/a/b/c"),
            &p("home/a/b/c"),
            "--remount-ro",
            &p("home/.ssh"),
        ]
        .map(String::from)
        .to_vec();
        assert_eq!(args, expected);
    }

    #[test]
    fn symlinked_ancestors_are_not_pinned() {
        // `<ws>/.git` linking to the real repository (worktrees, dotfile
        // managers): bubblewrap cannot mount onto the link.
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap().display().to_string();
        let p = |rest: &str| format!("{root}/{rest}");
        fs::create_dir_all(p("repo")).unwrap();
        fs::create_dir_all(p("ws")).unwrap();
        fs::write(p("repo/config"), "").unwrap();
        std::os::unix::fs::symlink(p("repo"), p("ws/.git")).unwrap();
        let paths = PathPolicy {
            allow_write: vec![p("ws")],
            deny_write: vec![p("ws/.git/config")],
            ..PathPolicy::default()
        };
        let args = filesystem_args(&paths);
        assert!(!args.contains(&p("ws/.git")), "{args:?}");
        assert!(
            args.windows(3)
                .any(|w| w == ["--ro-bind", &p("ws/.git/config"), &p("ws/.git/config")]),
            "{args:?}"
        );
    }

    #[test]
    fn a_denied_root_is_expanded_and_kernel_paths_are_left_alone() {
        let paths = PathPolicy {
            deny_read: vec!["/".into(), "/proc/1".into()],
            allow_read: vec!["/usr".into()],
            ..PathPolicy::default()
        };
        let args = filesystem_args(&paths);
        assert_eq!(args[..3], ["--ro-bind", "/", "/"]);
        assert!(args.windows(2).any(|w| w == ["--tmpfs", "/etc"]));
        assert!(
            !args
                .iter()
                .any(|arg| arg == "/usr" || arg.starts_with("/proc"))
        );
    }

    #[test]
    fn bwrap_arguments_keep_srts_order() {
        let proxy_env = proxy::env_vars(
            proxy::EnvPlatform::Linux {
                helper: Path::new("/bin/pirc-node"),
            },
            BRIDGE_PORT,
            BRIDGE_SOCKS_PORT,
            &proxy::ProxyAuth::generate(),
        );
        let args: Vec<String> = bwrap_args(
            &PathPolicy::default(),
            "/tmp/pirc-x",
            "/tmp/pirc-x/proxy.sock",
            &proxy_env,
        )
        .into_iter()
        .map(|arg| arg.into_string().unwrap())
        .collect();
        assert_eq!(
            args[..3],
            ["--new-session", "--die-with-parent", "--unshare-net"]
        );
        let position = |item: &str| args.iter().position(|arg| arg == item).unwrap();
        assert!(position("--setenv") < position("--ro-bind"));
        assert!(position("--ro-bind") < position("--bind"));
        assert!(position("--bind") < position("--dev"));
        assert_eq!(
            args[position("--dev")..],
            [
                "--dev",
                "/dev",
                "--unshare-pid",
                "--unshare-user",
                "--cap-drop",
                "ALL",
                "--proc",
                "/proc"
            ]
        );
        let at = position("TMPDIR");
        assert_eq!(args[at + 1], "/tmp/pirc-x");
        let at = position("HTTPS_PROXY");
        assert!(args[at + 1].starts_with("http://srt:"), "{}", args[at + 1]);
        assert!(
            args[at + 1].ends_with("@localhost:3128"),
            "{}",
            args[at + 1]
        );
    }

    #[test]
    fn finds_bwrap_on_path_only() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("bin");
        fs::create_dir(&bin).unwrap();
        let path = format!("relative:{}", bin.display());
        let env = Env::new([("PATH", path.as_str())], "/");
        assert_eq!(find_bwrap(&env), None);
        fs::write(bin.join("bwrap"), "").unwrap();
        assert_eq!(find_bwrap(&env), None, "not executable");
        fs::set_permissions(bin.join("bwrap"), fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(find_bwrap(&env), Some(bin.join("bwrap")));
        assert_eq!(find_bwrap(&Env::new([], "/")), None);
    }
}
