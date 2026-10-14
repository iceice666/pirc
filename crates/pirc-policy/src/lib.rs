//! The sandbox path policy (`apps/gateway/src/sandbox-policy.ts`) and the
//! file tools' view of it (`PathGuard`, `truncateOutput` in
//! `apps/gateway/src/agent/sandbox.ts`), and the node's per-session policy
//! ([`session`], M6). srt's settings and their enforcement live with the
//! node's sandbox backends (M6, M7).

use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

pub mod session;

/// Credential stores and private data under `$HOME` that agents never
/// read (`SENSITIVE_HOME_PATHS`); the auto-mode rules use them too.
pub const SENSITIVE_HOME_PATHS: [&str; 40] = [
    ".ssh",
    ".gnupg",
    ".aws",
    ".azure",
    ".config/gcloud",
    ".kube",
    ".docker/config.json",
    ".config/gh",
    ".config/op",
    ".netrc",
    ".git-credentials",
    ".password-store",
    ".pypirc",
    ".cargo/credentials",
    ".cargo/credentials.toml",
    ".gem/credentials",
    ".terraform.d/credentials.tfrc.json",
    ".claude/.credentials.json",
    ".codex/auth.json",
    ".config/sops",
    ".local/share/keyrings",
    ".local/pirc-node",
    ".bash_history",
    ".zsh_history",
    ".local/share/fish/fish_history",
    ".mozilla",
    ".config/google-chrome",
    ".config/chromium",
    ".config/BraveSoftware",
    ".config/microsoft-edge",
    "Library/Keychains",
    "Library/Cookies",
    "Library/Messages",
    "Library/Mail",
    "Library/Application Support/Google/Chrome",
    "Library/Application Support/Chromium",
    "Library/Application Support/Firefox",
    "Library/Application Support/BraveSoftware",
    "Library/Application Support/Arc",
    "Library/Application Support/Microsoft Edge",
];

/// Registry credentials builds read (`BUILD_CREDENTIAL_HOME_PATHS`).
pub const BUILD_CREDENTIAL_HOME_PATHS: [&str; 3] = [".npmrc", ".yarnrc.yml", ".bundle/config"];

/// Build and package caches under `$HOME` (`CACHE_HOME_PATHS`).
pub const CACHE_HOME_PATHS: [&str; 8] = [
    ".cache",
    "Library/Caches",
    ".npm",
    ".bun/install/cache",
    ".cargo/registry",
    ".cargo/git",
    "go/pkg/mod",
    ".gradle/caches",
];

/// What the file tools (and srt) may read and write (`PathPolicy`):
/// absolute, symlink-resolved path rules.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathPolicy {
    pub deny_read: Vec<String>,
    pub allow_read: Vec<String>,
    pub allow_write: Vec<String>,
    pub deny_write: Vec<String>,
    /// Writable roots every session shares (temporary directories, build
    /// caches): no write lease there.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shared_write: Option<Vec<String>>,
}

/// `path.normalize` of an absolute path: `.` and `..` resolved, separators
/// collapsed, no trailing separator (but the root).
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::from("/");
    for component in path.components() {
        match component {
            Component::RootDir | Component::Prefix(_) | Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(part) => out.push(part),
        }
    }
    out
}

/// `path.resolve(base, input)` for POSIX paths.
pub fn resolve_path(base: &str, input: &str) -> String {
    let joined = Path::new(base).join(input);
    normalize(&joined).display().to_string()
}

/// `realResolve`: the path the kernel will use, following the symlinks of
/// its longest existing prefix.
pub fn real_resolve(target: &str) -> String {
    let cwd = std::env::current_dir()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| "/".to_owned());
    let mut current = PathBuf::from(resolve_path(&cwd, target));
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    while !current.exists() && std::fs::symlink_metadata(&current).is_err() {
        let Some(parent) = current.parent().map(Path::to_path_buf) else {
            break;
        };
        if parent == current {
            break;
        }
        if let Some(name) = current.file_name() {
            tail.insert(0, name.to_owned());
        }
        current = parent;
    }
    let real = match std::fs::canonicalize(&current) {
        Ok(real) => real,
        Err(_) => match (current.parent(), current.file_name()) {
            // A denied directory can be seen but not resolved: resolve its
            // parent instead.
            (Some(parent), Some(name)) if parent != current => {
                PathBuf::from(real_resolve(&parent.display().to_string())).join(name)
            }
            _ => current.clone(),
        },
    };
    let mut out = real;
    for part in tail {
        out.push(part);
    }
    normalize(&out).display().to_string()
}

