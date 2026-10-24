//! bubblewrap's filesystem arguments for a session policy: M6's verdict
//! planner with srt's `generateFilesystemArgs` cases ported into it.
//!
//! Ported from sandbox-runtime 0.0.78 `sandbox/linux-sandbox-utils.js`
//! (`generateFilesystemArgs`, `resolveSymlinkedDenyPath`,
//! `findSymlinkInPath`, `hasFileAncestor`, `findFirstNonExistentComponent`,
//! `isStaleBwrapMountPoint`, `ancestorPinArgs`, `cleanupBwrapMountPoints`,
//! `KERNEL_TOP_LEVEL_DIRS`) and `sandbox/sandbox-utils.js` (`isAtOrUnder`,
//! `isAbsenceErrno`) (Apache-2.0, see `crates/pirc-node/NOTICE`).
//!
//! # The invariant
//!
//! Every path inside the sandbox gets the verdict [`read_allowed`] and
//! [`write_allowed`] compute for it (hidden, read-only or writable) under the
//! *effective* policy: the session policy with its rules resolved through
//! symlinks as srt resolves them, plus what srt (and this port) denies on
//! top of it. Those additions only ever take access away:
//!
//! - the mandatory deny paths of the working directory ([`super::scan`]);
//! - `/etc/ssh/ssh_config.d` hidden (srt hides it whenever there is a read
//!   policy, which pirc always has);
//! - the host's name-service sockets hidden ([`RESOLVER_SOCKETS`], not
//!   srt's: they resolve names past the proxy);
//! - WSL's interop directory hidden whole ([`WSL_INTEROP_DIR`], not srt's:
//!   its sockets start Windows programs outside the sandbox);
//! - the node's uid's `/tmp/ssh-*` directories hidden, where sshd puts
//!   forwarded agents' sockets ([`SSH_AGENT_TMP`], not srt's);
//! - every other Unix socket bound on the host when the plan is made
//!   hidden, but those the agent may reach ([`Options::allowed_sockets`]:
//!   the inference socket, `allowUnixSockets`, the nix daemon's)
//!   ([`host_unix_sockets`], not srt's);
//! - for a denied path that does not exist, its first missing component
//!   (srt's stub, below);
//! - for a denied path below a *file* (a worktree's `.git` file), that file
//!   (not srt's: srt skips such a path, since nothing can be created below
//!   a file, but the agent could replace the file with a directory);
//! - for a denied path that cannot be inspected (a parent the agent made
//!   unsearchable), its deepest inspectable ancestor, with nothing restored
//!   below it (srt's stand-in).
//!
//! # srt's cases, as mounts
//!
//! - **Resolve before mask.** Deny rules are resolved through every symlink
//!   ([`resolve_symlinked_deny_path`], dangling links followed), allow rules
//!   only through their parents (srt's `nameLocationOf`: a rule naming a
//!   link re-allows nothing the link points at). No mount ever lands on a
//!   symlink, which bubblewrap refuses ("Can't mount on symlink
//!   destination").
//! - **Symlinked spellings fail closed.** A protected path (a deny rule of
//!   the policy, or a mandatory deny path) reached through a symlink that
//!   lies in a directory the agent may write could be re-pointed: the agent
//!   removes the link and creates the path for real, and host tools (git,
//!   the node reading `<ws>/.pirc`) follow the spelling. bubblewrap cannot
//!   pin a link, so the plan is refused instead ([`Refusal`]): srt's
//!   `findSymlinkInPath` intent, which it only checked on the resolved path
//!   (where it never hits), applied to the spelling. Every link crossed
//!   while the spelling resolves counts, the links a link's target leads
//!   through included (`/entry -> /hop -> /real`), and so does every
//!   directory a link's target leaves through `..` ([`walk_links`]) that
//!   the agent may write (one it may not write is pinned). The resolved
//!   target is protected as srt protects it. Decided with the user
//!   (M7); no opt-out. The policy lists some denies only resolved (the
//!   sensitive home paths, private, read-only and protected paths, the
//!   agent config dir): their spellings come from
//!   `SessionPolicy::linked_denies`, and the node's own spellings of its
//!   config and state directories are checked too ([`Options::spellings`]):
//!   a replaced link there would hand the node a config (`allowedPaths`)
//!   the agent wrote. Host sockets ([`Options::host_sockets`]: the
//!   policy's `LINUX_HOST_SOCKETS` and `SSH_AUTH_SOCK`, as spelled) are
//!   exempt: they are hidden from reading, not protected for host tools, and
//!   a stable link in `/tmp` to the ssh-agent's socket (tmux's recipe) would
//!   otherwise refuse every session. Their targets at plan time are hidden
//!   as for any deny, and sshd's agent directories wholesale
//!   ([`SSH_AGENT_TMP`]); the link itself stays visible, and writable in
//!   `/tmp` (see the accepted gaps).
//! - **Missing deny paths** whose deepest existing ancestor the agent may
//!   write get a read-only placeholder on their first missing component:
//!   `/dev/null` when that is the path itself, an empty directory when it is
//!   an ancestor of it (srt's "Fix 2"; one placeholder per destination, the
//!   directory winning). srt bound an empty host directory there; this uses
//!   a read-only tmpfs, which needs no host source to keep unwritable.
//!   Missing read denies get one too, hidden (not srt's, which placed them
//!   for write denies only: the agent could create the path and read what
//!   it put or the host later puts there). A missing name holding `*`, `?`
//!   or `[` gets none (a glob, taken literally: the placeholder would be a
//!   stray `**` on the host). bubblewrap creates each placeholder's mount
//!   point on the host; they are tracked ([`MountPoints`]) and removed when
//!   the last sandbox using them ends. srt took any empty file without
//!   write bits at a deny path for a placeholder an earlier run left
//!   behind, and removed it: that deletes a user's own empty read-only
//!   file. Here the node records the placeholders it makes
//!   ([`Options::record`], `<state>/sandbox/placeholders`), and only a
//!   recorded one is removed (at the node's start, [`sweep_record`]) or
//!   tracked again; an unrecorded match is covered with `/dev/null` (as srt
//!   did) but left in place. An empty directory where another sandbox's
//!   directory placeholder is (or a recorded one) is that placeholder,
//!   claimed again with nothing planned below it (planned as the user's,
//!   the later session's placeholders inside would keep it from ever being
//!   removed), unless the policy allows something at or below it.
//! - **A denied `/`** is expanded into its children (srt: a tmpfs on `/`
//!   would wipe every mount before it), without `/proc`, `/dev` and `/sys`,
//!   each child at its canonical location (`/bin` may link to `/usr/bin`).
//! - **`/proc` and `/dev`**: `--proc` and `--dev` replace both after the
//!   filesystem, so srt's rules there were buried by them; they are dropped
//!   here (a deny resolving into `/dev` too). Rules under `/sys` apply.
//! - **Pinning (security audit S7, not srt's)**: every path the agent may
//!   not write, placeholders included, whose parent it may write is a mount
//!   point, and so is each such ancestor, so none can be renamed away (srt
//!   pins only up to its deny binds, and not under a `/` write root without
//!   its "covers"; the verdict plan needs neither).
//!
//! # Accepted gaps
//!
//! Mounts are by path, as in srt: each holds the file or directory its
//! path named when bubblewrap mounted it, a moment after the plan.
//!
//! - A host-side replace of a protected path detaches the sandbox's mount
//!   on it. Since Linux 3.18 the host may unlink or rename over a path that
//!   is a mount point only in another mount namespace, and the kernel then
//!   detaches those mounts there. The running sandbox sees the new file
//!   through its parent's writable bind, unprotected. Common host
//!   operations do this: `git config` (and `git remote`, `git branch -u`,
//!   `git push -u`, `git checkout -b x origin/x`) rewrites `.git/config`
//!   through `config.lock` and a rename; a checkout or pull of tracked
//!   `.vscode/`, `.claude/`, `.mcp.json` or rc files replaces them; an
//!   editor's atomic save replaces `.env` or `.bashrc`. The agent can then
//!   write `.git/config` (`core.fsmonitor`, `core.pager`: host code on the
//!   next host git command) or read the new `.env`; a placeholder the host
//!   replaces goes the same way. srt behaves the same (its binds are by
//!   path too); the pinning (S7) only stops renames from inside the
//!   sandbox. Not mitigated: an open item for the M7 security gate.
//! - A symlink retargeted between planning and bubblewrap's start is
//!   followed by bubblewrap, wherever it now leads (the plan resolved it
//!   before). This session's agent does not run before its sandbox exists,
//!   and the links of protected spellings lie where it may not write
//!   (otherwise the plan refuses). Other sessions' agents do run: one whose
//!   policy lets it write where such a link lies (its own workspace,
//!   `/tmp`) can retarget it in that window.
//! - A host socket spelled through a link (`SSH_AUTH_SOCK` in tmux's
//!   layout, `/tmp/ssh-agent-$USER`) is hidden where the link led at plan
//!   time. The link stays visible and, in `/tmp`, writable by every
//!   session. Retargeted later (each tmux reattach), or by another
//!   session's agent to a decoy while this one plans, it leads to a socket
//!   that is hidden only if it lies in a `/tmp/ssh-*` directory that
//!   existed at plan time ([`SSH_AGENT_TMP`]). A `/tmp/ssh-*` directory
//!   made after the plan (a reattach, another login during the session)
//!   is visible in running sandboxes, which bind the host's `/tmp`: its
//!   agent socket is reachable through the link or by name. One removed
//!   between the plan and bubblewrap's mounts (its login ending as a
//!   session starts) fails that start (bubblewrap cannot create or
//!   remount it), or bubblewrap makes it again, empty, on the host: fail
//!   closed, and an empty leftover.
//! - Unix sockets are hidden by path, as bound when the plan is made
//!   ([`host_unix_sockets`]); connects are not filtered otherwise (no
//!   seccomp, see `linux.rs`). A socket a host daemon binds later (a
//!   daemon restarting under a new name, a new login's) is reachable in
//!   running sandboxes (but in WSL's interop directory, hidden whole:
//!   [`WSL_INTEROP_DIR`]), and so is a socket file bound in another network
//!   namespace (not in the node's `/proc/net/unix`), or bound by a
//!   relative path (listed without its directory). A socket removed
//!   between the plan and bubblewrap's mounts goes as above: the start
//!   fails, or, where the agent may write (`/tmp`), bubblewrap leaves an
//!   empty file on the host in its place, which a daemon binding that
//!   path again without removing it first finds in its way. The window is
//!   the moment between a plan and its mounts; nodes' own per-session
//!   proxy sockets, which come and go with sessions, are not hidden
//!   ([`in_node_tmp`]).
//! - A hard link to a protected file that already existed (in a writable
//!   root, say) is another name for it that no deny covers: writing through
//!   it writes the file. The agent cannot make one during its session: a
//!   protected path is a mount point, and `link(2)` across mounts fails
//!   with `EXDEV` (`tests/sandbox_native.rs` tries it); nor before, as
//!   it does not run yet. Another session's agent can, where its own
//!   policy puts no mount on the file and lets it write next to it.

