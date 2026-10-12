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
//!   (where it never hits), applied to the spelling. The resolved target is
//!   protected as srt protects it. Decided with the user (M7); no opt-out.
//!   The node's own spellings of its config and state directories are
//!   checked too ([`Options::spellings`]): the policy holds them resolved,
//!   and a replaced link there would hand the node a config
//!   (`allowedPaths`) the agent wrote.
//! - **Missing deny paths** whose deepest existing ancestor the agent may
//!   write get a read-only placeholder on their first missing component:
//!   `/dev/null` when that is the path itself, an empty directory when it is
//!   an ancestor of it (srt's "Fix 2"; one placeholder per destination, the
//!   directory winning). srt bound an empty host directory there; this uses
//!   a read-only tmpfs, which needs no host source to keep unwritable.
//!   bubblewrap creates each placeholder's mount point on the host; they are
//!   tracked ([`MountPoints`]) and removed when the last sandbox using them
//!   ends, and one an earlier node left behind (an empty file without write
//!   bits) is covered with `/dev/null` and tracked again.
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

use std::collections::BTreeMap;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use pirc_policy::{PathPolicy, is_inside, read_allowed, resolve_path, write_allowed};

use super::scan;

/// `MAX_SYMLINK_RESOLUTION_DEPTH`: the kernel's `ELOOP` bound.
const MAX_SYMLINK_DEPTH: usize = 40;

/// `KERNEL_TOP_LEVEL_DIRS`: never expanded from `/`, never pinned.
const KERNEL_TOP_LEVEL_DIRS: [&str; 3] = ["/proc", "/dev", "/sys"];

/// srt's `/etc/ssh/ssh_config.d`: hidden whenever there is a read policy
/// (ssh is strict about its ownership, which looks wrong in the sandbox).
const SSH_CONFIG_D: &str = "/etc/ssh/ssh_config.d";

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

/// `isStaleBwrapMountPoint`: the mount point bubblewrap made for
/// `--ro-bind /dev/null <absent path>` and nobody removed (an empty
/// regular file without write bits and with one link).
fn stale_mount_point(path: &str) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|meta| {
        meta.is_file() && meta.len() == 0 && meta.mode() & 0o222 == 0 && meta.nlink() == 1
    })
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
    /// Hide [`SSH_CONFIG_D`] (srt's host-wide rule; off for golden tests).
    pub host_rules: bool,
    /// Protected paths as the node spells them (its config and state
    /// directories), whose policy entries arrive already resolved: checked
    /// for replaceable symlinks like the policy's own spellings.
    pub spellings: Vec<String>,
}

/// A protected path the plan cannot protect: it is reached through a
/// symlink the agent could replace.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refusal {
    pub protected: String,
    pub link: String,
}

impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "the protected path {} goes through the symbolic link {}, which the agent could replace (bubblewrap cannot pin a link); replace the link with the file or directory it points to",
            self.protected, self.link
        )
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