/// Symlinks followed by [`physical_resolve`] before giving up, as the
/// kernel's `MAXSYMLINKS` (Linux's limit; macOS allows 32).
const MAX_SYMLINK_HOPS: usize = 40;

/// `input` (relative to `base`) as the kernel walks it: component by
/// component, each symlink followed before a later `..` is applied, so
/// `link/../x` is `x` next to the link's target, not next to the link.
/// [`resolve_path`] and [`real_resolve`] drop `link/..` as text first.
///
/// Once a component does not exist the rest is applied as text, as
/// [`real_resolve`] does (the kernel refuses `missing/..` anyway). A
/// dangling link is followed to where a write through it would create its
/// target; a loop past [`MAX_SYMLINK_HOPS`] stops following.
pub fn physical_resolve(base: &str, input: &str) -> String {
    let joined = Path::new(base).join(input);
    let mut pending: std::collections::VecDeque<std::ffi::OsString> = joined
        .components()
        .filter_map(|component| match component {
            Component::ParentDir => Some("..".into()),
            Component::Normal(part) => Some(part.to_owned()),
            _ => None,
        })
        .collect();
    let mut out = PathBuf::from("/");
    let mut on_disk = true;
    let mut hops = 0;
    while let Some(part) = pending.pop_front() {
        if part == ".." {
            out.pop();
            continue;
        }
        out.push(&part);
        if !on_disk {
            continue;
        }
        let Ok(meta) = std::fs::symlink_metadata(&out) else {
            on_disk = false;
            continue;
        };
        if !meta.file_type().is_symlink() {
            continue;
        }
        hops += 1;
        let target = match std::fs::read_link(&out) {
            Ok(target) if hops <= MAX_SYMLINK_HOPS => target,
            _ => {
                on_disk = false;
                continue;
            }
        };
        out.pop();
        if target.is_absolute() {
            out = PathBuf::from("/");
        }
        for component in target.components().rev() {
            match component {
                Component::ParentDir => pending.push_front("..".into()),
                Component::Normal(part) => pending.push_front(part.to_owned()),
                _ => {}
            }
        }
    }
    normalize(&out).display().to_string()
}

/// `isInside(child, parent)`.
pub fn is_inside(child: &str, parent: &str) -> bool {
    if child == parent {
        return true;
    }
    if parent.ends_with('/') {
        child.starts_with(parent)
    } else {
        child
            .strip_prefix(parent)
            .is_some_and(|rest| rest.starts_with('/'))
    }
}

/// `expandHomePath(value, home)`.
pub fn expand_home_path(value: &str, home: &str) -> String {
    if value == "~" {
        home.to_owned()
    } else if let Some(rest) = value.strip_prefix("~/") {
        resolve_path(home, rest)
    } else {
        value.to_owned()
    }
}

fn longest(rules: &[String], real: &str) -> Option<usize> {
    rules
        .iter()
        .filter(|rule| is_inside(real, rule))
        .map(String::len)
        .max()
}

/// `readAllowed`: the innermost rule containing `real` decides; allow wins
/// a tie, like srt.
pub fn read_allowed(policy: &PathPolicy, real: &str) -> bool {
    match longest(&policy.deny_read, real) {
        None => true,
        Some(deny) => longest(&policy.allow_read, real).is_some_and(|allow| allow >= deny),
    }
}

/// `writeAllowed`.
pub fn write_allowed(policy: &PathPolicy, real: &str) -> bool {
    policy.allow_write.iter().any(|root| is_inside(real, root))
        && !policy.deny_write.iter().any(|root| is_inside(real, root))
}

/// `defaultPathPolicy(allowWrite, home)`: what the file tools apply
/// outside a node, credential stores only.
pub fn default_path_policy(allow_write: &[String], home: &str) -> PathPolicy {
    PathPolicy {
        deny_read: SENSITIVE_HOME_PATHS
            .iter()
            .map(|item| real_resolve(&resolve_path(home, item)))
            .collect(),
        allow_read: Vec::new(),
        allow_write: allow_write.iter().map(|item| real_resolve(item)).collect(),
        deny_write: Vec::new(),
        shared_write: None,
    }
}

