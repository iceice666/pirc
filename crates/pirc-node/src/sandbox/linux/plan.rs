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
//! - the node's uid's `/tmp/ssh-*` directories hidden, where sshd puts
//!   forwarded agents' sockets ([`SSH_AGENT_TMP`], not srt's);
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
//!   agent socket is reachable through the link or by name. Unix-socket
//!   connects are not filtered otherwise (see `linux.rs`). One removed
//!   between the plan and bubblewrap's mounts (its login ending as a
//!   session starts) fails that start (bubblewrap cannot create or
//!   remount it), or bubblewrap makes it again, empty, on the host: fail
//!   closed, and an empty leftover.
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
/// `socks5h`).
pub const RESOLVER_SOCKETS: [&str; 5] = [
    "/run/nscd",
    "/var/run/nscd",
    "/run/systemd/resolve",
    "/var/lib/sss/pipes",
    "/run/avahi-daemon/socket",
];

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
    /// [`RESOLVER_SOCKETS`] and the node's uid's `/tmp/ssh-*` directories
    /// ([`SSH_AGENT_TMP`]) (off for golden tests).
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
        for host_path in std::iter::once(SSH_CONFIG_D).chain(RESOLVER_SOCKETS) {
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
mod tests {
    use std::fs;
    use std::os::unix::fs::{PermissionsExt, symlink};

    use super::*;

    std::thread_local! {
        /// Run by [`plan`] on this thread once its classification is done
        /// and [`CLAIMED`] is dropped (a release racing the plan).
        static AFTER_CLASSIFICATION: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
            const { std::cell::RefCell::new(None) };
    }

    pub(super) fn after_classification() {
        if let Some(hook) = AFTER_CLASSIFICATION.with_borrow_mut(Option::take) {
            hook();
        }
    }

    fn temp() -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap().display().to_string();
        (dir, root)
    }

    fn args(paths: &PathPolicy) -> Vec<String> {
        plan(paths, &Options::default()).unwrap().args
    }

    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| (*item).to_owned()).collect()
    }

    #[test]
    fn mounts_follow_the_policy_verdicts() {
        let (_dir, root) = temp();
        let p = |rest: &str| format!("{root}/{rest}");
        for dir in ["home/.ssh", "state/sessions/s1", "state/i-1", "ws/.git"] {
            fs::create_dir_all(p(dir)).unwrap();
        }
        for file in ["home/.bashrc", "secret.txt", "ws/.git/config"] {
            fs::write(p(file), "").unwrap();
        }
        let paths = PathPolicy {
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
        };
        let plan = plan(&paths, &Options::default()).unwrap();
        let expected = strings(&[
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
            // Denied for writing and reading: hidden stays hidden.
            "--tmpfs",
            &p("home/.ssh"),
            "--ro-bind",
            &p("state/i-1"),
            &p("state/i-1"),
            // Pinned, so `.git` cannot be renamed away from `config`.
            "--bind",
            &p("ws/.git"),
            &p("ws/.git"),
            // Missing: a placeholder, so the agent cannot create it.
            "--ro-bind",
            "/dev/null",
            &p("ws/.pirc"),
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
        ]);
        // `home/.bashrc` is read-only, as `/` already is; `missing` does not
        // exist and is no deny path.
        assert_eq!(plan.args, expected);
        assert_eq!(plan.mount_points, [PathBuf::from(p("ws/.pirc"))]);
    }

    #[test]
    fn every_writable_directory_above_a_protected_path_is_a_mount_point() {
        let (_dir, root) = temp();
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
        let expected = strings(&[
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
        ]);
        assert_eq!(args(&paths), expected);
    }

    #[test]
    fn missing_deny_paths_get_placeholders_on_their_first_missing_component() {
        let (_dir, root) = temp();
        let p = |rest: &str| format!("{root}/{rest}");
        fs::create_dir_all(p("ws/a")).unwrap();
        fs::create_dir_all(p("ro")).unwrap();
        let paths = PathPolicy {
            allow_write: vec![p("ws")],
            deny_write: vec![
                p("ws/.pirc"),
                // An intermediate component: an empty read-only directory,
                // shared with the deeper deny below it.
                p("ws/.claude/commands"),
                p("ws/.claude/agents"),
                p("ws/.claude"),
                p("ws/a/b/c/d"),
                // Not writable around it: nothing to place.
                p("ro/x"),
            ],
            ..PathPolicy::default()
        };
        let plan = plan(&paths, &Options::default()).unwrap();
        let expected = strings(&[
            "--ro-bind",
            "/",
            "/",
            "--bind",
            &p("ws"),
            &p("ws"),
            "--tmpfs",
            &p("ws/.claude"),
            "--ro-bind",
            "/dev/null",
            &p("ws/.pirc"),
            // Pinned: the placeholder's parent cannot be renamed away.
            "--bind",
            &p("ws/a"),
            &p("ws/a"),
            "--tmpfs",
            &p("ws/a/b"),
            "--remount-ro",
            &p("ws/.claude"),
            "--remount-ro",
            &p("ws/a/b"),
        ]);
        assert_eq!(plan.args, expected);
        assert_eq!(
            plan.mount_points,
            [p("ws/.claude"), p("ws/.pirc"), p("ws/a/b")].map(PathBuf::from)
        );
    }

    #[test]
    fn missing_read_denies_get_hidden_placeholders() {
        let (_dir, root) = temp();
        let p = |rest: &str| format!("{root}/{rest}");
        fs::create_dir_all(p("ws")).unwrap();
        fs::create_dir_all(p("ro")).unwrap();
        let paths = PathPolicy {
            deny_read: vec![p("ws/.env"), p("ws/secrets/token"), p("ro/x")],
            allow_write: vec![p("ws")],
            ..PathPolicy::default()
        };
        let plan = plan(&paths, &Options::default()).unwrap();
        assert_eq!(
            plan.args,
            strings(&[
                "--ro-bind",
                "/",
                "/",
                "--bind",
                &p("ws"),
                &p("ws"),
                "--ro-bind",
                "/dev/null",
                &p("ws/.env"),
                "--tmpfs",
                &p("ws/secrets"),
                "--remount-ro",
                &p("ws/secrets"),
            ])
        );
        assert_eq!(
            plan.mount_points,
            [p("ws/.env"), p("ws/secrets")].map(PathBuf::from)
        );
    }

    /// Globs are taken literally: their missing names get no placeholder
    /// (no stray `**` on the host); a name that exists is literal.
    #[test]
    fn missing_glob_spellings_get_no_placeholders() {
        let (_dir, root) = temp();
        let p = |rest: &str| format!("{root}/{rest}");
        fs::create_dir_all(p("ws/lit[1]")).unwrap();
        let paths = PathPolicy {
            deny_read: vec![p("ws/**/.env"), p("ws/lit[1]/.env")],
            allow_write: vec![p("ws")],
            deny_write: vec![p("ws/.claude/*.json"), p("ws/a?"), p("ws/[x]/y")],
            ..PathPolicy::default()
        };
        let plan = plan(&paths, &Options::default()).unwrap();
        assert_eq!(
            plan.args,
            strings(&[
                "--ro-bind",
                "/",
                "/",
                "--bind",
                &p("ws"),
                &p("ws"),
                "--bind",
                &p("ws/lit[1]"),
                &p("ws/lit[1]"),
                "--ro-bind",
                "/dev/null",
                &p("ws/lit[1]/.env"),
            ])
        );
        assert_eq!(plan.mount_points, [PathBuf::from(p("ws/lit[1]/.env"))]);
    }

    #[test]
    fn a_worktree_git_file_is_pinned_as_a_file() {
        let (_dir, root) = temp();
        let p = |rest: &str| format!("{root}/{rest}");
        fs::create_dir_all(p("ws")).unwrap();
        fs::write(p("ws/.git"), "gitdir: /elsewhere").unwrap();
        let paths = PathPolicy {
            allow_write: vec![p("ws")],
            deny_write: vec![p("ws/.git/hooks"), p("ws/.git/config")],
            ..PathPolicy::default()
        };
        let plan = plan(&paths, &Options::default()).unwrap();
        assert_eq!(
            plan.args,
            strings(&[
                "--ro-bind",
                "/",
                "/",
                "--bind",
                &p("ws"),
                &p("ws"),
                "--ro-bind",
                &p("ws/.git"),
                &p("ws/.git")
            ])
        );
        assert!(plan.mount_points.is_empty());
    }

    /// A leftover placeholder is claimed again (and so removed later) only
    /// when the record names it: a user's own empty read-only file looks
    /// the same, and is only covered.
    #[test]
    fn recorded_stale_placeholders_are_claimed_again_and_others_only_covered() {
        let (_dir, root) = temp();
        let p = |rest: &str| format!("{root}/{rest}");
        fs::create_dir_all(p("ws")).unwrap();
        for file in [".bashrc", ".zshrc", ".profile"] {
            fs::write(p(&format!("ws/{file}")), "").unwrap();
        }
        for file in [".bashrc", ".zshrc"] {
            fs::set_permissions(p(&format!("ws/{file}")), fs::Permissions::from_mode(0o444))
                .unwrap();
        }
        let record = PathBuf::from(p("record"));
        fs::write(&record, format!("{}\nrelative\n", p("ws/.bashrc"))).unwrap();
        let paths = PathPolicy {
            allow_write: vec![p("ws")],
            deny_write: vec![p("ws/.bashrc"), p("ws/.profile"), p("ws/.zshrc")],
            ..PathPolicy::default()
        };
        let options = Options {
            record: Some(record.clone()),
            ..Options::default()
        };
        let plan = plan(&paths, &options).unwrap();
        let expected = strings(&[
            "--ro-bind",
            "/",
            "/",
            "--bind",
            &p("ws"),
            &p("ws"),
            "--ro-bind",
            "/dev/null",
            &p("ws/.bashrc"),
            // The user's own empty file (it has write bits): kept as it is.
            "--ro-bind",
            &p("ws/.profile"),
            &p("ws/.profile"),
            // Unrecorded: covered, never claimed.
            "--ro-bind",
            "/dev/null",
            &p("ws/.zshrc"),
        ]);
        assert_eq!(plan.args, expected);
        assert_eq!(plan.mount_points, [PathBuf::from(p("ws/.bashrc"))]);
        // Without a record nothing is claimed.
        let plan = super::plan(&paths, &Options::default()).unwrap();
        assert!(plan.mount_points.is_empty());
        assert_eq!(plan.args, expected);
    }

    /// Another session's release can remove a placeholder found in place
    /// once the plan has classified it: the plan still covers it (and
    /// bubblewrap makes it again), it does not drop the mount.
    #[test]
    fn a_stale_placeholder_removed_during_the_plan_is_still_covered() {
        let (_dir, root) = temp();
        let p = |rest: &str| format!("{root}/{rest}");
        fs::create_dir_all(p("ws")).unwrap();
        for file in [".bashrc", ".zshrc"] {
            fs::write(p(&format!("ws/{file}")), "").unwrap();
            fs::set_permissions(p(&format!("ws/{file}")), fs::Permissions::from_mode(0o444))
                .unwrap();
        }
        let record = PathBuf::from(p("record"));
        fs::write(&record, format!("{}\n", p("ws/.bashrc"))).unwrap();
        let paths = PathPolicy {
            allow_write: vec![p("ws")],
            deny_write: vec![p("ws/.bashrc"), p("ws/.zshrc")],
            ..PathPolicy::default()
        };
        let options = Options {
            record: Some(record),
            ..Options::default()
        };
        let (bashrc, zshrc) = (p("ws/.bashrc"), p("ws/.zshrc"));
        AFTER_CLASSIFICATION.set(Some(Box::new(move || {
            fs::remove_file(bashrc).unwrap();
            fs::remove_file(zshrc).unwrap();
        })));
        let plan = plan(&paths, &options).unwrap();
        assert!(!Path::new(&p("ws/.bashrc")).exists(), "the hook ran");
        assert_eq!(
            plan.args,
            strings(&[
                "--ro-bind",
                "/",
                "/",
                "--bind",
                &p("ws"),
                &p("ws"),
                "--ro-bind",
                "/dev/null",
                &p("ws/.bashrc"),
                "--ro-bind",
                "/dev/null",
                &p("ws/.zshrc"),
            ])
        );
        assert_eq!(plan.mount_points, [PathBuf::from(p("ws/.bashrc"))]);
    }

    #[test]
    fn symlinked_deny_paths_are_resolved_before_they_are_masked() {
        let (_dir, root) = temp();
        let p = |rest: &str| format!("{root}/{rest}");
        fs::create_dir_all(p("ws")).unwrap();
        fs::create_dir_all(p("dotfiles")).unwrap();
        fs::create_dir_all(p("ro")).unwrap();
        fs::write(p("dotfiles/mcp.json"), "{}").unwrap();
        // Links in a directory the agent cannot write: protected at their
        // targets, one dangling.
        symlink(p("dotfiles/mcp.json"), p("ro/mcp")).unwrap();
        symlink(p("ws/created-later"), p("ro/dangling")).unwrap();
        let paths = PathPolicy {
            allow_write: vec![p("ws"), p("dotfiles")],
            deny_write: vec![p("ro/mcp"), p("ro/dangling")],
            ..PathPolicy::default()
        };
        let plan = plan(&paths, &Options::default()).unwrap();
        assert_eq!(
            plan.args,
            strings(&[
                "--ro-bind",
                "/",
                "/",
                "--bind",
                &p("dotfiles"),
                &p("dotfiles"),
                "--bind",
                &p("ws"),
                &p("ws"),
                "--ro-bind",
                &p("dotfiles/mcp.json"),
                &p("dotfiles/mcp.json"),
                "--ro-bind",
                "/dev/null",
                &p("ws/created-later"),
            ])
        );
        assert_eq!(
            resolve_symlinked_deny_path(&p("ro/dangling/x/y")),
            Some(p("ws/created-later/x/y"))
        );
        symlink(p("loop-b"), p("loop-a")).unwrap();
        symlink(p("loop-a"), p("loop-b")).unwrap();
        assert_eq!(resolve_symlinked_deny_path(&p("loop-a/x")), None);
    }

    #[test]
    fn protected_paths_through_replaceable_symlinks_are_refused() {
        let (_dir, root) = temp();
        let p = |rest: &str| format!("{root}/{rest}");
        fs::create_dir_all(p("ws")).unwrap();
        fs::create_dir_all(p("repo/.git")).unwrap();
        fs::write(p("repo/.git/config"), "").unwrap();
        symlink(p("repo/.git"), p("ws/.git")).unwrap();
        let paths = PathPolicy {
            allow_write: vec![p("ws")],
            deny_write: vec![p("ws/.git/config")],
            ..PathPolicy::default()
        };
        let refusal = plan(&paths, &Options::default()).unwrap_err();
        assert_eq!(
            refusal,
            Refusal {
                protected: p("ws/.git/config"),
                link: p("ws/.git"),
                parent: false,
            }
        );
        assert_eq!(
            refusal.to_string(),
            format!(
                "the protected path {} goes through the symbolic link {}, which the agent could replace (bubblewrap cannot pin a link); replace the link with the file or directory it points to",
                p("ws/.git/config"),
                p("ws/.git")
            )
        );
        // The leaf itself, and a mandatory path found by the scan.
        fs::remove_file(p("ws/.git")).unwrap();
        symlink(p("repo/.git/config"), p("ws/.mcp.json")).unwrap();
        let paths = PathPolicy {
            allow_write: vec![p("ws")],
            ..PathPolicy::default()
        };
        let options = Options {
            cwd: Some(p("ws")),
            ..Options::default()
        };
        assert_eq!(plan(&paths, &options).unwrap_err().link, p("ws/.mcp.json"));
        // The node's own spelling of its config directory (the policy only
        // holds the resolved one).
        fs::remove_file(p("ws/.mcp.json")).unwrap();
        symlink(p("repo"), p("ws/dotconfig")).unwrap();
        let options = Options {
            spellings: vec![p("ws/dotconfig/pirc")],
            ..Options::default()
        };
        assert_eq!(plan(&paths, &options).unwrap_err().link, p("ws/dotconfig"));
        symlink(p("repo/.git/config"), p("ws/.mcp.json")).unwrap();
        // A link the agent cannot replace is fine: its target is protected.
        let paths = PathPolicy {
            allow_write: vec![p("ws/sub")],
            deny_write: vec![p("ws/.mcp.json")],
            ..PathPolicy::default()
        };
        assert!(plan(&paths, &Options::default()).is_ok());
    }

    /// A host socket spelled through a link in a writable root (tmux's
    /// `/tmp/ssh-agent-$USER` for `SSH_AUTH_SOCK`) is hidden at its target
    /// and refuses nothing: it is not protected for host tools.
    #[test]
    fn host_sockets_behind_replaceable_links_are_hidden_at_their_targets() {
        let (_dir, root) = temp();
        let p = |rest: &str| format!("{root}/{rest}");
        fs::create_dir_all(p("tmp")).unwrap();
        fs::create_dir_all(p("agent")).unwrap();
        let _listener = std::os::unix::net::UnixListener::bind(p("agent/socket")).unwrap();
        symlink(p("agent/socket"), p("tmp/ssh-agent")).unwrap();
        let paths = PathPolicy {
            deny_read: vec![p("tmp/ssh-agent")],
            allow_write: vec![p("tmp")],
            ..PathPolicy::default()
        };
        assert_eq!(
            plan(&paths, &Options::default()).unwrap_err().link,
            p("tmp/ssh-agent"),
            "any other deny is refused"
        );
        let options = Options {
            host_sockets: vec![p("tmp/ssh-agent")],
            ..Options::default()
        };
        let plan = plan(&paths, &options).unwrap();
        assert_eq!(
            plan.args,
            strings(&[
                "--ro-bind",
                "/",
                "/",
                "--bind",
                &p("tmp"),
                &p("tmp"),
                "--ro-bind",
                "/dev/null",
                &p("agent/socket"),
            ])
        );
    }

    /// sshd's agent directories: `ssh-*` directories the uid owns, not
    /// links to one nor files.
    #[test]
    fn ssh_agent_dirs_are_the_uids_ssh_directories() {
        let (_dir, root) = temp();
        let p = |rest: &str| format!("{root}/{rest}");
        for dir in ["ssh-AbC123", "ssh-x/agent.1", "other"] {
            fs::create_dir_all(p(dir)).unwrap();
        }
        fs::write(p("ssh-file"), "").unwrap();
        symlink(p("other"), p("ssh-link")).unwrap();
        let uid = nix::unistd::getuid().as_raw();
        assert_eq!(ssh_agent_dirs(&root, uid), [p("ssh-AbC123"), p("ssh-x")]);
        assert!(ssh_agent_dirs(&root, uid + 1).is_empty());
        assert!(ssh_agent_dirs(&p("missing"), uid).is_empty());
    }

    /// A link the agent cannot replace that leads through one it can (or
    /// through a directory it can replace, by `..`) is refused too: the
    /// spelling follows whatever the agent puts there.
    #[test]
    fn links_in_the_middle_of_a_chain_are_refused() {
        let (_dir, root) = temp();
        let p = |rest: &str| format!("{root}/{rest}");
        for dir in ["ws/sub", "ro", "real/pirc"] {
            fs::create_dir_all(p(dir)).unwrap();
        }
        // ro/entry -> ws/hop -> real
        symlink(p("ws/hop"), p("ro/entry")).unwrap();
        symlink(p("real"), p("ws/hop")).unwrap();
        // ro/up -> ws/sub/../../real: `ws/sub` replaced by a link moves it.
        symlink(format!("{root}/ws/sub/../../real"), p("ro/up")).unwrap();
        let paths = PathPolicy {
            allow_write: vec![p("ws")],
            deny_write: vec![p("ro/entry/pirc")],
            ..PathPolicy::default()
        };
        assert_eq!(
            plan(&paths, &Options::default()).unwrap_err(),
            Refusal {
                protected: p("ro/entry/pirc"),
                link: p("ws/hop"),
                parent: false,
            }
        );
        let paths = PathPolicy {
            allow_write: vec![p("ws")],
            ..PathPolicy::default()
        };
        let options = Options {
            spellings: vec![p("ro/up/pirc")],
            ..Options::default()
        };
        let refusal = plan(&paths, &options).unwrap_err();
        assert_eq!(
            refusal,
            Refusal {
                protected: p("ro/up/pirc"),
                link: p("ws/sub"),
                parent: true,
            }
        );
        assert!(
            refusal
                .to_string()
                .starts_with(&format!("the protected path {} goes through the directory {} (a symbolic link's target leaves it through ..)", p("ro/up/pirc"), p("ws/sub"))),
            "{refusal}"
        );
        // Nothing the agent may write on the way: protected at the target.
        let paths = PathPolicy {
            allow_write: vec![p("real/pirc")],
            deny_write: vec![p("ro/entry/pirc"), p("ro/up/pirc")],
            ..PathPolicy::default()
        };
        assert!(plan(&paths, &Options::default()).is_ok());
        // `..` out of a directory the agent may not write, in one it may:
        // that directory is pinned, so it cannot be replaced.
        fs::create_dir_all(p("ws/prot")).unwrap();
        fs::create_dir_all(p("ws/target")).unwrap();
        symlink("../target", p("ws/prot/l")).unwrap();
        let paths = PathPolicy {
            allow_write: vec![p("ws")],
            deny_write: vec![p("ws/prot"), p("ws/prot/l/f")],
            ..PathPolicy::default()
        };
        let plan = plan(&paths, &Options::default()).unwrap();
        let has = |a: &str, b: &str, c: &str| plan.args.windows(3).any(|w| w == [a, b, c]);
        assert!(has("--ro-bind", &p("ws/prot"), &p("ws/prot")));
        assert!(has("--ro-bind", "/dev/null", &p("ws/target/f")));
    }

    #[test]
    fn mandatory_deny_paths_join_the_policy() {
        let (_dir, root) = temp();
        let p = |rest: &str| format!("{root}/{rest}");
        fs::create_dir_all(p("ws/.git/hooks")).unwrap();
        fs::create_dir_all(p("ws/sub/.vscode")).unwrap();
        fs::write(p("ws/sub/.vscode/tasks.json"), "").unwrap();
        fs::write(p("ws/.git/config"), "").unwrap();
        let paths = PathPolicy {
            allow_write: vec![p("ws")],
            ..PathPolicy::default()
        };
        let options = Options {
            cwd: Some(p("ws")),
            ..Options::default()
        };
        let plan = plan(&paths, &options).unwrap();
        let has = |a: &str, b: &str, c: &str| plan.args.windows(3).any(|w| w == [a, b, c]);
        assert!(has("--ro-bind", &p("ws/.git/config"), &p("ws/.git/config")));
        assert!(has("--ro-bind", &p("ws/.git/hooks"), &p("ws/.git/hooks")));
        assert!(has("--ro-bind", &p("ws/sub/.vscode"), &p("ws/sub/.vscode")));
        assert!(has("--ro-bind", "/dev/null", &p("ws/.bashrc")));
        assert!(
            plan.args
                .windows(2)
                .any(|w| w == ["--tmpfs", &p("ws/.claude")])
        );
        // No write root around the working directory: no scan at all.
        let read_only = PathPolicy {
            allow_write: vec![p("elsewhere")],
            ..PathPolicy::default()
        };
        assert_eq!(
            super::plan(&read_only, &options).unwrap().args,
            strings(&["--ro-bind", "/", "/"])
        );
    }

    /// Linux's root (`/etc` is a symlink to `/private/etc` on macOS).
    #[test]
    #[cfg(target_os = "linux")]
    fn a_denied_root_is_expanded_and_kernel_paths_are_left_alone() {
        let paths = PathPolicy {
            deny_read: vec!["/".into(), "/proc/1".into()],
            allow_read: vec!["/usr".into()],
            ..PathPolicy::default()
        };
        let args = args(&paths);
        assert_eq!(args[..3], ["--ro-bind", "/", "/"]);
        assert!(args.windows(2).any(|w| w == ["--tmpfs", "/etc"]));
        assert!(!args.iter().any(|arg| arg == "/usr"
            || arg.starts_with("/proc")
            || arg.starts_with("/sys")
            || arg.starts_with("/dev/")));
        // No mount lands on a symlink: every target is its canonical path.
        for arg in args.iter().filter(|a| a.starts_with('/') && *a != "/") {
            assert!(
                !fs::symlink_metadata(arg).unwrap().file_type().is_symlink(),
                "{arg}"
            );
        }
    }

    /// Another sandbox's directory placeholder is an empty directory on the
    /// host: it is planned as this sandbox's placeholder too, not as the
    /// user's directory with placeholders inside.
    #[test]
    fn another_sandboxs_directory_placeholder_is_claimed_again() {
        let (_dir, root) = temp();
        let p = |rest: &str| format!("{root}/{rest}");
        fs::create_dir_all(p("ws")).unwrap();
        let paths = PathPolicy {
            allow_write: vec![p("ws")],
            deny_write: vec![p("ws/.claude/commands"), p("ws/.claude/agents")],
            ..PathPolicy::default()
        };
        let first = plan(&paths, &Options::default()).unwrap();
        let expected = strings(&[
            "--ro-bind",
            "/",
            "/",
            "--bind",
            &p("ws"),
            &p("ws"),
            "--tmpfs",
            &p("ws/.claude"),
            "--remount-ro",
            &p("ws/.claude"),
        ]);
        assert_eq!(first.args, expected);
        let mut claim = MountPoints::claim(first.mount_points, None);
        // What bubblewrap makes for the first sandbox.
        fs::create_dir(p("ws/.claude")).unwrap();
        let second = plan(&paths, &Options::default()).unwrap();
        assert_eq!(second.args, expected);
        assert_eq!(second.mount_points, [PathBuf::from(p("ws/.claude"))]);
        let mut again = MountPoints::claim(second.mount_points, None);
        claim.release();
        assert!(Path::new(&p("ws/.claude")).exists(), "still claimed");
        again.release();
        assert!(!Path::new(&p("ws/.claude")).exists());
        // Unclaimed and unrecorded, an empty directory is the user's.
        fs::create_dir(p("ws/.claude")).unwrap();
        let users = plan(&paths, &Options::default()).unwrap();
        assert!(
            users
                .args
                .windows(3)
                .any(|w| w == ["--ro-bind", "/dev/null", &p("ws/.claude/commands")]),
            "{:?}",
            users.args
        );
    }

    /// An empty directory the record names that the policy now allows (a
    /// leftover the user made a workspace of) is the user's: never
    /// covered as a placeholder, and the denies below it get their own.
    #[test]
    fn a_recorded_directory_the_policy_allows_is_not_reused() {
        let (_dir, root) = temp();
        let p = |rest: &str| format!("{root}/{rest}");
        fs::create_dir_all(p("home/newproj")).unwrap();
        let record = PathBuf::from(p("record"));
        fs::write(&record, format!("{}\n", p("home/newproj"))).unwrap();
        let options = Options {
            record: Some(record),
            ..Options::default()
        };
        for allowed in ["home", "home/newproj", "home/newproj/sub"] {
            let paths = PathPolicy {
                allow_write: vec![p("home"), p(allowed)],
                deny_write: vec![p("home/newproj/.bashrc")],
                ..PathPolicy::default()
            };
            let plan = plan(&paths, &options).unwrap();
            let reused = plan
                .args
                .windows(2)
                .any(|w| w == ["--tmpfs", &p("home/newproj")]);
            assert_eq!(reused, allowed == "home", "{allowed}: {:?}", plan.args);
            if allowed != "home" {
                assert_eq!(
                    plan.mount_points,
                    [PathBuf::from(p("home/newproj/.bashrc"))]
                );
            }
        }
    }

    /// At the node's start the record's leftovers no sandbox claims are
    /// removed when still what bubblewrap made, and the record keeps only
    /// the claimed ones; once per record.
    #[test]
    fn the_record_is_swept_at_the_first_plan() {
        let (_dir, root) = temp();
        let p = |rest: &str| PathBuf::from(format!("{root}/{rest}"));
        let record = p("record");
        let (file, dir, nested, written, users, claimed) = (
            p(".bashrc"),
            p(".claude"),
            p("a/.git"),
            p(".zshrc"),
            p(".profile"),
            p(".mcp.json"),
        );
        fs::create_dir_all(&dir).unwrap();
        fs::create_dir_all(&nested).unwrap();
        for (path, contents, mode) in [
            (&file, "", 0o444),
            (&written, "x", 0o444),
            (&users, "", 0o644),
            (&claimed, "", 0o444),
        ] {
            fs::write(path, contents).unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
        }
        let all = [&file, &dir, &p("a"), &nested, &written, &users, &claimed];
        let text: String = all.iter().map(|e| format!("{}\n", e.display())).collect();
        fs::write(&record, &text).unwrap();
        let mut claim = MountPoints::claim(vec![claimed.clone()], None);
        sweep_record(&record);
        assert!(!file.exists() && !dir.exists());
        assert!(!p("a").exists(), "deepest first: emptied, then removed");
        assert!(
            written.exists() && users.exists(),
            "not what bubblewrap made"
        );
        assert!(claimed.exists(), "claimed");
        assert_eq!(read_record(&record), BTreeSet::from([claimed.clone()]));
        fs::write(&record, &text).unwrap();
        sweep_record(&record);
        assert_eq!(fs::read_to_string(&record).unwrap(), text, "once");
        claim.release();
    }

    #[test]
    fn claimed_placeholders_stay_recorded_until_released() {
        let (_dir, root) = temp();
        let record = PathBuf::from(format!("{root}/record"));
        let ours = PathBuf::from(format!("{root}/.bashrc"));
        let gone = PathBuf::from(format!("{root}/gone"));
        let kept = PathBuf::from(format!("{root}/kept"));
        fs::write(&kept, "").unwrap();
        fs::write(&record, format!("{}\n{}\n", gone.display(), kept.display())).unwrap();
        let mut claim = MountPoints::claim(vec![ours.clone()], Some(record.clone()));
        let mode = fs::metadata(&record).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        // Recorded before bubblewrap makes it; a recorded path that is
        // gone and unclaimed is dropped.
        assert_eq!(
            read_record(&record),
            BTreeSet::from([ours.clone(), kept.clone()])
        );
        fs::write(&ours, "").unwrap();
        claim.release();
        assert!(!ours.exists());
        assert_eq!(read_record(&record), BTreeSet::from([kept]));
    }

    /// A claim dropped on the async runtime does not wait there for the
    /// process-wide lock (or the removals): the blocking pool releases it.
    #[tokio::test]
    async fn dropped_claims_are_released_off_the_runtime() {
        let (_dir, root) = temp();
        let file = PathBuf::from(format!("{root}/.bashrc"));
        let claim = MountPoints::claim(vec![file.clone()], None);
        fs::write(&file, "").unwrap();
        let (locked, wait) = std::sync::mpsc::channel();
        let holder = std::thread::spawn(move || {
            let _claimed = CLAIMED.lock().unwrap_or_else(|p| p.into_inner());
            locked.send(()).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(600));
        });
        wait.recv().unwrap();
        let started = std::time::Instant::now();
        drop(claim);
        assert!(
            started.elapsed() < std::time::Duration::from_millis(300),
            "the drop waited {:?}",
            started.elapsed()
        );
        holder.join().unwrap();
        for _ in 0..200 {
            if !file.exists() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(!file.exists());
    }

    #[test]
    fn placeholders_are_removed_when_their_last_sandbox_ends() {
        let (_dir, root) = temp();
        let file = PathBuf::from(format!("{root}/.bashrc"));
        let dir = PathBuf::from(format!("{root}/.claude"));
        let kept = PathBuf::from(format!("{root}/.profile"));
        let mut first = MountPoints::claim(vec![file.clone(), dir.clone(), kept.clone()], None);
        let mut second = MountPoints::claim(vec![file.clone()], None);
        fs::write(&file, "").unwrap();
        fs::create_dir(&dir).unwrap();
        fs::write(&kept, "written meanwhile").unwrap();
        first.release();
        assert!(file.exists(), "still used by the second sandbox");
        assert!(!dir.exists());
        assert!(kept.exists(), "not what bubblewrap made");
        second.release();
        assert!(!file.exists());
        drop(second);
    }
}