use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use pirc_policy::session::walk_links;
use pirc_policy::{PathPolicy, is_inside, read_allowed, resolve_path, write_allowed};

use super::scan;

/// `MAX_SYMLINK_RESOLUTION_DEPTH`: the kernel's `ELOOP` bound.
const MAX_SYMLINK_DEPTH: usize = 40;

/// `KERNEL_TOP_LEVEL_DIRS`: never expanded from `/`, never pinned.
const KERNEL_TOP_LEVEL_DIRS: [&str; 3] = ["/proc", "/dev", "/sys"];

/// srt's `/etc/ssh/ssh_config.d`: hidden whenever there is a read policy
/// (ssh is strict about its ownership, which looks wrong in the sandbox).
const SSH_CONFIG_D: &str = "/etc/ssh/ssh_config.d";

/// The host's name-service sockets (nscd, systemd-resolved, sssd, avahi),
/// hidden whenever there is a read policy. Not srt's, and not in the
/// policy's `LINUX_HOST_SOCKETS` (the srt backend's recorded settings keep
/// TS's shape): through them glibc's NSS has the host resolve any name,
/// and the query reaches the name's authoritative server whatever the
/// allowlist says (a DNS exfiltration channel past the proxy). Nothing in
/// the sandbox needs them: its network namespace has no route to a
/// resolver, and clients reach names through the proxy (`CONNECT host`,
/// `socks5h`). systemd-resolved's are its two Varlink sockets, not
/// `/run/systemd/resolve` whole: `/etc/resolv.conf` usually links to
/// `stub-resolv.conf` there, and tools that read it at start-up (`dig`,
/// `host`, some runtimes) would fail on a dangling link instead of timing
/// out (no route). Its D-Bus name answers on the system bus, whose socket
/// the policy already hides (`LINUX_HOST_SOCKETS`).
pub const RESOLVER_SOCKETS: [&str; 6] = [
    "/run/nscd",
    "/var/run/nscd",
    "/run/systemd/resolve/io.systemd.Resolve",
    "/run/systemd/resolve/io.systemd.Resolve.Monitor",
    "/var/lib/sss/pipes",
    "/run/avahi-daemon/socket",
];

