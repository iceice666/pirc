//! Synchronized append-only journals. Recovery and compatibility fencing occur at open.
//! The same descriptor-based writer is used by standalone agents and node persistence.
use nix::errno::Errno;
use nix::fcntl::{Flock, FlockArg, OFlag, openat};
use nix::sys::stat::{Mode, mkdirat};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::unix::fs::MetadataExt;
use std::path::Path;

pub const MAX_BYTES: u64 = 64 * 1024 * 1024;
pub fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn open(parent: &File, name: &str, flags: OFlag) -> Result<File, String> {
    openat(
        parent,
        name,
        flags | OFlag::O_CLOEXEC | OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK,
        Mode::from_bits_truncate(0o600),
    )
    .map(File::from)
    .map_err(|e| format!("journal_io:{e:?}"))
}
fn identity(file: &File) -> Result<(u64, u64), String> {
    let m = file.metadata().map_err(|_| "journal_metadata")?;
    Ok((m.dev(), m.ino()))
}
#[cfg(test)]
thread_local! {static FAIL_DIRECTORY_SYNC:std::cell::Cell<bool>=const {std::cell::Cell::new(false)};}
fn sync_dir(parent: &File) -> Result<(), String> {
    #[cfg(test)]
    if FAIL_DIRECTORY_SYNC.replace(false) {
        return Err("journal_directory_sync_failed".into());
    }

    parent
        .sync_all()
        .map_err(|_| "journal_directory_sync_failed".into())
}
fn lock(file: File) -> Result<Flock<File>, String> {
    let metadata = file.metadata().map_err(|_| "writer_lock_unavailable")?;
    if !metadata.is_file()
        || metadata.nlink() != 1
        || metadata.uid() != nix::unistd::geteuid().as_raw()
        || metadata.mode() & 0o022 != 0
    {
        return Err("writer_lock_unavailable".into());
    }
    let mut file = file;
    for attempt in 0..3 {
        match Flock::lock(file, FlockArg::LockExclusiveNonblock) {
            Ok(guard) => return Ok(guard),
            Err((returned, error)) => {
                file = returned;
                match error {
                    Errno::EAGAIN => return Err("writer_busy".into()),
                    Errno::EINTR if attempt < 2 => continue,
                    Errno::ENOSYS | Errno::EOPNOTSUPP => {
                        return Err(format!("writer_lock_unsupported:{error}"));
                    }
                    _ => return Err(format!("writer_lock_unavailable:{error}")),
                }
            }
        }
    }
    Err("writer_lock_unavailable:EINTR".into())
}
fn legacy(parent: &File, name: &str, allow_directory: bool) -> Result<(), String> {
    let file = match open(parent, name, OFlag::O_RDONLY) {
        Ok(f) => f,
        Err(e) if e.ends_with("ENOENT") => return Ok(()),
        Err(_) => return Err("writer_lock_unavailable".into()),
    };
    if file
        .metadata()
        .map_err(|_| "writer_lock_unavailable")?
        .is_dir()
    {
        if !allow_directory {
            return Err("writer_lock_unavailable".into());
        }
        let mut dir = nix::dir::Dir::from_fd(file.into()).map_err(|_| "writer_lock_unavailable")?;
        for entry in dir.iter() {
            let entry = entry.map_err(|_| "writer_lock_unavailable")?;
            if !matches!(entry.file_name().to_bytes(), b"." | b"..") {
                return Err("writer_lock_unavailable".into());
            }
        }
        return Ok(());
    }
    let mut text = String::new();
    file.take(4096)
        .read_to_string(&mut text)
        .map_err(|_| "writer_lock_unavailable")?;
    let value: Value = serde_json::from_str(&text).map_err(|_| "writer_lock_unavailable")?;
    let pid = value
        .get("pid")
        .and_then(Value::as_i64)
        .and_then(|p| i32::try_from(p).ok())
        .filter(|p| *p > 0)
        .ok_or("writer_lock_unavailable")?;
    match nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None) {
        Ok(()) | Err(Errno::EPERM) => Err("writer_busy".into()),
        Err(Errno::ESRCH) => Err("writer_cold_cutover_required".into()),
        _ => Err("writer_lock_unavailable".into()),
    }
}
/// A parsed prefix plus exact byte boundary; a read never repairs an incomplete tail.
pub struct Prefix {
    pub values: Vec<Value>,
    pub valid_bytes: usize,
    pub incomplete: bool,
    pub needs_newline: bool,
}
pub fn parse(raw: &[u8]) -> Result<Prefix, String> {
    if raw.len() as u64 > MAX_BYTES {
        return Err("journal_capacity".into());
    }
    let mut values = Vec::new();
    let mut offset = 0;
    for line in raw.split_inclusive(|b| *b == b'\n') {
        let complete = line.ends_with(b"\n");
        let text = match std::str::from_utf8(line) {
            Ok(s) => s,
            Err(e) if !complete && e.error_len().is_none() => {
                return Ok(Prefix {
                    values,
                    valid_bytes: offset,
                    incomplete: true,
                    needs_newline: false,
                });
            }
            Err(_) => return Err("invalid_utf8".into()),
        };
        if !text.trim().is_empty() {
            match serde_json::from_str(text) {
                Ok(value) => values.push(value),
                Err(_) if !complete => {
                    return Ok(Prefix {
                        values,
                        valid_bytes: offset,
                        incomplete: true,
                        needs_newline: false,
                    });
                }
                Err(_) => return Err("invalid_journal_jsonl".into()),
            }
        }
        offset += line.len();
    }
    Ok(Prefix {
        values,
        valid_bytes: offset,
        incomplete: false,
        needs_newline: !raw.is_empty() && !raw.ends_with(b"\n"),
    })
}
pub fn read(parent: &File, name: &str) -> Result<Vec<u8>, String> {
    let mut file = match open(parent, name, OFlag::O_RDONLY) {
        Ok(f) => f,
        Err(e) if e.ends_with("ENOENT") => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let metadata = file.metadata().map_err(|_| "journal_metadata")?;
    if !metadata.is_file()
        || metadata.nlink() != 1
        || metadata.uid() != nix::unistd::geteuid().as_raw()
    {
        return Err("unsafe_journal_path".into());
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "journal_read")?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("journal_capacity".into());
    }
    Ok(bytes)
}
pub struct Journal {
    parent: File,
    name: String,
    mutex: File,
    fence: File,
}
impl Journal {
    pub fn at_path(
        path: &Path,
        validate: impl Fn(&[Value]) -> Result<(), String>,
    ) -> Result<Self, String> {
        Self::at_path_mode(path, validate, true)
    }
    /// Open for a checked append without silently repairing someone else's tail.
    /// Repair remains a separate, explicitly authorized writer-open operation.
    pub fn at_path_without_repair(
        path: &Path,
        validate: impl Fn(&[Value]) -> Result<(), String>,
    ) -> Result<Self, String> {
        Self::at_path_mode(path, validate, false)
    }
    fn at_path_mode(
        path: &Path,
        validate: impl Fn(&[Value]) -> Result<(), String>,
        repair: bool,
    ) -> Result<Self, String> {
        use std::os::unix::fs::OpenOptionsExt;
        let parent = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(nix::libc::O_DIRECTORY | nix::libc::O_NOFOLLOW)
            .open(path.parent().ok_or("unsafe_journal_path")?)
            .map_err(|_| "unsafe_journal_path")?;
        Self::open_mode(
            parent,
            path.file_name()
                .and_then(|n| n.to_str())
                .ok_or("unsafe_journal_path")?,
            validate,
            repair,
        )
    }
    pub fn open(
        parent: File,
        name: &str,
        validate: impl Fn(&[Value]) -> Result<(), String>,
    ) -> Result<Self, String> {
        Self::open_mode(parent, name, validate, true)
    }
    fn open_mode(
        parent: File,
        name: &str,
        validate: impl Fn(&[Value]) -> Result<(), String>,
        repair: bool,
    ) -> Result<Self, String> {
        if name.contains('/') || name == "." || name == ".." || name.is_empty() {
            return Err("unsafe_journal_path".into());
        }
        let mutex_name = format!("{name}.writer-mutex");
        let guard = lock(open(&parent, &mutex_name, OFlag::O_RDWR | OFlag::O_CREAT)?)?;
        let mutex = guard.try_clone().map_err(|_| "writer_lock_unavailable")?;
        let fence_name = format!("{name}.writer-lock");
        legacy(&parent, &format!("{fence_name}.recovery"), false)?;
        match mkdirat(
            &parent,
            fence_name.as_str(),
            Mode::from_bits_truncate(0o700),
        ) {
            Ok(()) | Err(Errno::EEXIST) => {}
            Err(_) => return Err("writer_lock_unavailable".into()),
        }
        legacy(&parent, &fence_name, true)?;
        let fence_file = open(&parent, &fence_name, OFlag::O_RDONLY | OFlag::O_DIRECTORY)?;
        let fence = fence_file;
        legacy(&parent, &format!("{fence_name}.recovery"), false)?;
        let raw = read(&parent, name)?;
        let parsed = parse(&raw)?;
        if !repair && (parsed.incomplete || parsed.needs_newline) {
            return Err("journal_repair_required".into());
        }
        validate(&parsed.values)?;
        if parsed.incomplete {
            let evidence = format!("{name}.incomplete-{}", crate::random_hex(8));
            let mut backup = open(
                &parent,
                &evidence,
                OFlag::O_WRONLY | OFlag::O_CREAT | OFlag::O_EXCL,
            )?;
            backup
                .write_all(&raw[parsed.valid_bytes..])
                .and_then(|()| backup.sync_all())
                .map_err(|_| "journal_evidence_sync_failed")?;
            sync_dir(&parent)?;
        }
        if !raw.is_empty() {
            let mut file = open(&parent, name, OFlag::O_RDWR)?;
            if parsed.incomplete {
                file.set_len(parsed.valid_bytes as u64)
                    .map_err(|_| "journal_repair_failed")?;
            } else if parsed.needs_newline {
                file.seek(SeekFrom::End(0))
                    .and_then(|_| file.write_all(b"\n"))
                    .map_err(|_| "journal_repair_failed")?;
            }
            file.sync_all().map_err(|_| "journal_sync_failed")?;
        }
        sync_dir(&parent)?;
        drop(guard);
        Ok(Self {
            parent,
            name: name.into(),
            mutex,
            fence,
        })
    }
    pub fn transaction<T>(
        &self,
        work: impl FnOnce(&[u8]) -> Result<(T, Vec<u8>), String>,
    ) -> Result<T, String> {
        let guard = lock(open(
            &self.parent,
            &format!("{}.writer-mutex", self.name),
            OFlag::O_RDWR,
        )?)?;
        if identity(&guard)? != identity(&self.mutex)?
            || identity(&open(
                &self.parent,
                &format!("{}.writer-lock", self.name),
                OFlag::O_RDONLY | OFlag::O_DIRECTORY,
            )?)? != identity(&self.fence)?
        {
            return Err("writer_identity_changed_reopen".into());
        }
        let raw = read(&self.parent, &self.name)?;
        let (result, delta) = work(&raw)?;
        if !delta.is_empty() {
            if raw.len() + delta.len() > MAX_BYTES as usize {
                return Err("journal_capacity".into());
            }
            let mut file = open(
                &self.parent,
                &self.name,
                OFlag::O_WRONLY | OFlag::O_APPEND | OFlag::O_CREAT,
            )?;
            file.write_all(&delta)
                .and_then(|()| file.sync_all())
                .map_err(|_| "commit_outcome_unknown_reopen")?;
            sync_dir(&self.parent).map_err(|_| "commit_outcome_unknown_reopen")?;
        } else if !raw.is_empty() {
            open(&self.parent, &self.name, OFlag::O_RDONLY)?
                .sync_all()
                .map_err(|_| "journal_sync_failed")?;
            sync_dir(&self.parent)?;
        }
        Ok(result)
    }
    pub fn snapshot(&self) -> Result<Vec<u8>, String> {
        self.transaction(|raw| Ok((raw.to_vec(), Vec::new())))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recovery_preserves_evidence_and_rejects_middle_corruption() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("session.jsonl");
        std::fs::write(&p, b"{\"a\":1}\n{\"torn\":").unwrap();
        let j = Journal::at_path(&p, |_| Ok(())).unwrap();
        assert_eq!(j.snapshot().unwrap(), b"{\"a\":1}\n");
        assert!(std::fs::read_dir(d.path()).unwrap().any(|e| {
            e.unwrap()
                .file_name()
                .to_string_lossy()
                .contains("incomplete-")
        }));
        std::fs::write(&p, b"{\"a\":1}\ninvalid\n{}").unwrap();
        assert!(Journal::at_path(&p, |_| Ok(())).is_err());
    }
    #[test]
    fn transaction_cas_and_identity_checks() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("s.jsonl");
        let j = Journal::at_path(&p, |_| Ok(())).unwrap();
        j.transaction(|raw| {
            assert!(raw.is_empty());
            Ok(((), b"{}\n".to_vec()))
        })
        .unwrap();
        std::fs::remove_file(d.path().join("s.jsonl.writer-mutex")).unwrap();
        assert!(j.snapshot().is_err());
    }
}