/// `inProjectConfigDir`: inside a `.pirc/` directory below a writable root,
/// at any depth (compared case-insensitively).
pub fn in_project_config_dir(real: &str, roots: &[String]) -> bool {
    roots.iter().any(|root| {
        is_inside(real, root)
            && Path::new(real).strip_prefix(root).is_ok_and(|relative| {
                relative.components().any(|part| {
                    part.as_os_str()
                        .to_string_lossy()
                        .eq_ignore_ascii_case(".pirc")
                })
            })
    })
}

/// `PathGuard`: reads are open except denied regions (credential stores,
/// pirc's state), writes only inside allowed roots and never into
/// protected ones.
#[derive(Clone, Debug)]
pub struct PathGuard {
    pub cwd: String,
    policy: PathPolicy,
    shared_roots: Vec<String>,
    protected_roots: Vec<String>,
    home: String,
}

impl PathGuard {
    pub fn new(cwd: &str, policy: &PathPolicy, protected_paths: &[String]) -> Self {
        let home = std::env::var("HOME").unwrap_or_default();
        Self::with_home(cwd, policy, protected_paths, &home)
    }

    /// As [`PathGuard::new`], with `~` meaning `home`.
    pub fn with_home(
        cwd: &str,
        policy: &PathPolicy,
        protected_paths: &[String],
        home: &str,
    ) -> Self {
        let resolve = |items: &[String]| items.iter().map(|item| real_resolve(item)).collect();
        Self {
            cwd: cwd.to_owned(),
            policy: PathPolicy {
                deny_read: resolve(&policy.deny_read),
                allow_read: resolve(&policy.allow_read),
                allow_write: resolve(&policy.allow_write),
                deny_write: resolve(&policy.deny_write),
                shared_write: None,
            },
            shared_roots: resolve(policy.shared_write.as_deref().unwrap_or_default()),
            protected_roots: resolve(protected_paths),
            home: home.to_owned(),
        }
    }

    /// `allowedRoots`: the roots the file tools may write under.
    pub fn allowed_roots(&self) -> &[String] {
        &self.policy.allow_write
    }

    /// `rootOf`: the innermost writable root containing `absolute`.
    pub fn root_of(&self, absolute: &str) -> Option<String> {
        let real = real_resolve(absolute);
        self.policy
            .allow_write
            .iter()
            .filter(|root| is_inside(&real, root))
            .max_by_key(|root| root.len())
            .cloned()
    }

    /// `leaseRoot`: the root whose write lease covers `absolute` (the path
    /// itself outside every root); `None` for a shared root.
    pub fn lease_root(&self, absolute: &str) -> Option<String> {
        match self.root_of(absolute) {
            Some(root) if self.shared_roots.contains(&root) => None,
            Some(root) => Some(root),
            None => Some(absolute.to_owned()),
        }
    }

    /// `resolve(input, mode)`: the absolute path, or the refusal text.
    pub fn resolve(&self, input: &str, write: bool) -> Result<String, String> {
        if input.is_empty() {
            return Err("Path is required".to_owned());
        }
        let cleaned = input.strip_prefix('@').unwrap_or(input);
        let absolute = resolve_path(&self.cwd, &expand_home_path(cleaned, &self.home));
        let real = real_resolve(&absolute);
        let shown = if real == absolute {
            input.to_owned()
        } else {
            format!("{input} ({real})")
        };
        if !write {
            if !read_allowed(&self.policy, &real) {
                return Err(format!(
                    "Path {shown} is private (credentials or pirc state) and cannot be read"
                ));
            }
            return Ok(absolute);
        }
        if !write_allowed(&self.policy, &real) {
            return Err(format!(
                "Path {shown} is outside the writable paths ({})",
                self.policy.allow_write.join(", ")
            ));
        }
        if self
            .protected_roots
            .iter()
            .any(|root| is_inside(&real, root))
            || in_project_config_dir(&real, &self.policy.allow_write)
        {
            return Err(format!(
                "Path {input} is protected agent configuration and cannot be modified"
            ));
        }
        Ok(absolute)
    }
}

