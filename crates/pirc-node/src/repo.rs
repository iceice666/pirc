//! A directory workspace's repository identity for the gateway: its
//! `origin` remote, normalized ([`pirc_protocol::normalize_origin`]), so
//! the assistant finds workspace memory across clones
//! (docs/architecture/assistant-memory.md).
//!
//! The URL is read from the repository's config file, never by running
//! git: a workspace is agent-writable, and git on the host runs whatever
//! its config says (security audit S8). Only `[remote "origin"] url` is
//! read; `include`, `includeIf` and `url.<base>.insteadOf` are not
//! followed, so a URL rewritten only through those has no key. Only the
//! workspace's own `.git` counts, never one above it: a directory inside a
//! home directory kept in git is not that repository. Read at registration
//! and on creation: a remote changed later is seen when the node registers
//! again.
//!
//! Accepted limit: a `.git` symlink, an absolute `gitdir:` or `commondir`
//! may point at another repository the node account can read, and its key
//! is then reported for this workspace. Only a normalized `host/path`
//! leaves the node, and a key only joins notes of the same user, which a
//! search without a workspace already returns.

use std::fs::File;
use std::io::Read as _;
use std::os::unix::fs::OpenOptionsExt as _;
use std::path::{Path, PathBuf};

/// Git files read here are small; a larger one is not a git file.
const MAX_BYTES: u64 = 256 * 1024;

/// The workspace's repository key, or `None` without a network `origin`.
pub fn workspace_repo(root: &Path) -> Option<String> {
    let config = read_small(&common_dir(root)?.join("config"))?;
    pirc_protocol::normalize_origin(&origin_url(&config)?)
}

/// A regular file's text, at most [`MAX_BYTES`]; never blocks on a FIFO
/// and never takes a terminal as the node's controlling one.
fn read_small(path: &Path) -> Option<String> {
    // Checked again on the open file; this only avoids opening most
    // devices at all.
    if !std::fs::metadata(path).ok()?.is_file() {
        return None;
    }
    let flags = nix::fcntl::OFlag::O_NONBLOCK | nix::fcntl::OFlag::O_NOCTTY;
    let file = File::options()
        .read(true)
        .custom_flags(flags.bits())
        .open(path)
        .ok()?;
    let meta = file.metadata().ok()?;
    if !meta.is_file() || meta.len() > MAX_BYTES {
        return None;
    }
    let mut text = String::new();
    file.take(MAX_BYTES).read_to_string(&mut text).ok()?;
    Some(text)
}

/// The repository's common git directory (shared by its worktrees), from
/// the workspace's own `.git`.
fn common_dir(root: &Path) -> Option<PathBuf> {
    let dot_git = root.join(".git");
    let git_dir = if dot_git.is_dir() {
        dot_git
    } else {
        // A worktree or submodule: `gitdir: <path>`.
        let text = read_small(&dot_git)?;
        let path = text
            .lines()
            .find_map(|line| line.strip_prefix("gitdir:"))?
            .trim();
        root.join(path)
    };
    match read_small(&git_dir.join("commondir")) {
        Some(common) => Some(git_dir.join(common.trim())),
        None => Some(git_dir),
    }
}

/// The first `url` of `[remote "origin"]` in a git config file.
pub fn origin_url(config: &str) -> Option<String> {
    let mut in_origin = false;
    for line in config.lines() {
        let line = line.trim();
        if let Some(header) = line.strip_prefix('[') {
            let Some(end) = header.find(']') else {
                in_origin = false;
                continue;
            };
            in_origin = is_origin_section(&header[..end]);
            // `[remote "origin"] url = …` on one line.
            let rest = header[end + 1..].trim();
            if in_origin && let Some(url) = url_value(rest) {
                return Some(url);
            }
            continue;
        }
        if in_origin && let Some(url) = url_value(line) {
            return Some(url);
        }
    }
    None
}