#[cfg(test)]
mod recovery_fault_tests {
    use super::*;
    #[test]
    fn directory_sync_failure_keeps_outcome_unknown_until_synchronized_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("journal.jsonl");
        let writer = Journal::at_path(&path, |_| Ok(())).unwrap();
        FAIL_DIRECTORY_SYNC.set(true);
        let result = writer.transaction(|_| Ok(((), b"{\"value\":1}\n".to_vec())));
        assert_eq!(result.unwrap_err(), "commit_outcome_unknown_reopen");
        let recovered = Journal::at_path(&path, |_| Ok(())).unwrap();
        assert_eq!(recovered.snapshot().unwrap(), b"{\"value\":1}\n");
    }
    #[test]
    fn old_pid_locks_are_never_automatically_stolen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("journal.jsonl");
        std::fs::write(
            dir.path().join("journal.jsonl.writer-lock"),
            format!("{{\"pid\":{}}}", std::process::id()),
        )
        .unwrap();
        assert_eq!(
            Journal::at_path(&path, |_| Ok(())).err().unwrap(),
            "writer_busy"
        );
        assert!(dir.path().join("journal.jsonl.writer-lock").is_file());
    }
}

#[cfg(test)]
mod lock_path_tests {
    use super::*;
    #[test]
    fn independent_descriptors_exclude_concurrent_opens_and_transactions() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        let writer = Journal::at_path(&path, |_| Ok(())).unwrap();
        let held =
            lock(open(&writer.parent, "s.jsonl.writer-mutex", OFlag::O_RDWR).unwrap()).unwrap();
        assert_eq!(writer.snapshot().unwrap_err(), "writer_busy");
        assert_eq!(
            Journal::at_path(&path, |_| Ok(())).err().unwrap(),
            "writer_busy"
        );
        drop(held);
        writer.transaction(|_| Ok(((), b"{}\n".to_vec()))).unwrap();
        assert_eq!(writer.snapshot().unwrap(), b"{}\n");
    }
    #[test]
    fn hardlinked_mutex_is_refused_without_touching_its_target() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.jsonl");
        let target = dir.path().join("other");
        std::fs::write(&target, "keep").unwrap();
        std::fs::hard_link(&target, dir.path().join("session.jsonl.writer-mutex")).unwrap();
        assert_eq!(
            Journal::at_path(&path, |_| Ok(())).err().unwrap(),
            "writer_lock_unavailable"
        );
        assert_eq!(std::fs::read_to_string(target).unwrap(), "keep");
    }
}