/// WSL's interop servers' directory (`WSL_TEMP_FOLDER`, each server's
/// socket `<pid>_interop` in it), hidden whole whenever there is a read
/// policy. Not srt's. Through one, executing a Windows program (the
/// kernel hands it to `/init`, WSL's `binfmt_misc` interpreter) starts it
/// on Windows, outside the sandbox: past the proxy, and past the read and
/// write rules. Each new WSL session (a terminal, `wsl.exe`) binds a new
/// socket there, so hiding the sockets bound at plan time
/// ([`host_unix_sockets`]) left a later one reachable; a tmpfs over the
/// directory hides those too. Nothing else lives there. A host without the
/// directory at plan time gets no rule (WSL makes it at boot).
pub const WSL_INTEROP_DIR: &str = "/run/WSL";

/// Where sshd puts forwarded agents' sockets (`ssh-XXXXXXXXXX/agent.<pid>`,
/// OpenSSH's fixed layout), and `ssh-agent` its own (in `$TMPDIR`, this by
/// default). Each `ssh-*` directory here the node's uid owns when the plan
/// is made is hidden whenever there is a read policy ([`ssh_agent_dirs`]).
/// Not srt's: `SSH_AUTH_SOCK`'s target is hidden as a policy deny, but in
/// tmux's layout that is a link in `/tmp` each reattach points at a new
/// forwarded socket, and other logins' sockets are never named at all.
/// A directory made after the plan stays visible (see the accepted gaps).
pub const SSH_AGENT_TMP: &str = "/tmp";

/// The `ssh-*` directories (not links) in `tmp` that `uid` owns, each at
/// its canonical path ([`SSH_AGENT_TMP`]).
pub fn ssh_agent_dirs(tmp: &str, uid: u32) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(tmp) else {
        return Vec::new();
    };
    let mut dirs: Vec<String> = entries
        .flatten()
        .filter(|entry| entry.file_name().to_string_lossy().starts_with("ssh-"))
        .filter(|entry| {
            std::fs::symlink_metadata(entry.path())
                .is_ok_and(|meta| meta.is_dir() && meta.uid() == uid)
        })
        .filter_map(|entry| std::fs::canonicalize(entry.path()).ok())
        .map(|dir| text(&dir))
        .collect();
    dirs.sort();
    dirs
}

/// The nix daemon's socket: reachable from a session by default (decided
/// with the user, 2026-10-16), so builds work in the sandbox. The daemon
/// fetches for its clients past the proxy; auto mode's classification
/// of the commands that ask it to is the guard.
pub const NIX_DAEMON_SOCKET: &str = "/nix/var/nix/daemon-socket/socket";

/// The kernel's list of this network namespace's Unix sockets.
pub const PROC_NET_UNIX: &str = "/proc/net/unix";

/// The paths bound in `/proc/net/unix`'s text (each once, in order):
/// `Num RefCount Protocol Flags Type St Inode Path`, the path last and
/// possibly holding spaces; abstract names (`@...`) and unbound sockets
/// have none worth hiding (abstract names belong to a network namespace,
/// and the sandbox has its own).
pub fn parse_proc_net_unix(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in text.lines().skip(1) {
        let mut rest = line.trim_start();
        for _ in 0..7 {
            match rest.find(char::is_whitespace) {
                Some(end) => rest = rest[end..].trim_start(),
                None => {
                    rest = "";
                    break;
                }
            }
        }
        if rest.starts_with('/') && !out.iter().any(|path| path == rest) {
            out.push(rest.to_owned());
        }
    }
    out
}

/// The name prefix of a node's private parent of its sessions' temporary
/// directories (`common::NodeTmp`).
const NODE_TMP_PREFIX: &str = "pirc-n-";

/// Whether `path` lies in a node's private temporary parent
/// ([`NODE_TMP_PREFIX`], a directory this uid owns): a session's proxy
/// socket, or a probe's. Not hidden: each answers only its session's
/// credentials, and they come and go with sessions, so one hidden at plan
/// time could be gone before bubblewrap mounts on it, failing the start
/// (see the accepted gaps). Registered node parents, including peers, are
/// independently hidden as private directories by the account registry.
fn in_node_tmp(path: &str) -> bool {
    let uid = nix::unistd::getuid().as_raw();
    Path::new(path).ancestors().skip(1).any(|dir| {
        dir.file_name()
            .is_some_and(|name| name.to_string_lossy().starts_with(NODE_TMP_PREFIX))
            && std::fs::symlink_metadata(dir).is_ok_and(|meta| meta.is_dir() && meta.uid() == uid)
    })
}