/// `remote "origin"`, or the old `remote.origin`. Section names ignore
/// case, subsection names do not.
fn is_origin_section(header: &str) -> bool {
    let header = header.trim();
    if let Some((section, sub)) = header.split_once(char::is_whitespace) {
        return section.eq_ignore_ascii_case("remote") && sub.trim() == "\"origin\"";
    }
    header.eq_ignore_ascii_case("remote.origin")
}

/// The value of a `url = value` line, unquoted and without its comment.
fn url_value(line: &str) -> Option<String> {
    let (key, value) = line.split_once('=')?;
    if !key.trim().eq_ignore_ascii_case("url") {
        return None;
    }
    let mut out = String::new();
    let mut quoted = false;
    let mut chars = value.trim().chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => quoted = !quoted,
            '\\' => match chars.next()? {
                'n' => out.push('\n'),
                't' => out.push('\t'),
                'b' => {
                    out.pop();
                }
                escaped => out.push(escaped),
            },
            '#' | ';' if !quoted => break,
            c => out.push(c),
        }
    }
    let out = out.trim().to_owned();
    (!out.is_empty()).then_some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_origin_url() {
        let config = "[core]\n\tbare = false\n[remote \"upstream\"]\n\turl = https://example.com/up/r.git\n[remote \"origin\"]\n\turl = git@github.com:me/pirc.git ; mine\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n\turl = https://second.example/x\n";
        assert_eq!(
            origin_url(config).as_deref(),
            Some("git@github.com:me/pirc.git")
        );
        assert_eq!(
            origin_url("[Remote \"origin\"]\nURL = \"https://h.example/a b#c\"\n").as_deref(),
            Some("https://h.example/a b#c")
        );
        assert_eq!(
            origin_url("[remote.origin]\nurl=https://h.example/a/b\n").as_deref(),
            Some("https://h.example/a/b")
        );
        assert_eq!(
            origin_url("[remote \"origin\"] url = https://h.example/one/line\n").as_deref(),
            Some("https://h.example/one/line")
        );
        assert_eq!(
            origin_url("[remote \"Origin\"]\nurl = https://h.example/a/b\n"),
            None
        );
        assert_eq!(
            origin_url("[remote \"origin\"]\nfetch = x\n[core]\nurl = y\n"),
            None
        );
    }

    fn temp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "pirc-repo-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn finds_the_repository_of_a_workspace() {
        let dir = temp();
        let main = dir.join("main");
        std::fs::create_dir_all(main.join(".git/worktrees/wt")).unwrap();
        std::fs::write(
            main.join(".git/config"),
            "[remote \"origin\"]\n\turl = https://user:tok@GitHub.com/me/pirc.git\n",
        )
        .unwrap();
        std::fs::write(main.join(".git/worktrees/wt/commondir"), "../..\n").unwrap();
        // A subdirectory of the clone is not the clone.
        std::fs::create_dir_all(main.join("crates/x")).unwrap();
        // A linked worktree next to it.
        let worktree = dir.join("wt");
        std::fs::create_dir_all(&worktree).unwrap();
        std::fs::write(
            worktree.join(".git"),
            format!("gitdir: {}\n", main.join(".git/worktrees/wt").display()),
        )
        .unwrap();
        // A clone without a remote, and a directory outside any repository.
        let local = dir.join("local");
        std::fs::create_dir_all(local.join(".git")).unwrap();
        std::fs::write(local.join(".git/config"), "[core]\n\tbare = false\n").unwrap();
        let plain = dir.join("plain");
        std::fs::create_dir_all(&plain).unwrap();

        let key = Some("github.com/me/pirc".to_owned());
        assert_eq!(workspace_repo(&main), key);
        assert_eq!(workspace_repo(&main.join("crates/x")), None);
        assert_eq!(workspace_repo(&worktree), key);
        assert_eq!(workspace_repo(&local), None);
        assert_eq!(workspace_repo(&plain), None);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_fifo_is_not_read() {
        let dir = temp();
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        let made = std::process::Command::new("mkfifo")
            .arg(dir.join(".git/config"))
            .status()
            .is_ok_and(|status| status.success());
        // Would hang here if the config were opened blocking.
        if made {
            assert_eq!(workspace_repo(&dir), None);
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