/// `truncateOutput`: the head (30%) and tail of oversized output, so
/// errors at the end stay visible. Cuts are byte offsets; a split
/// character becomes U+FFFD, as Node's decoder makes it.
pub fn truncate_output(text: &str, max_bytes: usize) -> (String, bool) {
    let bytes = text.as_bytes();
    if bytes.len() <= max_bytes {
        return (text.to_owned(), false);
    }
    let head = max_bytes * 3 / 10;
    let tail = max_bytes - head;
    let out = format!(
        "{}\n\n[… {} bytes truncated …]\n\n{}",
        String::from_utf8_lossy(&bytes[..head]),
        bytes.len() - max_bytes,
        String::from_utf8_lossy(&bytes[bytes.len() - tail..])
    );
    (out, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap().display().to_string();
        (dir, root)
    }

    /// The list is `SENSITIVE_HOME_PATHS` of `sandbox-policy.ts`, entry for
    /// entry.
    #[test]
    fn sensitive_paths_match_the_typescript_list() {
        let entries: Vec<&str> = include_str!("../tests/fixtures/sensitive-home-paths.txt")
            .lines()
            .collect();
        assert_eq!(entries, SENSITIVE_HOME_PATHS);
    }

    #[test]
    fn resolves_paths_like_node() {
        assert_eq!(resolve_path("/a/b", "../c/./d/"), "/a/c/d");
        assert_eq!(resolve_path("/a", "/x//y"), "/x/y");
        assert_eq!(resolve_path("/", ".."), "/");
        assert_eq!(expand_home_path("~/x", "/home/u"), "/home/u/x");
        assert_eq!(expand_home_path("~", "/home/u"), "/home/u");
        assert_eq!(expand_home_path("a~", "/home/u"), "a~");
        assert!(is_inside("/a/b", "/a"));
        assert!(is_inside("/a", "/a"));
        assert!(!is_inside("/ab", "/a"));
        assert!(is_inside("/a/b", "/a/"));
    }

    #[test]
    fn real_resolve_follows_symlinks_of_the_existing_prefix() {
        let (_dir, root) = temp();
        std::fs::create_dir(format!("{root}/real")).unwrap();
        std::os::unix::fs::symlink(format!("{root}/real"), format!("{root}/link")).unwrap();
        assert_eq!(
            real_resolve(&format!("{root}/link/missing/file")),
            format!("{root}/real/missing/file")
        );
        assert_eq!(
            real_resolve(&format!("{root}/real/")),
            format!("{root}/real")
        );
    }

    #[test]
    fn innermost_rule_decides_reads() {
        let policy = PathPolicy {
            deny_read: vec!["/home/u/.ssh".to_owned(), "/state".to_owned()],
            allow_read: vec!["/state/session".to_owned()],
            ..PathPolicy::default()
        };
        assert!(!read_allowed(&policy, "/home/u/.ssh/id"));
        assert!(read_allowed(&policy, "/home/u/x"));
        assert!(read_allowed(&policy, "/state/session/file"));
        assert!(!read_allowed(&policy, "/state/other"));
        let policy = PathPolicy {
            allow_write: vec!["/w".to_owned()],
            deny_write: vec!["/w/.git/hooks".to_owned()],
            ..PathPolicy::default()
        };
        assert!(write_allowed(&policy, "/w/a"));
        assert!(!write_allowed(&policy, "/w/.git/hooks/pre-commit"));
        assert!(!write_allowed(&policy, "/x"));
    }

    #[test]
    fn guard_refuses_private_reads_and_protected_writes() {
        let (_dir, root) = temp();
        let home = format!("{root}/home");
        let workspace = format!("{root}/workspace");
        std::fs::create_dir_all(format!("{home}/.ssh")).unwrap();
        std::fs::create_dir_all(format!("{workspace}/.git/hooks")).unwrap();
        let policy = default_path_policy(std::slice::from_ref(&workspace), &home);
        let guard = PathGuard::with_home(
            &workspace,
            &policy,
            &[format!("{workspace}/.git/hooks")],
            &home,
        );
        assert_eq!(
            guard.resolve("a.txt", false).unwrap(),
            format!("{workspace}/a.txt")
        );
        assert_eq!(
            guard.resolve("@a.txt", true).unwrap(),
            format!("{workspace}/a.txt")
        );
        assert_eq!(
            guard.resolve("~/.ssh/id", false).unwrap_err(),
            "Path ~/.ssh/id is private (credentials or pirc state) and cannot be read"
        );
        // The refusal names the real path when a link leads there (`/etc` is
        // `/private/etc` on macOS).
        let etc = real_resolve("/etc/x");
        let shown = if etc == "/etc/x" {
            "/etc/x".to_owned()
        } else {
            format!("/etc/x ({etc})")
        };
        assert_eq!(
            guard.resolve("/etc/x", true).unwrap_err(),
            format!("Path {shown} is outside the writable paths ({workspace})")
        );
        assert_eq!(
            guard.resolve(".git/hooks/pre-commit", true).unwrap_err(),
            "Path .git/hooks/pre-commit is protected agent configuration and cannot be modified"
        );
        assert_eq!(
            guard.resolve("sub/.PIRC/config.json", true).unwrap_err(),
            "Path sub/.PIRC/config.json is protected agent configuration and cannot be modified"
        );
        assert_eq!(guard.resolve("", false).unwrap_err(), "Path is required");
        assert_eq!(
            guard.lease_root(&format!("{workspace}/a/b")),
            Some(workspace.clone())
        );
        assert_eq!(
            guard.lease_root("/elsewhere"),
            Some("/elsewhere".to_owned())
        );
        std::os::unix::fs::symlink("/etc", format!("{workspace}/etc-link")).unwrap();
        assert_eq!(
            guard.resolve("etc-link/x", true).unwrap_err(),
            format!("Path etc-link/x ({etc}) is outside the writable paths ({workspace})")
        );
    }

    #[test]
    fn physical_resolve_follows_links_before_parent_components() {
        let (_dir, root) = temp();
        std::fs::create_dir_all(format!("{root}/home/.config")).unwrap();
        std::fs::create_dir_all(format!("{root}/ws")).unwrap();
        let ws = format!("{root}/ws");
        std::os::unix::fs::symlink(format!("{root}/home/.config"), format!("{ws}/abs")).unwrap();
        std::os::unix::fs::symlink("../home/.config", format!("{ws}/rel")).unwrap();
        std::os::unix::fs::symlink("rel", format!("{ws}/chain")).unwrap();
        // `resolve_path` drops `link/..` as text: the workspace.
        assert_eq!(
            real_resolve(&resolve_path(&ws, "abs/../.bashrc")),
            format!("{ws}/.bashrc")
        );
        for link in ["abs", "rel", "chain"] {
            assert_eq!(
                physical_resolve(&ws, &format!("{link}/../.bashrc")),
                format!("{root}/home/.bashrc"),
                "{link}"
            );
            assert_eq!(
                physical_resolve(&ws, &format!("{link}/../.config/../../ws/a")),
                format!("{ws}/a"),
                "{link}"
            );
        }
        assert_eq!(physical_resolve(&ws, "a/./b/../c"), format!("{ws}/a/c"));
        assert_eq!(physical_resolve("/", &format!("{ws}/x")), format!("{ws}/x"));
        assert_eq!(physical_resolve(&ws, "missing/../y"), format!("{ws}/y"));
        // A dangling link: a write creates its target.
        std::os::unix::fs::symlink(format!("{root}/home/new"), format!("{ws}/dangling")).unwrap();
        assert_eq!(
            physical_resolve(&ws, "dangling"),
            format!("{root}/home/new")
        );
        // A loop stops following without hanging.
        std::os::unix::fs::symlink("loop", format!("{ws}/loop")).unwrap();
        assert!(physical_resolve(&ws, "loop/x").ends_with("/x"));
    }

    #[test]
    fn shared_roots_take_no_lease() {
        let (_dir, root) = temp();
        let policy = PathPolicy {
            allow_write: vec![format!("{root}/w"), format!("{root}/tmp")],
            shared_write: Some(vec![format!("{root}/tmp")]),
            ..PathPolicy::default()
        };
        let guard = PathGuard::with_home(&format!("{root}/w"), &policy, &[], "/home/u");
        assert_eq!(guard.lease_root(&format!("{root}/tmp/x")), None);
        assert_eq!(
            guard.lease_root(&format!("{root}/w/x")),
            Some(format!("{root}/w"))
        );
    }

    #[test]
    fn truncates_head_and_tail() {
        assert_eq!(truncate_output("short", 10), ("short".to_owned(), false));
        let (text, truncated) = truncate_output("0123456789abcdefghij", 10);
        assert!(truncated);
        assert_eq!(text, "012\n\n[… 10 bytes truncated …]\n\ndefghij");
        let (text, _) = truncate_output("ééééé", 4);
        assert_eq!(text, "\u{fffd}\n\n[… 6 bytes truncated …]\n\n\u{fffd}é");
    }
}