/// The Unix sockets bound on the host that the plan hides: each path of
/// [`PROC_NET_UNIX`] that is a socket in the node's view, at its
/// canonical path, but `allowed` (canonical paths) and the sessions' proxy
/// sockets ([`in_node_tmp`]). The list covers the
/// node's network namespace only: a socket file a daemon in another one
/// bound (a container's, bind-mounted out) is not listed, and stays
/// reachable unless a rule hides it (`LINUX_HOST_SOCKETS`). Sockets bound
/// after the plan stay visible too (see the accepted gaps).
pub fn host_unix_sockets(proc_text: &str, allowed: &[String]) -> Vec<String> {
    use std::os::unix::fs::FileTypeExt;
    let mut out: Vec<String> = Vec::new();
    for path in parse_proc_net_unix(proc_text) {
        let Ok(real) = std::fs::canonicalize(&path) else {
            continue;
        };
        if !std::fs::metadata(&real).is_ok_and(|meta| meta.file_type().is_socket()) {
            continue;
        }
        let real = text(&real);
        if !allowed.contains(&real)
            && !kernel_path(&real)
            && !in_node_tmp(&real)
            && !out.contains(&real)
        {
            out.push(real);
        }
    }
    out
}

/// What a path's mount gives the agent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Access {
    Hidden,
    ReadOnly,
    Writable,
}

/// The verdict for `path` under `paths`.
pub fn access(paths: &PathPolicy, path: &str) -> Access {
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
pub fn kernel_path(path: &str) -> bool {
    ["/proc", "/dev"].iter().any(|root| is_inside(path, root))
}

fn kernel_top_level(path: &str) -> bool {
    KERNEL_TOP_LEVEL_DIRS
        .iter()
        .any(|root| is_inside(path, root))
}

fn text(path: &Path) -> String {
    path.display().to_string()
}

fn parent(path: &str) -> String {
    Path::new(path)
        .parent()
        .map_or_else(|| "/".to_owned(), text)
}

fn join(dir: &str, name: &str) -> String {
    if dir == "/" {
        format!("/{name}")
    } else {
        format!("{dir}/{name}")
    }
}

/// `resolveSymlinkedDenyPath`: `path` with every symlink resolved; for a
/// path that does not exist, its deepest existing ancestor resolved and the
/// missing components joined back, a dangling link on the way followed (so
/// the deny lands where a write through the link would create the file).
/// `None` for a cycle or a chain past [`MAX_SYMLINK_DEPTH`].
pub fn resolve_symlinked_deny_path(path: &str) -> Option<String> {
    let mut current = path.to_owned();
    for _ in 0..MAX_SYMLINK_DEPTH {
        if let Ok(real) = std::fs::canonicalize(&current) {
            return Some(text(&real));
        }
        let mut ancestor = current.clone();
        let mut remainder: Vec<String> = Vec::new();
        let resolved = loop {
            let up = parent(&ancestor);
            if up == ancestor {
                return None;
            }
            let name = Path::new(&ancestor)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            remainder.insert(0, name);
            ancestor = up;
            if let Ok(real) = std::fs::canonicalize(&ancestor) {
                break text(&real);
            }
        };
        let first_missing = join(&resolved, &remainder[0]);
        match std::fs::read_link(&first_missing) {
            Err(_) => {
                return Some(
                    remainder
                        .iter()
                        .fold(resolved, |dir, name| join(&dir, name)),
                );
            }
            Ok(target) => {
                let target = resolve_path(&resolved, &target.to_string_lossy());
                current = resolve_path(&target, &remainder[1..].join("/"));
            }
        }
    }
    None
}

/// srt's `nameLocationOf`: the parent directories resolved, the last
/// component as written.
pub fn name_location(path: &str) -> String {
    if path == "/" {
        return path.to_owned();
    }
    let dir = resolve_symlinked_deny_path(&parent(path)).unwrap_or_else(|| parent(path));
    match Path::new(path).file_name() {
        Some(name) => join(&dir, &name.to_string_lossy()),
        None => dir,
    }
}

/// Every prefix of an absolute path, shortest first, without `/`.
fn prefixes(path: &str) -> impl Iterator<Item = String> + '_ {
    path.match_indices('/')
        .map(|(at, _)| at)
        .skip(1)
        .chain([path.len()])
        .map(|end| path[..end].to_owned())
        .filter(|prefix| !prefix.is_empty())
}

/// `hasFileAncestor`: the first existing component of `path` (followed
/// through symlinks) that is not a directory.
fn file_ancestor(path: &str) -> Option<String> {
    for prefix in prefixes(path) {
        match std::fs::metadata(&prefix) {
            Ok(meta) if !meta.is_dir() => return Some(prefix),
            Ok(_) => {}
            Err(_) => return None,
        }
    }
    None
}

/// `findFirstNonExistentComponent`.
fn first_missing_component(path: &str) -> String {
    prefixes(path)
        .find(|prefix| !Path::new(prefix).exists())
        .unwrap_or_else(|| path.to_owned())
}

/// `isStaleBwrapMountPoint`: what bubblewrap makes as the mount point of
/// `--ro-bind /dev/null <absent path>` (an empty regular file without
/// write bits and with one link). A user's file can look the same, so
/// only a recorded one counts as a placeholder.
fn stale_mount_point(path: impl AsRef<Path>) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|meta| {
        meta.is_file() && meta.len() == 0 && meta.mode() & 0o222 == 0 && meta.nlink() == 1
    })
}

