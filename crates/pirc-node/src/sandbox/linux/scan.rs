//! The mandatory deny paths: files and directories below the agent's
//! working directory that stay read-only whatever the policy says.
//!
//! Ported from sandbox-runtime 0.0.78 `sandbox/linux-sandbox-utils.js`
//! (`linuxGetCwdMandatoryDenyPaths`, `linuxGetMandatoryDenyPaths`) and
//! `sandbox/sandbox-utils.js` (`DANGEROUS_FILES`, `DANGEROUS_DIRECTORIES`,
//! `getDangerousDirectories`) (Apache-2.0, see `crates/pirc-node/NOTICE`).
//!
//! srt finds the nested matches with one `rg --files --hidden --max-depth 3
//! --iglob … -g '!**/node_modules/**'` call; this walks the tree itself with
//! the same limits and globs. Deviations, both stricter:
//!
//! - ignore files (`.gitignore`, `.ignore`, `.rgignore`, git's excludes)
//!   are not honoured, so an ignored directory is scanned too (ripgrep
//!   skipped it, and a dangerous file the agent could hide that way stayed
//!   writable);
//! - a match's dangerous directory is looked for in the part of the path
//!   below the working directory only (srt split the absolute path, so a
//!   working directory below a `.idea` or `.vscode` directory denied an
//!   ancestor of it, the whole workspace).

use std::path::Path;

/// `DANGEROUS_FILES`: files that run code or leak data when written.
pub const DANGEROUS_FILES: [&str; 9] = [
    ".gitconfig",
    ".gitmodules",
    ".bashrc",
    ".bash_profile",
    ".zshrc",
    ".zprofile",
    ".profile",
    ".ripgreprc",
    ".mcp.json",
];

/// `getDangerousDirectories()`: `DANGEROUS_DIRECTORIES` without `.git`
/// (its `hooks` and `config` are denied instead, so git keeps working).
pub const DANGEROUS_DIRECTORIES: [&str; 4] =
    [".vscode", ".idea", ".claude/commands", ".claude/agents"];

/// `DEFAULT_MANDATORY_DENY_SEARCH_DEPTH`: how deep below the working
/// directory the scan looks (ripgrep's `--max-depth`: a direct child is at
/// depth 1).
pub const SEARCH_DEPTH: usize = 3;

fn join(dir: &str, rest: &str) -> String {
    if dir == "/" {
        format!("/{rest}")
    } else {
        format!("{dir}/{rest}")
    }
}

/// `linuxGetCwdMandatoryDenyPaths`: the dangerous files and directories
/// resolved against `cwd`, plus `.git/hooks` and (unless `allow_git_config`)
/// `.git/config` when `.git` is a directory (a worktree's `.git` file has
/// neither, and denying them when `.git` is missing would stop `git init`).
pub fn cwd_mandatory_deny_paths(cwd: &str, allow_git_config: bool) -> Vec<String> {
    let mut paths: Vec<String> = DANGEROUS_FILES
        .iter()
        .chain(DANGEROUS_DIRECTORIES.iter())
        .map(|name| join(cwd, name))
        .collect();
    if Path::new(&join(cwd, ".git")).is_dir() {
        paths.push(join(cwd, ".git/hooks"));
        if !allow_git_config {
            paths.push(join(cwd, ".git/config"));
        }
    }
    paths
}

/// Whether ripgrep would list `components` (a file's path below the working
/// directory) for srt's globs: an `--iglob` of each dangerous file name
/// (matched at any depth), `**/<dir>/**` of each dangerous directory and of
/// `.git/hooks`, and `**/.git/config` unless git config is allowed. Globs
/// are case-insensitive, as `--iglob` is.
fn matches(components: &[String], allow_git_config: bool) -> bool {
    let lower: Vec<String> = components.iter().map(|c| c.to_lowercase()).collect();
    let Some((name, dirs)) = lower.split_last() else {
        return false;
    };
    if DANGEROUS_FILES.contains(&name.as_str()) {
        return true;
    }
    // `**/<a>/<b>/**`: the components appear in a row, before the file name.
    let inside = |pattern: &str| {
        let parts: Vec<&str> = pattern.split('/').collect();
        dirs.windows(parts.len()).any(|window| window == parts)
    };
    if DANGEROUS_DIRECTORIES.iter().any(|dir| inside(dir)) || inside(".git/hooks") {
        return true;
    }
    !allow_git_config && name == "config" && dirs.last().is_some_and(|dir| dir == ".git")
}

/// The files below `cwd` ripgrep would list: not deeper than
/// [`SEARCH_DEPTH`], hidden ones included, symlinks listed but not
/// followed, nothing below a `node_modules` directory. In name order, so
/// the result does not depend on the directory's.
fn walk(cwd: &Path, allow_git_config: bool) -> Vec<String> {
    let mut found = Vec::new();
    let mut stack: Vec<(std::path::PathBuf, Vec<String>)> = vec![(cwd.to_path_buf(), Vec::new())];
    while let Some((dir, prefix)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        let mut entries: Vec<_> = entries.flatten().collect();
        entries.sort_by_key(|entry| entry.file_name());
        // Pushed in reverse so the stack pops them in name order.
        for entry in entries.into_iter().rev() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let name = entry.file_name().to_string_lossy().into_owned();
            let mut components = prefix.clone();
            components.push(name.clone());
            if kind.is_dir() {
                if components.len() < SEARCH_DEPTH && name != "node_modules" {
                    stack.push((entry.path(), components));
                }
            } else if matches(&components, allow_git_config) {
                found.push(components.join("/"));
            }
        }
    }
    found.sort();
    found
}

