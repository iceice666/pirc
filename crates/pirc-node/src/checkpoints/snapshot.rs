//! Bounded descriptor traversal. No source filesystem mutation or Git checkout.
use super::{FileVersion, Result, Scope, digest, err, files};
use pirc_policy::PathGuard;
use rustix::fs::{AtFlags, Dir, Mode, OFlags, open, openat, statat};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::File;
use std::os::unix::fs::MetadataExt;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct Content {
    pub bytes: Vec<u8>,
    pub executable: bool,
}
#[derive(Default)]
pub(super) struct Snapshot {
    pub files: BTreeMap<String, Content>,
    pub directories: BTreeSet<String>,
    pub excluded: BTreeMap<String, String>,
    pub fingerprint: String,
    pub bytes: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CopyLimits {
    pub bytes: u64,
    pub entries: usize,
    pub node_bytes: u64,
    pub free_reserve: u64,
}
impl Default for CopyLimits {
    fn default() -> Self {
        Self {
            bytes: 256 * 1024 * 1024,
            entries: 20_000,
            node_bytes: 1024 * 1024 * 1024,
            free_reserve: 64 * 1024 * 1024,
        }
    }
}
impl CopyLimits {
    pub(super) fn validate(&self) -> Result<()> {
        if self.bytes == 0
            || self.bytes > 1024 * 1024 * 1024
            || self.entries == 0
            || self.entries > 100_000
            || self.node_bytes > i64::MAX as u64
            || self.bytes > self.node_bytes
        {
            return Err(err("invalid recovery copy limits"));
        }
        Ok(())
    }
}

pub(super) fn scan(
    scope: &Scope,
    limits: &CopyLimits,
    file_limit: u64,
    git: Option<&BTreeSet<String>>,
) -> Result<Snapshot> {
    let root = File::from(
        open(
            &scope.root,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(err)?,
    );
    let m = root.metadata().map_err(err)?;
    if (m.dev(), m.ino()) != (scope.device, scope.inode) {
        return Err(err("workspace identity changed"));
    }
    let mut walker = Walker {
        scope,
        limits,
        file_limit,
        git,
        out: Snapshot::default(),
        count: 0,
        stamps: Vec::new(),
    };
    walker.walk(&root, "", 0)?;
    let named = std::fs::symlink_metadata(&scope.root).map_err(err)?;
    if !named.is_dir() || (named.dev(), named.ino()) != (scope.device, scope.inode) {
        return Err(err("workspace identity changed"));
    }
    walker.out.fingerprint = digest(
        &serde_json::to_vec(&(
            scope.device,
            scope.inode,
            &scope.policy,
            git,
            &walker.stamps,
        ))
        .map_err(err)?,
    );
    Ok(walker.out)
}
struct Walker<'a> {
    scope: &'a Scope,
    limits: &'a CopyLimits,
    file_limit: u64,
    git: Option<&'a BTreeSet<String>>,
    out: Snapshot,
    count: usize,
    stamps: Vec<(String, String)>,
}
impl Walker<'_> {
    fn walk(&mut self, dir: &File, prefix: &str, depth: usize) -> Result<()> {
        if depth > 64 {
            return Err(err("recovery directory depth limit exceeded"));
        }
        let before = dir.metadata().map_err(err)?;
        let mut names = Vec::new();
        for entry in Dir::read_from(dir).map_err(err)? {
            let entry = entry.map_err(err)?;
            let bytes = entry.file_name().to_bytes();
            if bytes == b"." || bytes == b".." {
                continue;
            }
            self.count += 1;
            if self.count > self.limits.entries {
                return Err(err("recovery entry limit exceeded"));
            }
            let name = std::str::from_utf8(bytes)
                .map_err(|_| err("non-UTF8 path requires manual recovery"))?;
            names.push(name.to_owned());
        }
        names.sort();
        for name in names {
            let path = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            if path.len() > 4096 {
                return Err(err("recovery path limit exceeded"));
            }
            let stat = statat(dir, name.as_str(), AtFlags::SYMLINK_NOFOLLOW).map_err(err)?;
            // Include identities/timestamps of excluded entries without reading their contents.
            self.stamps.push((
                path.clone(),
                format!(
                    "{}:{}:{}:{}:{}:{:?}:{:?}",
                    stat.st_dev,
                    stat.st_ino,
                    stat.st_mode,
                    stat.st_size,
                    stat.st_nlink,
                    stat.st_mtime,
                    stat.st_ctime
                ),
            ));
            if matches!(
                name.to_ascii_lowercase().as_str(),
                ".git" | ".pirc" | ".state" | "node_modules" | "target" | "build" | ".dart_tool"
            ) {
                self.out.excluded.insert(path, "excluded_directory".into());
                continue;
            }
            let guard = PathGuard::new(&self.scope.root.to_string_lossy(), &self.scope.policy, &[]);
            if guard
                .resolve(&self.scope.root.join(&path).to_string_lossy(), false)
                .is_err()
            {
                self.out.excluded.insert(path, "deny_read".into());
                continue;
            }
            let kind = rustix::fs::FileType::from_raw_mode(stat.st_mode);
            if kind == rustix::fs::FileType::Directory {
                let child = File::from(
                    openat(
                        dir,
                        name.to_ascii_lowercase().as_str(),
                        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                        Mode::empty(),
                    )
                    .map_err(err)?,
                );
                let m = child.metadata().map_err(err)?;
                #[allow(clippy::unnecessary_cast)]
                let identity = (stat.st_dev as u64, stat.st_ino as u64);
                if (m.dev(), m.ino()) != identity {
                    return Err(err("directory changed during recovery scan"));
                }
                if m.dev() != self.scope.device {
                    self.out.excluded.insert(path, "mount_crossing".into());
                    continue;
                }
                match statat(&child, ".git", AtFlags::SYMLINK_NOFOLLOW) {
                    Ok(_) => {
                        self.out.excluded.insert(path, "nested_repository".into());
                        continue;
                    }
                    Err(rustix::io::Errno::NOENT) => {}
                    Err(e) => return Err(err(e)),
                }
                self.out.directories.insert(path.clone());
                self.walk(&child, &path, depth + 1)?;
            } else if kind == rustix::fs::FileType::RegularFile {
                if self.git.is_some_and(|set| !set.contains(&path)) {
                    self.out
                        .excluded
                        .insert(path, "git_ignored_or_unlisted".into());
                    continue;
                }
                let observation = files::observe(self.scope, &path, self.file_limit)?;
                match observation.version {
                    FileVersion::File {
                        hash, executable, ..
                    } => {
                        let bytes = observation
                            .bytes
                            .ok_or_else(|| err("missing file observation"))?;
                        self.out.bytes = self
                            .out
                            .bytes
                            .checked_add(bytes.len() as u64)
                            .ok_or_else(|| err("recovery byte overflow"))?;
                        if self.out.bytes > self.limits.bytes {
                            return Err(err("recovery copy byte limit exceeded"));
                        }
                        self.stamps.push((path.clone(), hash));
                        self.out.files.insert(path, Content { bytes, executable });
                    }
                    FileVersion::Excluded { reason }
                        if !matches!(
                            reason.as_str(),
                            "changed_during_read" | "workspace_identity_changed"
                        ) =>
                    {
                        self.out.excluded.insert(path, reason);
                    }
                    _ => return Err(err("source changed during recovery scan")),
                }
            } else {
                self.out
                    .excluded
                    .insert(path, "link_or_special_file".into());
            }
        }
        let after = dir.metadata().map_err(err)?;
        if before.mtime() != after.mtime()
            || before.mtime_nsec() != after.mtime_nsec()
            || before.ctime() != after.ctime()
            || before.ctime_nsec() != after.ctime_nsec()
        {
            return Err(err("directory changed during recovery scan"));
        }
        Ok(())
    }
}