/// An empty directory (not a link to one).
fn empty_directory(path: impl AsRef<Path>) -> bool {
    let path = path.as_ref();
    std::fs::symlink_metadata(path).is_ok_and(|meta| meta.is_dir())
        && std::fs::read_dir(path).is_ok_and(|mut entries| entries.next().is_none())
}

/// Warn, once per path, that a missing deny path's glob characters are
/// taken literally.
fn warn_glob(path: &str) {
    static WARNED: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());
    if WARNED
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(path.to_owned())
    {
        crate::log::warn(&format!(
            "the sandbox path {path} looks like a glob; the Linux sandbox takes it literally and places nothing for it"
        ));
    }
}

/// srt's `isAbsenceErrno`.
fn absent(error: &std::io::Error) -> bool {
    matches!(error.raw_os_error(), Some(code) if [
        nix::libc::ENOENT,
        nix::libc::ENOTDIR,
        nix::libc::ELOOP,
        nix::libc::ENAMETOOLONG,
    ]
    .contains(&code))
}

/// What the plan needs besides the policy.
#[derive(Clone, Debug, Default)]
pub struct Options {
    /// The agent's working directory (absolute, symlink-free), whose
    /// mandatory deny paths are added ([`scan`]); `None` adds none.
    pub cwd: Option<String>,
    /// srt's `allowGitConfig`, for the mandatory deny paths.
    pub allow_git_config: bool,
    /// Hide [`SSH_CONFIG_D`] (srt's host-wide rule), the
    /// [`RESOLVER_SOCKETS`], [`WSL_INTEROP_DIR`] and the node's uid's
    /// `/tmp/ssh-*` directories ([`SSH_AGENT_TMP`]) (off for golden tests).
    pub host_rules: bool,
    /// The file recording the placeholders this node made (see
    /// [`MountPoints`]); `None` records nothing, so no leftover is removed.
    pub record: Option<PathBuf>,
    /// Protected paths as spelled whose policy entries arrive already
    /// resolved (the node's config and state directories,
    /// `SessionPolicy::linked_denies`): checked for replaceable symlinks
    /// like the policy's own spellings.
    pub spellings: Vec<String>,
    /// The policy's host sockets as spelled
    /// (`pirc_policy::session::linux_host_sockets`): `deny_read` entries
    /// whose links are not checked (their targets are still hidden).
    pub host_sockets: Vec<String>,
    /// With [`Options::host_rules`], [`PROC_NET_UNIX`]'s text: every Unix
    /// socket it lists is hidden ([`host_unix_sockets`]) but
    /// [`Options::allowed_sockets`]. The caller reads it, and refuses to
    /// start when it cannot (nothing would be hidden). `None` for the
    /// probe: it checks the stack, and a socket gone before bubblewrap
    /// mounts on it would fail it (and its result is cached).
    pub bound_sockets: Option<String>,
    /// The Unix sockets the agent may reach ([`Options::bound_sockets`]).
    pub allowed_sockets: Vec<String>,
}

/// A protected path the plan cannot protect: it is reached through a
/// symlink the agent could replace.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refusal {
    pub protected: String,
    /// The symlink, or (`parent`) the directory a symlink's target leaves
    /// through `..`.
    pub link: String,
    pub parent: bool,
}

impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.parent {
            write!(
                f,
                "the protected path {} goes through the directory {} (a symbolic link's target leaves it through ..), which the agent could replace (bubblewrap cannot pin a link); replace the link with the file or directory it points to",
                self.protected, self.link
            )
        } else {
            write!(
                f,
                "the protected path {} goes through the symbolic link {}, which the agent could replace (bubblewrap cannot pin a link); replace the link with the file or directory it points to",
                self.protected, self.link
            )
        }
    }
}

/// bubblewrap's filesystem arguments and the host paths they create.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Plan {
    pub args: Vec<String>,
    /// Placeholders bubblewrap makes on the host (claim them with
    /// [`MountPoints::claim`] before starting it).
    pub mount_points: Vec<PathBuf>,
}

/// srt's `findSymlinkInPath` on a protected spelling: the first symlink
/// crossed resolving `path` (the path itself, and the links its links'
/// targets go through, included), or directory a link's target leaves
/// through `..`, whose directory the agent may write ([`walk_links`]: each
/// is named with its directory resolved). The walk stops at the first
/// missing component.
///
/// A directory the agent may not write cannot be replaced either: where
/// its parent is writable it is a verdict boundary, a rule path, so it is
/// pinned (see [`pinned`]). So a directory left through `..` counts only
/// when the agent may write it too; a link always does (bubblewrap cannot
/// mount on one).
fn replaceable_symlink(effective: &PathPolicy, protected: &str) -> Option<Refusal> {
    walk_links(protected)
        .links
        .into_iter()
        .map(|link| {
            let left = !std::fs::symlink_metadata(&link).is_ok_and(|m| m.file_type().is_symlink());
            (link, left)
        })
        .find(|(link, left)| {
            access(effective, &parent(link)) == Access::Writable
                && (!left || access(effective, link) == Access::Writable)
        })
        .map(|(link, left)| Refusal {
            protected: protected.to_owned(),
            link,
            parent: left,
        })
}