/// srt's `findSymlinkInPath` on a protected spelling: the first symlink on
/// the way to `path` (the path itself included) whose directory the agent
/// may write. The walk stops at the first missing component.
fn replaceable_symlink(effective: &PathPolicy, path: &str) -> Option<String> {
    for prefix in prefixes(path) {
        match std::fs::symlink_metadata(&prefix) {
            Ok(meta) if meta.file_type().is_symlink() => {
                let dir = resolve_symlinked_deny_path(&parent(&prefix))
                    .unwrap_or_else(|| parent(&prefix));
                if access(effective, &dir) == Access::Writable {
                    return Some(prefix);
                }
            }
            Ok(_) => {}
            Err(_) => return None,
        }
    }
    None
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
    if options.host_rules
        && let Ok(real) = std::fs::canonicalize(SSH_CONFIG_D)
    {
        effective.deny_read.push(text(&real));
    }
    for spelling in paths
        .deny_write
        .iter()
        .chain(&paths.deny_read)
        .chain(&mandatory)
        .chain(&options.spellings)
        .filter(absolute)
    {
        if let Some(link) = replaceable_symlink(&effective, spelling) {
            return Err(Refusal {
                protected: spelling.clone(),
                link,
            });
        }
    }

    // Missing deny paths: a placeholder on the first missing component
    // (`true`: an empty directory), or the file above them pinned.
    let mut placeholders: BTreeMap<String, bool> = BTreeMap::new();
    let mut stale: Vec<String> = Vec::new();
    let mut added: Vec<String> = Vec::new();
    for denied in &effective.deny_write {
        if denied == "/" || kernel_path(denied) {
            continue;
        }
        if std::fs::symlink_metadata(denied).is_ok() {
            if stale_mount_point(denied) && access(&effective, &parent(denied)) == Access::Writable
            {
                stale.push(denied.clone());
            }
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
        *placeholders.entry(first).or_insert(directory) |= directory;
    }
    effective.deny_write.extend(added);
    effective.deny_write.extend(placeholders.keys().cloned());

    let mut points: Vec<String> = effective
        .allow_write
        .iter()
        .chain(&effective.deny_read)
        .chain(&effective.allow_read)
        .chain(&effective.deny_write)
        .filter(|path| *path != "/" && !kernel_path(path))
        .filter(|path| {
            placeholders.contains_key(*path)
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
        let is_stale = stale.contains(&point);
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

/// One sandbox's claim on the placeholders bubblewrap makes for it on the
/// host (srt's `bwrapMountPoints` and `cleanupBwrapMountPoints`).
///
/// srt deferred every removal while any sandbox of the process ran
/// (removing a mount point on the host detaches it in the sandboxes that
/// use it). Placeholders are counted per path here instead, so a busy node
/// still removes the ones no running sandbox uses; deepest first, so a
/// directory placeholder holding another sandbox's goes after it.
#[derive(Debug, Default)]
pub struct MountPoints(Vec<PathBuf>);

impl MountPoints {
    pub fn claim(points: Vec<PathBuf>) -> Self {
        let mut claimed = CLAIMED.lock().unwrap_or_else(|p| p.into_inner());
        for point in &points {
            *claimed.entry(point.clone()).or_insert(0) += 1;
        }
        Self(points)
    }

    /// Drop the claim and remove the placeholders no other sandbox uses,
    /// when they are still what bubblewrap made: an empty file, or an empty
    /// directory. Anything else is left alone.
    pub fn release(&mut self) {
        let mut unused: Vec<PathBuf> = Vec::new();
        {
            let mut claimed = CLAIMED.lock().unwrap_or_else(|p| p.into_inner());
            for point in self.0.drain(..) {
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
            for point in unused {
                match std::fs::symlink_metadata(&point) {
                    Ok(meta) if meta.is_file() && meta.len() == 0 => {
                        let _ = std::fs::remove_file(&point);
                    }
                    Ok(meta) if meta.is_dir() => {
                        let _ = std::fs::remove_dir(&point);
                    }
                    _ => {}
                }
            }
        }
    }
}

impl Drop for MountPoints {
    fn drop(&mut self) {
        self.release();
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::os::unix::fs::{PermissionsExt, symlink};

    use super::*;

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

    #[test]
    fn stale_placeholders_are_covered_and_claimed_again() {
        let (_dir, root) = temp();
        let p = |rest: &str| format!("{root}/{rest}");
        fs::create_dir_all(p("ws")).unwrap();
        fs::write(p("ws/.bashrc"), "").unwrap();
        fs::set_permissions(p("ws/.bashrc"), fs::Permissions::from_mode(0o444)).unwrap();
        fs::write(p("ws/.profile"), "").unwrap();
        let paths = PathPolicy {
            allow_write: vec![p("ws")],
            deny_write: vec![p("ws/.bashrc"), p("ws/.profile")],
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
            "--ro-bind",
            "/dev/null",
            &p("ws/.bashrc"),
            // The user's own empty file (it has write bits): kept as it is.
            "--ro-bind",
            &p("ws/.profile"),
            &p("ws/.profile"),
        ]);
        assert_eq!(plan.args, expected);
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
                link: p("ws/.git")
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

    #[test]
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

    #[test]
    fn placeholders_are_removed_when_their_last_sandbox_ends() {
        let (_dir, root) = temp();
        let file = PathBuf::from(format!("{root}/.bashrc"));
        let dir = PathBuf::from(format!("{root}/.claude"));
        let kept = PathBuf::from(format!("{root}/.profile"));
        let mut first = MountPoints::claim(vec![file.clone(), dir.clone(), kept.clone()]);
        let mut second = MountPoints::claim(vec![file.clone()]);
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
