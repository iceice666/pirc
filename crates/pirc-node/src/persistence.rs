//! Scoped agent persistence. Tools see state read-only; only the agent's private
//! configure channel carries this lease. All filesystem changes happen here.
use base64::Engine;
use pirc_protocol::InferenceConfig;
use rustix::fs::{AtFlags, Mode, OFlags, mkdirat, openat, renameat, unlinkat};
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use std::fs::File;
use std::io::{self, Write};
use std::os::unix::fs::MetadataExt;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};

#[derive(Default)]
pub struct Writes(Mutex<HashMap<String, Arc<Scope>>>);
struct Scope {
    spelled: PathBuf,
    root: File,
    ledger: Option<(PathBuf, File)>,
    serial: Mutex<HashMap<String, pirc_agent::journal::Journal>>,
}
pub struct Lease {
    pub config: InferenceConfig,
    writes: Weak<Writes>,
}
impl Lease {
    pub fn close(&self) {
        if let Some(w) = self.writes.upgrade() {
            let scope =
                w.0.lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(&self.config.token);
            // Drain writes admitted before revocation; replacement cannot overtake them.
            if let Some(scope) = scope {
                drop(scope.serial.lock().unwrap_or_else(|e| e.into_inner()));
            }
        }
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        self.close();
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    op: String,
    path: String,
    #[serde(default)]
    to: Option<String>,
    #[serde(default)]
    data: String,
}
fn refused() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "Persistence request refused",
    )
}
fn check(file: &File, directory: bool) -> io::Result<()> {
    let m = file.metadata()?;
    if m.uid() != nix::unistd::getuid().as_raw()
        || m.mode() & 0o022 != 0
        || if directory {
            !m.is_dir()
        } else {
            !m.is_file() || m.nlink() != 1
        }
    {
        return Err(refused());
    }
    Ok(())
}
impl Writes {
    pub fn register(
        self: &Arc<Self>,
        socket: &str,
        root: &Path,
        ledger: Option<&Path>,
    ) -> io::Result<Lease> {
        let fd = File::from(rustix::fs::open(
            root,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )?);
        check(&fd, true)?;
        let ledger = ledger
            .map(|path| -> io::Result<_> {
                let file = File::from(rustix::fs::open(
                    path,
                    OFlags::WRONLY
                        | OFlags::APPEND
                        | OFlags::NOFOLLOW
                        | OFlags::NONBLOCK
                        | OFlags::CLOEXEC,
                    Mode::empty(),
                )?);
                check(&file, false)?;
                Ok((path.to_path_buf(), file))
            })
            .transpose()?;
        let token = crate::util::hex(&crate::util::random_bytes::<32>());
        self.0.lock().unwrap_or_else(|e| e.into_inner()).insert(
            token.clone(),
            Arc::new(Scope {
                spelled: root.to_path_buf(),
                root: fd,
                ledger,
                serial: Mutex::new(HashMap::new()),
            }),
        );
        Ok(Lease {
            config: InferenceConfig {
                socket_path: socket.to_owned(),
                token,
            },
            writes: Arc::downgrade(self),
        })
    }
    pub fn authorized(&self, token: &str) -> bool {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains_key(token)
    }
    pub fn apply(&self, token: &str, body: Value) -> io::Result<()> {
        self.apply_response(token, body).map(|_| ())
    }
    pub fn apply_response(&self, token: &str, body: Value) -> io::Result<Value> {
        let scope = self
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(token)
            .cloned()
            .ok_or_else(refused)?;
        let request: Request = serde_json::from_value(body).map_err(|_| refused())?;
        let mut serial = scope.serial.lock().unwrap_or_else(|e| e.into_inner());
        if !self.authorized(token) {
            return Err(refused());
        }
        let snapshot = matches!(request.op.as_str(), "session_open" | "session_snapshot");
        let path = request.path.clone();
        scope.apply(request, &mut serial)?;
        if snapshot {
            let bytes = serial
                .get(&path)
                .ok_or_else(refused)?
                .snapshot()
                .map_err(io::Error::other)?;
            Ok(serde_json::json!({"ok":true,"hash":pirc_agent::journal::digest(&bytes)}))
        } else {
            Ok(serde_json::json!({"ok":true}))
        }
    }
}
impl Scope {
    fn parent(&self, path: &Path) -> io::Result<(File, String)> {
        let rel = path.strip_prefix(&self.spelled).map_err(|_| refused())?;
        let mut parts = Vec::new();
        for c in rel.components() {
            match c {
                Component::Normal(p) => parts.push(p.to_str().ok_or_else(refused)?.to_owned()),
                _ => return Err(refused()),
            }
        }
        let leaf = parts.pop().ok_or_else(refused)?;
        let mut parent = self.root.try_clone()?;
        for part in parts {
            parent = File::from(openat(
                &parent,
                part.as_str(),
                OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::empty(),
            )?);
            check(&parent, true)?;
        }
        Ok((parent, leaf))
    }
    fn apply(
        &self,
        r: Request,
        journals: &mut HashMap<String, pirc_agent::journal::Journal>,
    ) -> io::Result<()> {
        let path = Path::new(&r.path);
        let ledger = self.ledger.as_ref().is_some_and(|(p, _)| p == path);
        if ledger {
            return Err(refused());
        }
        if matches!(
            r.op.as_str(),
            "session_open" | "session_append" | "session_snapshot"
        ) {
            if ledger
                || path
                    .file_name()
                    .and_then(|s| s.to_str())
                    .is_none_or(|name| !name.ends_with(".jsonl") && !name.ends_with(".tmp"))
            {
                return Err(refused());
            }
            if r.op == "session_snapshot" {
                return if journals.contains_key(&r.path) {
                    Ok(())
                } else {
                    Err(refused())
                };
            }
            if r.op == "session_open" {
                let (parent, name) = self.parent(path)?;
                let writer = pirc_agent::journal::Journal::open(
                    parent,
                    &name,
                    pirc_agent::session_store::validate_values,
                )
                .map_err(io::Error::other)?;
                journals.insert(r.path, writer);
                return Ok(());
            }
            let writer = journals.get(&r.path).ok_or_else(refused)?;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(r.data)
                .map_err(|_| refused())?;
            if bytes.len() > 6 * 1024 * 1024 {
                return Err(refused());
            }
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Append {
                expected: String,
                entry: Value,
            }
            let append: Append = serde_json::from_slice(&bytes).map_err(|_| refused())?;
            return writer
                .transaction(|raw| {
                    if pirc_agent::journal::digest(raw) != append.expected {
                        return Err("writer_stale_reopen".into());
                    }
                    let mut line =
                        serde_json::to_vec(&append.entry).map_err(|_| "invalid_session_entry")?;
                    line.push(b'\n');
                    let mut next = raw.to_vec();
                    next.extend_from_slice(&line);
                    pirc_agent::session_store::validate_values(
                        &pirc_agent::journal::parse(&next)?.values,
                    )?;
                    Ok(((), line))
                })
                .map_err(io::Error::other);
        }
        if r.op == "mkdir" {
            let rel = path.strip_prefix(&self.spelled).map_err(|_| refused())?;
            let mut parent = self.root.try_clone()?;
            for c in rel.components() {
                let Component::Normal(part) = c else {
                    return Err(refused());
                };
                match mkdirat(&parent, part, Mode::from_raw_mode(0o700)) {
                    Ok(()) | Err(rustix::io::Errno::EXIST) => {}
                    Err(e) => return Err(e.into()),
                }
                parent = File::from(openat(
                    &parent,
                    part,
                    OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                    Mode::empty(),
                )?);
                check(&parent, true)?;
            }
            return Ok(());
        }
        if matches!(r.op.as_str(), "write" | "create" | "append") {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(r.data)
                .map_err(|_| refused())?;
            if bytes.len() > 256 * 1024 {
                return Err(refused());
            }
            let flags = OFlags::WRONLY
                | OFlags::CREATE
                | OFlags::NOFOLLOW
                | OFlags::NONBLOCK
                | OFlags::CLOEXEC
                | if r.op == "append" {
                    OFlags::APPEND
                } else if r.op == "create" {
                    OFlags::EXCL
                } else {
                    OFlags::empty()
                };
            let mut file = if ledger {
                self.ledger.as_ref().unwrap().1.try_clone()?
            } else {
                let (parent, leaf) = self.parent(path)?;
                File::from(openat(
                    &parent,
                    leaf.as_str(),
                    flags,
                    Mode::from_raw_mode(0o600),
                )?)
            };
            check(&file, false)?;
            if r.op == "write" {
                file.set_len(0)?;
            }
            file.write_all(&bytes)?;
            return Ok(());
        }
        let (parent, leaf) = self.parent(path)?;
        if r.op == "mkdir_new" {
            return mkdirat(parent, leaf.as_str(), Mode::from_raw_mode(0o700)).map_err(Into::into);
        }
        if r.op == "remove" {
            return unlinkat(parent, leaf.as_str(), AtFlags::empty()).map_err(Into::into);
        }
        if r.op == "rename" {
            let to = r.to.ok_or_else(refused)?;
            let (dest, name) = self.parent(Path::new(&to))?;
            // Neither endpoint may be a symlink or a multiply linked file.
            let source = File::from(openat(
                &parent,
                leaf.as_str(),
                OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
                Mode::empty(),
            )?);
            check(&source, false)?;
            source.sync_all()?;
            match openat(
                &dest,
                name.as_str(),
                OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
                Mode::empty(),
            ) {
                Ok(fd) => check(&File::from(fd), false)?,
                Err(rustix::io::Errno::NOENT) => {}
                Err(e) => return Err(e.into()),
            }
            return renameat(&parent, leaf.as_str(), dest, name.as_str()).map_err(Into::into);
        }
        Err(refused())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::os::unix::fs::{PermissionsExt, symlink};
    fn body(op: &str, path: &Path, data: &str) -> Value {
        json!({"op":op,"path":path,"data":base64::engine::general_purpose::STANDARD.encode(data)})
    }
    #[test]
    fn scopes_state_writes_and_revokes_tokens() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("session");
        std::fs::create_dir(&root).unwrap();
        let ledger = dir.path().join("memory.jsonl");
        std::fs::write(&ledger, "").unwrap();
        let writes = Arc::new(Writes::default());
        let lease = writes
            .register("/fake/socket", &root, Some(&ledger))
            .unwrap();
        let token = &lease.config.token;
        writes
            .apply(token, body("mkdir", &root.join("team/worker"), ""))
            .unwrap();
        let journal = root.join("session.jsonl");
        writes
            .apply(token, body("append", &journal, "first\n"))
            .unwrap();
        writes
            .apply(token, body("append", &journal, "second\n"))
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(&journal).unwrap(),
            "first\nsecond\n"
        );
        assert!(
            writes
                .apply(token, body("append", &ledger, "memory\n"))
                .is_err()
        );
        assert!(
            writes
                .apply(token, body("write", &ledger, "poison"))
                .is_err()
        );
        assert!(
            writes
                .apply(token, body("write", &dir.path().join("outside"), "bad"))
                .is_err()
        );
        assert!(
            writes
                .apply(token, body("write", &root.join("../outside"), "bad"))
                .is_err()
        );
        assert!(
            writes
                .apply("wrong-token", body("append", &journal, "bad"))
                .is_err()
        );
        assert_eq!(
            journal.metadata().unwrap().permissions().mode() & 0o777,
            0o600
        );
        lease.close();
        assert!(
            writes
                .apply(token, body("append", &journal, "revoked"))
                .is_err()
        );
    }
    #[test]
    fn refuses_linked_files_and_parent_redirects_before_truncation() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("session");
        std::fs::create_dir(&root).unwrap();
        let victim = dir.path().join("victim");
        std::fs::write(&victim, "untouched").unwrap();
        let writes = Arc::new(Writes::default());
        let lease = writes.register("/fake/socket", &root, None).unwrap();
        for kind in ["symlink", "hardlink", "parent"] {
            let file = root.join(kind);
            if kind == "symlink" {
                symlink(&victim, &file).unwrap();
            } else if kind == "hardlink" {
                std::fs::hard_link(&victim, &file).unwrap();
            } else {
                symlink(dir.path(), &file).unwrap();
            }
            let file = if kind == "parent" {
                file.join("victim")
            } else {
                file
            };
            assert!(
                writes
                    .apply(&lease.config.token, body("write", &file, "corrupt"))
                    .is_err()
            );
            assert_eq!(std::fs::read_to_string(&victim).unwrap(), "untouched");
        }
    }
}