/// The plan for `paths` (see the module documentation), or why it cannot
/// be protected.
pub fn plan(paths: &PathPolicy, options: &Options) -> Result<Plan, Refusal> {
    // The mandatory scan only matters where the agent may write around the
    // working directory (not for the read-only sandbox, say).
    let mandatory: Vec<String> = match &options.cwd {
        Some(cwd)
            if paths
                .allow_write
                .iter()
                .any(|root| is_inside(root, cwd) || is_inside(cwd, root)) =>
        {
            scan::mandatory_deny_paths(cwd, options.allow_git_config)
        }
        _ => Vec::new(),
    };
    let absolute = |path: &&String| path.starts_with('/');
    let mut effective = PathPolicy {
        allow_read: paths
            .allow_read
            .iter()
            .filter(absolute)
            .map(|p| name_location(p))
            .collect(),
        allow_write: paths
            .allow_write
            .iter()
            .filter(absolute)
            .map(|p| name_location(p))
            .collect(),
        ..PathPolicy::default()
    };
    // Unresolvable deny spellings (a cycle) fail closed below when a
    // symlink on the way is replaceable, and are already read-only from
    // the root's read-only bind otherwise, as in srt.
    let resolve = |path: &String| -> Option<String> {
        if path == "/" {
            Some(path.clone())
        } else {
            resolve_symlinked_deny_path(path)
        }
    };
    effective.deny_read = paths
        .deny_read
        .iter()
        .filter(absolute)
        .filter_map(resolve)
        .collect();
    effective.deny_write = paths
        .deny_write
        .iter()
        .chain(&mandatory)
        .filter(absolute)
        .filter_map(resolve)
        .collect();
    // srt's stand-in: a read deny that cannot be inspected hides its
    // deepest inspectable ancestor, restoring nothing below it.
    let mut stand_ins: Vec<String> = Vec::new();
    for denied in effective.deny_read.clone() {
        if let Err(error) = std::fs::metadata(&denied)
            && !absent(&error)
        {
            let mut up = parent(&denied);
            while up != "/" && std::fs::metadata(&up).is_err() {
                up = parent(&up);
            }
            if up != "/" && !kernel_top_level(&up) {
                effective.deny_read.push(up.clone());
                stand_ins.push(up);
            }
        }
    }
    if options.host_rules {
        for host_path in [SSH_CONFIG_D, WSL_INTEROP_DIR]
            .into_iter()
            .chain(RESOLVER_SOCKETS)
        {
            if let Ok(real) = std::fs::canonicalize(host_path)
                && !effective.deny_read.contains(&text(&real))
            {
                effective.deny_read.push(text(&real));
            }
        }
        for dir in ssh_agent_dirs(SSH_AGENT_TMP, nix::unistd::getuid().as_raw()) {
            if !effective.deny_read.contains(&dir) {
                effective.deny_read.push(dir);
            }
        }
    }
    if options.host_rules
        && let Some(listed) = &options.bound_sockets
    {
        // Every other socket bound on the host, unless the policy hides it
        // already (a socket in a hidden directory needs no mount of its own).
        let allowed: Vec<String> = options
            .allowed_sockets
            .iter()
            .filter_map(|socket| std::fs::canonicalize(socket).ok())
            .map(|socket| text(&socket))
            .collect();
        for socket in host_unix_sockets(listed, &allowed) {
            if access(&effective, &socket) != Access::Hidden {
                effective.deny_read.push(socket);
            }
        }
    }
    for spelling in paths
        .deny_write
        .iter()
        .chain(
            paths
                .deny_read
                .iter()
                .filter(|path| !options.host_sockets.contains(path)),
        )
        .chain(&mandatory)
        .chain(&options.spellings)
        .filter(absolute)
    {
        if let Some(refusal) = replaceable_symlink(&effective, spelling) {
            return Err(refusal);
        }
    }

    // Missing deny paths, for writing or reading: a placeholder on the
    // first missing component (`true`: an empty directory), hidden for a
    // read deny, or the file above them pinned.
    let mut placeholders: BTreeMap<String, bool> = BTreeMap::new();
    let mut hidden: Vec<String> = Vec::new();
    // Placeholders found in place: recorded ones are claimed again and
    // removed after the session; others only covered.
    let mut stale: Vec<String> = Vec::new();
    let mut covered: Vec<String> = Vec::new();
    let mut added: Vec<String> = Vec::new();
    // Under the lock: a release removes placeholders under it too, so what
    // is claimed and what exists are seen together (a placeholder seen
    // existing but no longer claimed would be planned as the user's, and
    // gone by the time bubblewrap binds it).
    let claimed = CLAIMED.lock().unwrap_or_else(|p| p.into_inner());
    let recorded = options
        .record
        .as_deref()
        .map(read_record)
        .unwrap_or_default();
    let known =
        |path: &str| claimed.contains_key(Path::new(path)) || recorded.contains(Path::new(path));
    let denies = (effective.deny_write.iter().map(|denied| (denied, false)))
        .chain(effective.deny_read.iter().map(|denied| (denied, true)));
    for (denied, hide) in denies {
        if denied == "/" || kernel_path(denied) {
            continue;
        }
        // Another sandbox's directory placeholder (or a recorded leftover)
        // on the way is this one's too, with nothing planned below it.
        // Not where this policy allows something at or below it: that is
        // a directory the user took over (a new workspace, say), not to be
        // covered or removed.
        let allowed_within = |prefix: &str| {
            (effective.allow_write.iter())
                .chain(&effective.allow_read)
                .any(|rule| is_inside(rule, prefix))
        };
        let reused = prefixes(denied)
            .take_while(|prefix| std::fs::symlink_metadata(prefix).is_ok_and(|m| m.is_dir()))
            .find(|prefix| known(prefix) && empty_directory(prefix) && !allowed_within(prefix));
        if let Some(first) = reused {
            if access(&effective, &parent(&first)) == Access::Writable {
                if hide && !hidden.contains(&first) {
                    hidden.push(first.clone());
                }
                placeholders.insert(first, true);
            }
            continue;
        }
        match std::fs::symlink_metadata(denied) {
            Ok(_) => {
                if stale_mount_point(denied)
                    && access(&effective, &parent(denied)) == Access::Writable
                    && !stale.contains(denied)
                    && !covered.contains(denied)
                {
                    if known(denied) {
                        stale.push(denied.clone());
                    } else {
                        covered.push(denied.clone());
                    }
                }
                continue;
            }
            // Cannot be inspected: srt's stand-in (above) hides it.
            Err(error) if hide && !absent(&error) => continue,
            Err(_) => {}
        }
        // A glob (srt's `denyRead` globs, say) is taken literally: a
        // placeholder would only put a stray `**` directory on the host.
        // Names that exist are literal whatever they hold.
        let missing = &denied[parent(&first_missing_component(denied)).len()..];
        if missing.contains(['*', '?', '[']) {
            warn_glob(denied);
            continue;
        }
        if let Some(file) = file_ancestor(&parent(denied)) {
            if !kernel_top_level(&file) && access(&effective, &parent(&file)) == Access::Writable {
                added.push(file);
            }
            continue;
        }
        let mut existing = parent(denied);
        while existing != "/" && !Path::new(&existing).exists() {
            existing = parent(&existing);
        }
        if access(&effective, &existing) != Access::Writable {
            continue;
        }
        let first = first_missing_component(denied);
        let directory = first != *denied;
        if hide && !hidden.contains(&first) {
            hidden.push(first.clone());
        }
        *placeholders.entry(first).or_insert(directory) |= directory;
    }
    drop(claimed);
    #[cfg(test)]
    tests::after_classification();
    effective.deny_write.extend(added);
    effective.deny_write.extend(placeholders.keys().cloned());
    effective.deny_read.extend(hidden);

    let mut points: Vec<String> = effective
        .allow_write
        .iter()
        .chain(&effective.deny_read)
        .chain(&effective.allow_read)
        .chain(&effective.deny_write)
        .filter(|path| *path != "/" && !kernel_path(path))
        // Placeholders found in place stay points whatever happens to them
        // now: a release may remove one once the lock is dropped (above),
        // and `--ro-bind /dev/null` makes it again.
        .filter(|path| {
            placeholders.contains_key(*path)
                || stale.contains(path)
                || covered.contains(path)
                || std::fs::symlink_metadata(path).is_ok_and(|m| !m.file_type().is_symlink())
        })
        .cloned()
        .collect();
    let root = access(&effective, "/");
    if root == Access::Hidden
        && let Ok(entries) = std::fs::read_dir("/")
    {
        for entry in entries.flatten() {
            let child = format!("/{}", entry.file_name().to_string_lossy());
            if kernel_top_level(&child) {
                continue;
            }
            match std::fs::canonicalize(&child).map(|real| text(&real)) {
                Ok(real) if real != "/" && !kernel_path(&real) => points.push(real),
                _ => {}
            }
        }
    }
    points.retain(|point| {
        !stand_ins
            .iter()
            .any(|stand_in| is_inside(point, stand_in) && point != stand_in)
    });
    let pinned = pinned(&effective, &points);
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
    // Read-only tmpfs mounts (hidden directories, directory placeholders)
    // are remounted read-only once everything inside them is mounted
    // (bubblewrap creates the mount points of nested binds there).
    let mut read_only = Vec::new();
    for point in points {
        let want = access(&effective, &point);
        let around = placed
            .iter()
            .filter(|(mounted, _)| is_inside(&point, mounted))
            .max_by_key(|(mounted, _)| mounted.len())
            .map_or(root_mount, |(_, access)| *access);
        let placeholder = placeholders.get(&point).copied();
        let is_stale = stale.contains(&point) || covered.contains(&point);
        // A pinned point inside a region of its own verdict (a directory on
        // the way to a protected path) is bound onto itself.
        if want != around || pinned.contains(&point) || placeholder.is_some() || is_stale {
            match (placeholder, want) {
                (Some(true), _) => {
                    push(&["--tmpfs", &point]);
                    read_only.push(point.clone());
                }
                (Some(false), _) => push(&["--ro-bind", "/dev/null", &point]),
                (None, _) if is_stale => push(&["--ro-bind", "/dev/null", &point]),
                (None, Access::Hidden) if Path::new(&point).is_dir() => {
                    push(&["--tmpfs", &point]);
                    read_only.push(point.clone());
                }
                (None, Access::Hidden) => push(&["--ro-bind", "/dev/null", &point]),
                (None, Access::ReadOnly) => push(&["--ro-bind", &point, &point]),
                (None, Access::Writable) => push(&["--bind", &point, &point]),
            }
        }
        placed.push((point, want));
    }
    for point in read_only {
        args.extend(["--remount-ro".to_owned(), point]);
    }
    let mount_points = placeholders
        .into_keys()
        .chain(stale)
        .map(PathBuf::from)
        .collect();
    Ok(Plan { args, mount_points })
}

