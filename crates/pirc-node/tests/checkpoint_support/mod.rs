//! Test-only phase-1 spike. No runner, API, persistence or memory integration.
//!
//! These walkers run only on test-owned directories. They are NOT a hostile-
//! filesystem traversal boundary, a coherent multi-file snapshot, or a broker
//! for external writers. Later phases must supply those missing guarantees.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::Command;

use tempfile::TempDir;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct File {
    pub bytes: Vec<u8>,
    pub executable: bool,
}

impl File {
    pub fn text(text: &str) -> Self {
        Self {
            bytes: text.as_bytes().to_vec(),
            executable: false,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Snapshot {
    pub files: BTreeMap<PathBuf, File>,
    pub directories: BTreeSet<PathBuf>,
    pub excluded: BTreeSet<PathBuf>,
}

pub struct Rules {
    pub denied: Vec<PathBuf>,
    pub max_file_bytes: u64,
    pub max_total_bytes: u64,
    pub max_entries: usize,
}

impl Default for Rules {
    fn default() -> Self {
        Self {
            denied: vec![".git".into(), "private".into(), "ignored".into()],
            max_file_bytes: 1024 * 1024,
            max_total_bytes: 4 * 1024 * 1024,
            max_entries: 1000,
        }
    }
}

fn fail(message: &str) -> io::Error {
    io::Error::other(message)
}

fn root_identity(root: &Path) -> io::Result<(PathBuf, u64, u64)> {
    let canonical = root.canonicalize()?;
    let meta = fs::metadata(&canonical)?;
    if !meta.is_dir() {
        return Err(fail("source must be a directory"));
    }
    Ok((canonical, meta.dev(), meta.ino()))
}

pub fn snapshot(root: &Path, rules: &Rules) -> io::Result<Snapshot> {
    fn walk(
        root: &Path,
        dir: &Path,
        rules: &Rules,
        out: &mut Snapshot,
        total: &mut u64,
        entries: &mut usize,
    ) -> io::Result<()> {
        for entry in fs::read_dir(dir)? {
            let path = entry?.path();
            let relative = path.strip_prefix(root).map_err(|_| fail("outside root"))?;
            *entries += 1;
            if *entries > rules.max_entries {
                return Err(fail("entry budget exceeded"));
            }
            if rules.denied.iter().any(|deny| relative.starts_with(deny)) {
                out.excluded.insert(relative.into());
                continue;
            }
            let meta = fs::symlink_metadata(&path)?;
            if meta.is_dir() {
                out.directories.insert(relative.into());
                walk(root, &path, rules, out, total, entries)?;
            } else if !meta.is_file() || meta.nlink() != 1 || meta.len() > rules.max_file_bytes {
                out.excluded.insert(relative.into());
            } else {
                // Bounded reads even if a fixture writer grows the file.
                use std::io::Read;
                let mut bytes = Vec::new();
                fs::File::open(&path)?
                    .take(rules.max_file_bytes + 1)
                    .read_to_end(&mut bytes)?;
                if bytes.len() as u64 > rules.max_file_bytes {
                    return Err(fail("file grew past capture budget"));
                }
                *total += bytes.len() as u64;
                if *total > rules.max_total_bytes {
                    return Err(fail("capture byte budget exceeded"));
                }
                out.files.insert(
                    relative.into(),
                    File {
                        bytes,
                        executable: meta.permissions().mode() & 0o111 != 0,
                    },
                );
            }
        }
        Ok(())
    }
    let mut out = Snapshot::default();
    walk(root, root, rules, &mut out, &mut 0, &mut 0)?;
    Ok(out)
}

#[derive(Debug, PartialEq, Eq)]
pub enum Inverse {
    File(Option<File>),
    Conflict,
}

/// before = dirty user baseline; after = selected agent postimage; current =
/// latest observation. A clean text merge does not prove semantic independence.
pub fn inverse(
    before: Option<&File>,
    after: Option<&File>,
    current: Option<&File>,
) -> io::Result<Inverse> {
    if before == after || current == before {
        return Ok(Inverse::File(current.cloned()));
    }
    if current == after {
        return Ok(Inverse::File(before.cloned()));
    }
    let (Some(before), Some(after), Some(current)) = (before, after, current) else {
        // Modified creations, occupied deletions and type/absence collisions.
        return Ok(Inverse::Conflict);
    };
    if [&before.bytes, &after.bytes, &current.bytes]
        .iter()
        .any(|bytes| bytes.contains(&0) || std::str::from_utf8(bytes).is_err())
    {
        return Ok(Inverse::Conflict);
    }
    let bytes = if before.bytes == after.bytes {
        current.bytes.clone()
    } else if current.bytes == after.bytes {
        before.bytes.clone()
    } else {
        // Standalone three-way file merge: never run checkout, filters, hooks,
        // apply, reset or any Git operation against the source workspace.
        let scratch = tempfile::tempdir()?;
        for (name, file) in [("before", before), ("after", after), ("current", current)] {
            fs::write(scratch.path().join(name), &file.bytes)?;
        }
        let result = Command::new("git")
            .current_dir(scratch.path())
            .args([
                "merge-file",
                "--stdout",
                "--diff3",
                "--",
                "current",
                "after",
                "before",
            ])
            .output()?;
        match result.status.code() {
            Some(0) => result.stdout,
            Some(1..=127) => return Ok(Inverse::Conflict),
            _ => return Err(fail("three-way merge failed")),
        }
    };
    let executable = if current.executable == after.executable {
        before.executable
    } else {
        current.executable
    };
    Ok(Inverse::File(Some(File { bytes, executable })))
}

pub struct Evidence<'a> {
    pub before: &'a Snapshot,
    pub after: &'a Snapshot,
    /// Supplied by the fixture, NOT inferred from timestamps, diffs or leases.
    pub verified: BTreeSet<PathBuf>,
    pub writers_quiescent: bool,
}

pub struct Prepared {
    pub destination: TempDir,
    pub conflicts: BTreeSet<PathBuf>,
    pub review: BTreeSet<PathBuf>,
    pub copied_bytes: u64,
    pub stale: bool,
}

/// Disposable in-memory prototype; never creates a persistent recovery job or
/// authorized continuation. The hook deterministically models an external
/// writer after copy, or a preparation failure. There is no source write API.
pub fn prepare(
    source: &Path,
    staging: &Path,
    rules: &Rules,
    evidence: Evidence<'_>,
    copy_budget: u64,
    after_copy: impl FnOnce(&Path) -> io::Result<()>,
) -> io::Result<Prepared> {
    if !evidence.writers_quiescent {
        return Err(fail("writer group is not quiescent"));
    }
    let identity = root_identity(source)?;
    if staging.canonicalize()?.starts_with(&identity.0) {
        return Err(fail("destination must be outside source"));
    }
    let current = snapshot(source, rules)?;
    let mut files = current.files.clone();
    let mut conflicts = BTreeSet::new();
    let mut review = current.excluded.clone();
    review.extend(evidence.before.excluded.iter().cloned());
    review.extend(evidence.after.excluded.iter().cloned());
    let paths: BTreeSet<_> = evidence
        .before
        .files
        .keys()
        .chain(evidence.after.files.keys())
        .collect();
    for path in paths {
        let before = evidence.before.files.get(path);
        let after = evidence.after.files.get(path);
        if before == after {
            continue;
        }
        if !evidence.verified.contains(path) {
            review.insert(path.clone());
            continue;
        }
        // An excluded path is not evidence of deletion. Ancestor exclusions
        // cover symlink/directory collisions and changes in deny-read policy.
        if review.iter().any(|excluded| path.starts_with(excluded)) {
            review.insert(path.clone());
            continue;
        }
        if current.directories.contains(path)
            || path
                .ancestors()
                .skip(1)
                .any(|parent| current.files.contains_key(parent))
        {
            conflicts.insert(path.clone());
            continue;
        }
        match inverse(before, after, current.files.get(path))? {
            Inverse::Conflict => {
                conflicts.insert(path.clone());
            }
            Inverse::File(Some(file)) => {
                files.insert(path.clone(), file);
            }
            Inverse::File(None) => {
                files.remove(path);
            }
        }
    }
    let copied_bytes = files.values().map(|file| file.bytes.len() as u64).sum();
    if copied_bytes > copy_budget {
        return Err(fail("recovery copy budget exceeded"));
    }
    // Every destination file is independently allocated; no hard links, .git
    // shared metadata, source permissions or setuid/setgid bits are copied.
    let destination = tempfile::Builder::new()
        .prefix("checkpoint-spike-")
        .tempdir_in(staging)?;
    for path in &current.directories {
        fs::create_dir_all(destination.path().join(path))?;
    }
    for (path, file) in files {
        let target = destination.path().join(path);
        fs::create_dir_all(target.parent().unwrap())?;
        fs::write(&target, file.bytes)?;
        fs::set_permissions(
            target,
            fs::Permissions::from_mode(if file.executable { 0o700 } else { 0o600 }),
        )?;
    }
    after_copy(destination.path())?;
    let stale = root_identity(source)? != identity || snapshot(source, rules)? != current;
    Ok(Prepared {
        destination,
        conflicts,
        review,
        copied_bytes,
        stale,
    })
}
