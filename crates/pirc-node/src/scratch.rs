//! Scratch sessions' directories are kept for a while and then removed
//! (plans/rewrite/08-nodes.md): a scratch workspace (mode `scratch`, one
//! directory per session under `<workspace>/sessions/`) holds throwaway
//! work, and the worker reports what matters. A directory nothing in it
//! changed for `PIRC_SCRATCH_RETENTION_DAYS` (default 7; 0 keeps them) is
//! removed, unless its session's agent runs. Only scratch workspaces are
//! swept, never other per-session modes or repositories.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use pirc_config::node::SCRATCH;

use crate::services::Node;
use crate::store::Store as _;

/// How often the node looks.
const EVERY: Duration = Duration::from_secs(60 * 60);
/// Entries looked at for one directory's latest change, at most.
const ENTRIES: usize = 20_000;

/// Sweep now and then, as long as the node runs.
pub async fn sweep_forever(node: Node) {
    let days = node.config.scratch_retention_days;
    if days == 0 {
        return;
    }
    let keep = Duration::from_secs(days * 24 * 60 * 60);
    let mut first = true;
    loop {
        tokio::time::sleep(if first {
            Duration::from_secs(60)
        } else {
            EVERY
        })
        .await;
        first = false;
        let roots: Vec<PathBuf> = node
            .db
            .lock()
            .list_workspaces()
            .unwrap_or_default()
            .into_iter()
            .filter(|workspace| {
                workspace.host_id == node.config.node_id && workspace.mode.as_str() == SCRATCH
            })
            .map(|workspace| PathBuf::from(workspace.canonical_path).join("sessions"))
            .collect();
        let looking = node.clone();
        let alive = move |session: &str| {
            looking
                .runners
                .get(session)
                .is_some_and(|runner| runner.alive())
        };
        let swept = tokio::task::spawn_blocking(move || {
            let now = SystemTime::now();
            roots
                .iter()
                .flat_map(|root| sweep(root, keep, now, &alive))
                .collect::<Vec<_>>()
        })
        .await
        .unwrap_or_default();
        for dir in swept {
            crate::log::info(&format!("removed the scratch directory {}", dir.display()));
        }
    }
}

/// Remove the session directories under `root` unchanged for `keep` whose
/// session is not `alive`; the ones removed.
pub fn sweep(
    root: &Path,
    keep: Duration,
    now: SystemTime,
    alive: &dyn Fn(&str) -> bool,
) -> Vec<PathBuf> {
    let mut removed = Vec::new();
    let Ok(entries) = std::fs::read_dir(root) else {
        return removed;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        let is_dir = std::fs::symlink_metadata(&path).is_ok_and(|meta| meta.is_dir());
        if !is_dir || alive(&name) {
            continue;
        }
        let Some(latest) = latest_change(&path) else {
            continue;
        };
        if now.duration_since(latest).is_ok_and(|age| age >= keep)
            && std::fs::remove_dir_all(&path).is_ok()
        {
            removed.push(path);
        }
    }
    removed
}

/// The latest modification of `dir` or anything in it (links not
/// followed); `None` when it cannot all be looked at.
fn latest_change(dir: &Path) -> Option<SystemTime> {
    let mut latest = std::fs::symlink_metadata(dir).ok()?.modified().ok()?;
    let mut stack = vec![dir.to_owned()];
    let mut seen = 0;
    while let Some(next) = stack.pop() {
        for entry in std::fs::read_dir(&next).ok()?.flatten() {
            seen += 1;
            if seen > ENTRIES {
                return None;
            }
            let meta = std::fs::symlink_metadata(entry.path()).ok()?;
            latest = latest.max(meta.modified().ok()?);
            if meta.is_dir() {
                stack.push(entry.path());
            }
        }
    }
    Some(latest)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removes_old_session_directories_but_not_running_or_recent_ones() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        for session in ["old", "running", "fresh"] {
            std::fs::create_dir_all(root.join(session).join("out")).unwrap();
            std::fs::write(root.join(session).join("out/result.txt"), "x").unwrap();
        }
        std::fs::write(root.join("a-file"), "x").unwrap();
        let keep = Duration::from_secs(7 * 24 * 3600);
        // Seen from eight days later, everything is old.
        let later = SystemTime::now() + Duration::from_secs(8 * 24 * 3600);
        let removed = sweep(root, keep, later, &|session| session == "running");
        let mut names: Vec<String> = removed
            .iter()
            .map(|path| path.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names, ["fresh", "old"]);
        assert!(root.join("running/out/result.txt").exists());
        assert!(root.join("a-file").exists());
        // From now, nothing is old.
        std::fs::create_dir_all(root.join("new")).unwrap();
        assert!(sweep(root, keep, SystemTime::now(), &|_| false).is_empty());
    }
}