/// The paths that must be mount points so nothing the agent may not write
/// can be renamed away (security audit S7): each point the agent may not
/// write, and every ancestor of it, whose parent directory is writable.
/// Symlinks cannot be mount points (and a protected spelling through a
/// replaceable one was refused); nor can anything below `/proc`, `/dev`
/// or `/sys` (srt's `ancestorPinArgs` skips those too).
fn pinned(paths: &PathPolicy, points: &[String]) -> Vec<String> {
    let writable_parent = |path: &str| access(paths, &parent(path)) == Access::Writable;
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
                && writable_parent(text)
                && !kernel_top_level(text)
                && !pinned.iter().any(|p| p == text)
            {
                pinned.push(text.to_owned());
            }
        }
    }
    pinned
}

/// How many running sandboxes use each placeholder.
static CLAIMED: Mutex<BTreeMap<PathBuf, usize>> = Mutex::new(BTreeMap::new());

/// The placeholders recorded in `file`, one absolute path per line (none
/// when it is missing or unreadable).
fn read_record(file: &Path) -> BTreeSet<PathBuf> {
    std::fs::read_to_string(file)
        .unwrap_or_default()
        .lines()
        .filter(|line| line.starts_with('/'))
        .map(PathBuf::from)
        .collect()
}

/// Write `entries` to `file` (0600, replaced whole), without those no
/// sandbox claims that are gone. A path holding a newline is not recorded
/// (so never removed as a leftover). Called with [`CLAIMED`] held.
fn write_record(file: &Path, entries: BTreeSet<PathBuf>, claimed: &BTreeMap<PathBuf, usize>) {
    let mut text = String::new();
    for entry in entries {
        let Some(line) = entry.to_str().filter(|line| !line.contains('\n')) else {
            continue;
        };
        if claimed.contains_key(&entry) || std::fs::symlink_metadata(&entry).is_ok() {
            text.push_str(line);
            text.push('\n');
        }
    }
    let temporary = file.with_extension("new");
    let written = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&temporary)
        .and_then(|mut out| out.write_all(text.as_bytes()))
        .and_then(|()| std::fs::rename(&temporary, file));
    if let Err(error) = written {
        crate::log::warn(&format!(
            "cannot record the sandbox placeholders in {}: {error}",
            file.display()
        ));
    }
}