/// `linuxGetMandatoryDenyPaths`: [`cwd_mandatory_deny_paths`] and what the
/// scan finds below `cwd` (see the module documentation): a file inside a
/// dangerous directory denies the directory, one inside `.git` its `hooks`
/// or `config`, any other match the file itself. Without repeats, in first
/// seen order. `cwd` is absolute and symlink-free.
pub fn mandatory_deny_paths(cwd: &str, allow_git_config: bool) -> Vec<String> {
    let mut paths = cwd_mandatory_deny_paths(cwd, allow_git_config);
    for found in walk(Path::new(cwd), allow_git_config) {
        let segments: Vec<&str> = found.split('/').collect();
        let mut denied = None;
        // srt's order: the dangerous directories first, `.git` last; a
        // `.claude/commands`-style name never equals one segment, so files
        // there are denied one by one, as in srt.
        for dir in DANGEROUS_DIRECTORIES.iter().chain([".git"].iter()) {
            let Some(at) = segments.iter().position(|s| s.eq_ignore_ascii_case(dir)) else {
                continue;
            };
            let base = join(cwd, &segments[..=at].join("/"));
            denied = Some(if *dir == ".git" {
                if found.contains(".git/hooks") {
                    Some(join(&base, "hooks"))
                } else if found.contains(".git/config") {
                    Some(join(&base, "config"))
                } else {
                    None
                }
            } else {
                Some(base)
            });
            break;
        }
        let path = match denied {
            Some(Some(path)) => path,
            Some(None) => continue,
            None => join(cwd, &found),
        };
        if !paths.contains(&path) {
            paths.push(path);
        }
    }
    let mut seen = Vec::new();
    paths.retain(|path| {
        let new = !seen.contains(path);
        seen.push(path.clone());
        new
    });
    paths
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    fn tree(files: &[&str]) -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap().display().to_string();
        for file in files {
            let path = Path::new(&root).join(file);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, "").unwrap();
        }
        (dir, root)
    }

    #[test]
    fn the_working_directory_s_own_paths() {
        let (_dir, root) = tree(&[]);
        let p = |rest: &str| format!("{root}/{rest}");
        let expected: Vec<String> = [
            ".gitconfig",
            ".gitmodules",
            ".bashrc",
            ".bash_profile",
            ".zshrc",
            ".zprofile",
            ".profile",
            ".ripgreprc",
            ".mcp.json",
            ".vscode",
            ".idea",
            ".claude/commands",
            ".claude/agents",
        ]
        .iter()
        .map(|name| p(name))
        .collect();
        assert_eq!(cwd_mandatory_deny_paths(&root, false), expected);
        fs::create_dir(p(".git")).unwrap();
        let with_git = cwd_mandatory_deny_paths(&root, false);
        assert_eq!(with_git[13..], [p(".git/hooks"), p(".git/config")]);
        assert_eq!(
            cwd_mandatory_deny_paths(&root, true)[13..],
            [p(".git/hooks")]
        );
        // A worktree's `.git` file: nothing below it can exist.
        fs::remove_dir(p(".git")).unwrap();
        fs::write(p(".git"), "gitdir: /elsewhere").unwrap();
        assert_eq!(cwd_mandatory_deny_paths(&root, false).len(), 13);
    }

    #[test]
    fn the_scan_follows_srts_globs_and_limits() {
        let (_dir, root) = tree(&[
            "sub/.bashrc",
            "sub/deeper/.ZSHRC",
            "a/b/c/.bashrc",
            "sub/.vscode/settings.json",
            "sub/.Idea/workspace.xml",
            "sub/.git/config",
            "sub/.git/description",
            "sub/.git/hooks/pre-commit",
            ".git/hooks/pre-commit.sample",
            ".claude/commands/deploy.md",
            "node_modules/pkg/.bashrc",
            "x/node_modules/.mcp.json",
            "src/main.rs",
        ]);
        let p = |rest: &str| format!("{root}/{rest}");
        let found = mandatory_deny_paths(&root, false);
        let cwd = cwd_mandatory_deny_paths(&root, false);
        assert_eq!(found[..cwd.len()], cwd[..]);
        let nested: Vec<String> = found[cwd.len()..].to_vec();
        assert_eq!(
            nested,
            [
                // `.claude/commands` is two segments: the file itself.
                p(".claude/commands/deploy.md"),
                p("sub/.Idea"),
                p("sub/.bashrc"),
                p("sub/.git/config"),
                p("sub/.vscode"),
                p("sub/deeper/.ZSHRC"),
            ]
        );
        // Depth 4: `a/b/c/.bashrc` and `sub/.git/hooks/pre-commit` are past
        // ripgrep's `--max-depth 3`; `node_modules` is never entered.
        assert!(!found.contains(&p("a/b/c/.bashrc")));
        assert!(!found.contains(&p("sub/.git/hooks")));
        assert!(!found.iter().any(|f| f.contains("node_modules")));
        // With git config allowed, nested configs are not matched either.
        let allowed = mandatory_deny_paths(&root, true);
        assert!(!allowed.contains(&p("sub/.git/config")));
        assert!(!allowed.contains(&p(".git/config")));
        assert!(allowed.contains(&p(".git/hooks")));
    }

    #[test]
    fn symlinks_are_listed_but_not_followed() {
        let (_dir, root) = tree(&["elsewhere/.bashrc", "real/x/.zshrc"]);
        let p = |rest: &str| format!("{root}/{rest}");
        std::os::unix::fs::symlink(p("real"), p("ws-link")).unwrap();
        std::os::unix::fs::symlink(p("elsewhere/.bashrc"), p("real/.profile")).unwrap();
        let found = mandatory_deny_paths(&root, false);
        assert!(found.contains(&p("real/.profile")));
        assert!(found.contains(&p("real/x/.zshrc")));
        assert!(!found.contains(&p("ws-link/x/.zshrc")));
    }
}