/// The node's start, before its first plan with `file`: remove the
/// recorded placeholders that no sandbox of this process claims and that
/// are still what bubblewrap made (an empty file without write bits, an
/// empty directory), then drop everything unclaimed from the record. The
/// sandboxes of a node that died died with it (`--die-with-parent`, their
/// own PID namespace), so the record then names only live claims and the
/// leftovers of a crash since. Not srt's (see [`MountPoints`]). Later
/// calls with the same `file` do nothing.
pub fn sweep_record(file: &Path) {
    static SWEPT: Mutex<BTreeSet<PathBuf>> = Mutex::new(BTreeSet::new());
    let claimed = CLAIMED.lock().unwrap_or_else(|p| p.into_inner());
    if !SWEPT
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(file.to_path_buf())
    {
        return;
    }
    let entries = read_record(file);
    if entries.is_empty() {
        return;
    }
    let (live, leftovers): (BTreeSet<PathBuf>, BTreeSet<PathBuf>) = entries
        .into_iter()
        .partition(|entry| claimed.contains_key(entry));
    let mut leftovers: Vec<PathBuf> = leftovers.into_iter().collect();
    leftovers.sort_by_key(|entry| std::cmp::Reverse(entry.components().count()));
    for entry in &leftovers {
        if stale_mount_point(entry) {
            let _ = std::fs::remove_file(entry);
        } else if empty_directory(entry) {
            let _ = std::fs::remove_dir(entry);
        }
    }
    write_record(file, live, &claimed);
}

/// One sandbox's claim on the placeholders bubblewrap makes for it on the
/// host (srt's `bwrapMountPoints` and `cleanupBwrapMountPoints`).
///
/// srt deferred every removal while any sandbox of the process ran
/// (removing a mount point on the host detaches it in the sandboxes that
/// use it). Placeholders are counted per path here instead, so a busy node
/// still removes the ones no running sandbox uses; deepest first, so a
/// directory placeholder holding another sandbox's goes after it.
///
/// Not srt's: claimed placeholders are recorded in a file
/// ([`Options::record`]) until they are removed, so the next node knows
/// which leftovers of a node that died are its own to remove (at its
/// start, [`sweep_record`]).
///
/// Dropped on the async runtime, the claim is released on its blocking
/// pool (file removals under a process-wide lock), a moment later; a
/// release the runtime's shutdown cancels runs where it is dropped.
#[derive(Debug, Default)]
pub struct MountPoints {
    points: Vec<PathBuf>,
    record: Option<PathBuf>,
}

impl MountPoints {
    pub fn claim(points: Vec<PathBuf>, record: Option<PathBuf>) -> Self {
        let mut claimed = CLAIMED.lock().unwrap_or_else(|p| p.into_inner());
        for point in &points {
            *claimed.entry(point.clone()).or_insert(0) += 1;
        }
        if let Some(file) = &record
            && !points.is_empty()
        {
            let mut entries = read_record(file);
            entries.extend(points.iter().cloned());
            write_record(file, entries, &claimed);
        }
        Self { points, record }
    }

    /// Drop the claim and remove the placeholders no other sandbox uses,
    /// when they are still what bubblewrap made: an empty file, or an empty
    /// directory. Anything else is left alone. Either way they leave the
    /// record. Blocks (see [`MountPoints`] for the drop).
    pub fn release(&mut self) {
        release(std::mem::take(&mut self.points), self.record.as_deref());
    }
}

/// [`MountPoints::release`].
fn release(points: Vec<PathBuf>, record: Option<&Path>) {
    let mut unused: Vec<PathBuf> = Vec::new();
    let mut claimed = CLAIMED.lock().unwrap_or_else(|p| p.into_inner());
    for point in points {
        if let Some(count) = claimed.get_mut(&point) {
            *count -= 1;
            if *count == 0 {
                claimed.remove(&point);
                unused.push(point);
            }
        }
    }
    unused.sort_by_key(|point| std::cmp::Reverse(point.components().count()));
    // Removed under the lock: a sandbox starting meanwhile would
    // otherwise claim a placeholder about to go.
    for point in &unused {
        match std::fs::symlink_metadata(point) {
            Ok(meta) if meta.is_file() && meta.len() == 0 => {
                let _ = std::fs::remove_file(point);
            }
            Ok(meta) if meta.is_dir() => {
                let _ = std::fs::remove_dir(point);
            }
            _ => {}
        }
    }
    if let Some(file) = record
        && !unused.is_empty()
    {
        let mut entries = read_record(file);
        for point in &unused {
            entries.remove(point);
        }
        write_record(file, entries, &claimed);
    }
}

impl Drop for MountPoints {
    fn drop(&mut self) {
        if self.points.is_empty() {
            return;
        }
        let pending = Release(std::mem::take(&mut self.points), self.record.take());
        match tokio::runtime::Handle::try_current() {
            Ok(runtime) => {
                runtime.spawn_blocking(move || drop(pending));
            }
            Err(_) => drop(pending),
        }
    }
}

/// A claim being released: releases when dropped, run or not.
struct Release(Vec<PathBuf>, Option<PathBuf>);

impl Drop for Release {
    fn drop(&mut self) {
        release(std::mem::take(&mut self.0), self.1.as_deref());
    }
}

#[cfg(test)]
mod tests;
