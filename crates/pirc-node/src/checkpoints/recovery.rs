//! Trusted-node preparation API, deliberately NOT a gateway or agent RPC.
//! V1 requests require a preview revision; V2 private journal retains all inputs.
pub use super::snapshot::CopyLimits;
use super::snapshot::{Content, Snapshot};
use super::{
    FileVersion, Journal, Operation, Result, Scope, digest, err, files, inverse, snapshot,
};
use crate::panels::inspect::{ChildEnv, checkpoint_files};
use crate::sandbox::Sandbox;
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, DirBuilder};
use std::os::unix::fs::DirBuilderExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub const PROTOCOL_VERSION: u32 = 1;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Selection {
    /// Node-issued operations from a single closed run. Duplicate paths refused.
    pub operations: Vec<String>,
    /// Explicit review of observed evidence. False preserves current bytes.
    pub review_observational: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PrepareRequest {
    pub version: u32,
    pub key: String,
    pub preview_revision: String,
    pub selection: Selection,
}
#[derive(Debug, Serialize)]
pub struct Preview {
    pub version: u32,
    pub revision: String,
    pub copied_bytes: u64,
    pub exclusions: BTreeMap<String, String>,
    pub coverage: &'static str,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PathResult {
    pub path: String,
    pub status: String,
    pub before: FileVersion,
    pub after: FileVersion,
    pub current: FileVersion,
    pub candidate: FileVersion,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Manifest {
    pub source_revision: String,
    pub binding: String,
    pub selection: Selection,
    pub paths: Vec<PathResult>,
    pub exclusions: BTreeMap<String, String>,
    pub copied_bytes: u64,
    pub coverage: String,
    pub output_revision: Option<String>,
    pub output_device: u64,
    pub output_inode: u64,
    pub limits: CopyLimits,
}
#[derive(Debug, Serialize)]
pub struct Job {
    pub id: String,
    pub state: String,
    pub revision: i64,
    pub reserved_bytes: u64,
    pub manifest: Manifest,
    /// Not an executable/authorized workspace until explicitly claimed.
    pub output: Option<PathBuf>,
}
/// Source workspaces supply observations, not a multi-file atomic snapshot.
const COVERAGE: &str = "observational copy; external writers and semantic dependencies require review; no per-agent attribution";
#[derive(Clone)]
pub struct RecoveryFactory {
    pub(super) journal: Arc<Journal>,
    limits: CopyLimits,
    #[cfg(test)]
    after_copy: Option<Arc<dyn Fn() -> Result<()> + Send + Sync>>,
}
impl RecoveryFactory {
    pub fn new(journal: Arc<Journal>, limits: CopyLimits) -> Result<Self> {
        limits.validate()?;
        Ok(Self {
            journal,
            limits,
            #[cfg(test)]
            after_copy: None,
        })
    }
    pub(super) async fn eligibility(
        &self,
        scope: &Scope,
        sandbox: &dyn Sandbox,
        env: &ChildEnv,
    ) -> Result<Option<BTreeSet<String>>> {
        match fs::symlink_metadata(scope.root.join(".git")) {
            Ok(_) => Ok(Some(
                checkpoint_files(sandbox, &scope.root, env)
                    .await
                    .map_err(|e| err(e.message))?,
            )),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(err(e)),
        }
    }
    pub async fn preview(
        &self,
        scope: Scope,
        selection: Selection,
        sandbox: &dyn Sandbox,
        env: &ChildEnv,
    ) -> Result<Preview> {
        let git = self.eligibility(&scope, sandbox, env).await?;
        let factory = self.clone();
        tokio::task::spawn_blocking(move || {
            let (snapshot, ops) = factory.observe(&scope, &selection, git.as_ref())?;
            Ok(Preview {
                version: PROTOCOL_VERSION,
                revision: revision(&scope, &snapshot, &ops, &selection)?,
                copied_bytes: snapshot.bytes,
                exclusions: snapshot.excluded,
                coverage: COVERAGE,
            })
        })
        .await
        .map_err(err)?
    }
    pub async fn prepare(
        &self,
        scope: Scope,
        request: PrepareRequest,
        sandbox: &dyn Sandbox,
        env: &ChildEnv,
    ) -> Result<Job> {
        validate_request(&request)?;
        // Idempotent repeats must not resample, mutate or overwrite their output.
        let (journal, bound, req) = (self.journal.clone(), scope.clone(), request.clone());
        if let Some(job) =
            tokio::task::spawn_blocking(move || journal.existing_request(&bound, &req))
                .await
                .map_err(err)??
        {
            return self.refresh(scope, job.id, sandbox, env).await;
        }
        let git = self.eligibility(&scope, sandbox, env).await?;
        let (factory, bound, req, first) =
            (self.clone(), scope.clone(), request.clone(), git.clone());
        let job =
            tokio::task::spawn_blocking(move || factory.prepare_copy(&bound, &req, first.as_ref()))
                .await
                .map_err(err)??;
        if job.state == "ready" && self.eligibility(&scope, sandbox, env).await.ok() != Some(git) {
            let journal = self.journal.clone();
            return tokio::task::spawn_blocking(move || {
                journal.set_job_state(&job.id, "stale")?;
                journal.recovery_job(&scope, &job.id)
            })
            .await
            .map_err(err)?;
        }
        Ok(job)
    }
    fn observe(
        &self,
        scope: &Scope,
        selection: &Selection,
        git: Option<&BTreeSet<String>>,
    ) -> Result<(Snapshot, Vec<Operation>)> {
        if self.journal.root.starts_with(&scope.root) {
            return Err(err(
                "checkpoint storage overlaps source; configure private state outside the workspace",
            ));
        }
        if scope.root.starts_with(&self.journal.root) {
            // Previously opened, independent roots can themselves be sources.
            // Never authorize arbitrary private state, nested aliases or blobs.
            let relative = scope
                .root
                .strip_prefix(self.journal.root.join("workspaces"))
                .map_err(|_| err("source is private checkpoint data"))?;
            let parts = relative.components().collect::<Vec<_>>();
            if parts.len() != 2 || parts[1].as_os_str() != "root" {
                return Err(err("source is not an independent recovery root"));
            }
            let id = parts[0]
                .as_os_str()
                .to_str()
                .ok_or_else(|| err("invalid recovery source"))?;
            let json:String=self.journal.lock()?.query_row("SELECT manifest FROM recovery_jobs WHERE id=?1 AND node=?2 AND owner=?3 AND claimed=1",params![id,scope.node,scope.owner],|r|r.get(0)).map_err(|_|err("recovery source ownership unavailable"))?;
            let manifest: Manifest = serde_json::from_str(&json).map_err(err)?;
            if (manifest.output_device, manifest.output_inode) != (scope.device, scope.inode) {
                return Err(err("recovery source identity changed"));
            }
        }
        if selection.operations.len() > 1000 {
            return Err(err("too many selected operations"));
        }
        let mut chosen = Vec::new();
        if !selection.operations.is_empty() {
            let info = self
                .journal
                .info(scope)?
                .ok_or_else(|| err("capture unavailable"))?;
            if info.state == "capturing" {
                return Err(err("run is still capturing"));
            }
            let available = self.journal.operations(scope)?;
            let ids: BTreeSet<_> = selection.operations.iter().collect();
            if ids.len() != selection.operations.len() {
                return Err(err("duplicate operation selection"));
            }
            let mut paths = BTreeSet::new();
            for operation in available {
                if ids.contains(&operation.id) {
                    // Full physical-root binding, never just the session/run strings.
                    self.journal
                        .bound_operation(&*self.journal.lock()?, scope, &operation.id)?;
                    if operation.state != "observed"
                        || operation.after.is_none()
                        || operation.path.is_empty()
                    {
                        return Err(err("selected operation has incomplete coverage"));
                    }
                    files::relative(scope, &scope.root.join(&operation.path))?;
                    if !paths.insert(operation.path.clone()) {
                        return Err(err(
                            "overlapping operations require a coherent range; select one per path",
                        ));
                    }
                    chosen.push(operation);
                }
            }
            if chosen.len() != ids.len() {
                return Err(err("selected operation unavailable for this owner/run"));
            }
        }
        let snapshot = snapshot::scan(scope, &self.limits, self.journal.limits.file_bytes, git)?;
        Ok((snapshot, chosen))
    }
    fn prepare_copy(
        &self,
        scope: &Scope,
        request: &PrepareRequest,
        git: Option<&BTreeSet<String>>,
    ) -> Result<Job> {
        let (source, ops) = self.observe(scope, &request.selection, git)?;
        if revision(scope, &source, &ops, &request.selection)? != request.preview_revision {
            return Err(err("stale recovery preview; refresh before preparing"));
        }
        let binding = binding(scope)?;
        let mut manifest = Manifest {
            source_revision: source.fingerprint.clone(),
            binding,
            selection: request.selection.clone(),
            paths: Vec::new(),
            exclusions: source.excluded.clone(),
            copied_bytes: source.bytes,
            coverage: COVERAGE.into(),
            output_revision: None,
            output_device: 0,
            output_inode: 0,
            limits: self.limits.clone(),
        };
        // Reserve the entire configured copy ceiling, not just the estimate. SQL
        // serialization also prevents another device allocating the same key.
        let id = crate::util::uuid();
        {
            let mut db = self.journal.lock()?;
            let tx = db
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                .map_err(err)?;
            if let Some(id) = existing_id(&tx, scope, request)? {
                drop(tx);
                drop(db);
                return self.journal.recovery_job(scope, &id);
            }
            let used: u64 = tx
                .query_row(
                    "SELECT COALESCE(SUM(reserved),0) FROM recovery_jobs",
                    [],
                    |r| r.get(0),
                )
                .map_err(err)?;
            if used.saturating_add(self.limits.bytes) > self.limits.node_bytes {
                return Err(err("recovery workspace reservation budget exhausted"));
            }
            let space = rustix::fs::statvfs(&self.journal.root).map_err(err)?;
            if (space.f_bavail as u64).saturating_mul(space.f_frsize as u64)
                < self
                    .limits
                    .bytes
                    .saturating_add(used)
                    .saturating_add(self.limits.free_reserve)
            {
                return Err(err("insufficient free space for recovery reservation"));
            }
            tx.execute("INSERT INTO recovery_jobs(id,node,owner,workspace,session,epoch,run,request_key,request_hash,capture,state,reserved,manifest,created) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,'preparing',?11,?12,?13)",params![id,scope.node,scope.owner,scope.workspace,scope.session,scope.epoch,scope.run,request.key,request_hash(scope,request)?,ops.first().map(|o|o.capture.as_str()),self.limits.bytes,serde_json::to_string(&manifest).map_err(err)?,crate::util::now_ms()]).map_err(err)?;
            // Retain exact current evidence before its manifest can refer to it.
            for file in source.files.values() {
                retain(&self.journal, &tx, &id, file)?;
            }
            tx.commit().map_err(err)?;
        }
        let result = (|| -> Result<()> {
            let dir =
                crate::private_dir::open_dir(&self.journal.root, &["workspaces"]).map_err(err)?;
            rustix::fs::mkdirat(&dir, id.as_str(), rustix::fs::Mode::RWXU).map_err(err)?;
            let base = self.journal.root.join("workspaces").join(&id);
            let scratch = base.join("merge");
            DirBuilder::new()
                .mode(0o700)
                .create(&scratch)
                .map_err(err)?;
            let mut files = source.files.clone();
            for (index, operation) in ops.iter().enumerate() {
                let after = operation
                    .after
                    .as_ref()
                    .ok_or_else(|| err("missing postimage"))?;
                let current = files.get(&operation.path).cloned();
                let before_bytes = content(&self.journal, &operation.before)?;
                let after_bytes = content(&self.journal, after)?;
                let blocked = source.excluded.keys().any(|p| overlaps(p, &operation.path))
                    || source.directories.contains(&operation.path)
                    || files
                        .keys()
                        .any(|p| p != &operation.path && overlaps(p, &operation.path));
                let eligible =
                    files::observe(scope, &operation.path, self.journal.limits.file_bytes)?;
                let eligible = !matches!(eligible.version, FileVersion::Excluded { .. })
                    && git.is_none_or(|set| {
                        set.contains(&operation.path) || matches!(after, FileVersion::Absent)
                    });
                let merge_dir = scratch.join(index.to_string());
                DirBuilder::new()
                    .mode(0o700)
                    .create(&merge_dir)
                    .map_err(err)?;
                let status = if blocked
                    || !eligible
                    || matches!(operation.before, FileVersion::Excluded { .. })
                    || matches!(after, FileVersion::Excluded { .. })
                {
                    "excluded"
                } else if !request.selection.review_observational {
                    "review_observational"
                } else {
                    match inverse::inverse(
                        before_bytes.as_ref(),
                        after_bytes.as_ref(),
                        current.as_ref(),
                        &merge_dir,
                        self.journal.limits.file_bytes,
                    )? {
                        inverse::Inverse::Conflict => "conflict",
                        inverse::Inverse::File(candidate) => {
                            if let Some(candidate) = candidate {
                                files.insert(operation.path.clone(), candidate);
                            } else {
                                files.remove(&operation.path);
                            }
                            "inverse_reviewed_observation"
                        }
                    }
                };
                manifest.paths.push(PathResult {
                    path: operation.path.clone(),
                    status: status.into(),
                    before: operation.before.clone(),
                    after: after.clone(),
                    current: version(current.as_ref()),
                    candidate: version(files.get(&operation.path)),
                });
            }
            let bytes: u64 = files.values().map(|f| f.bytes.len() as u64).sum();
            if bytes > self.limits.bytes {
                return Err(err("inverse result exceeds recovery copy reservation"));
            }
            let output = base.join("root");
            DirBuilder::new().mode(0o700).create(&output).map_err(err)?;
            let output_dir = crate::private_dir::open_dir(&base, &["root"]).map_err(err)?;
            // Every output file is newly created in a private tree. No hardlinks,
            // .git sharing, filters, hooks, source renames or overwrites.
            for path in &source.directories {
                make_parent(&output_dir, path, true)?;
            }
            for (path, file) in &files {
                let parent = make_parent(&output_dir, path, false)?;
                let name = Path::new(path)
                    .file_name()
                    .and_then(|s| s.to_str())
                    .ok_or_else(|| err("invalid candidate filename"))?;
                let mut target = std::fs::File::from(
                    rustix::fs::openat(
                        &parent,
                        name,
                        rustix::fs::OFlags::WRONLY
                            | rustix::fs::OFlags::CREATE
                            | rustix::fs::OFlags::EXCL
                            | rustix::fs::OFlags::NOFOLLOW
                            | rustix::fs::OFlags::CLOEXEC,
                        if file.executable {
                            rustix::fs::Mode::RWXU
                        } else {
                            rustix::fs::Mode::RUSR | rustix::fs::Mode::WUSR
                        },
                    )
                    .map_err(err)?,
                );
                std::io::Write::write_all(&mut target, &file.bytes)
                    .and_then(|()| target.sync_all())
                    .map_err(err)?;
                rustix::fs::fsync(&parent).map_err(err)?;
            }
            let mut directories = source.directories.clone();
            for path in files.keys() {
                let mut parent = Path::new(path).parent();
                while let Some(path) = parent {
                    if !path.as_os_str().is_empty() {
                        directories.insert(path.to_string_lossy().into_owned());
                    }
                    parent = path.parent();
                }
            }
            for path in directories.iter().rev() {
                inverse::sync_dir(&output.join(path))?;
            }
            inverse::sync_dir(&output)?;
            inverse::sync_dir(&base)?;
            inverse::sync_dir(&self.journal.root.join("workspaces"))?;
            inverse::sync_dir(&self.journal.root)?;
            #[cfg(test)]
            if let Some(hook) = &self.after_copy {
                hook()?;
            }
            let output_scope = output_scope(scope, &output)?;
            let output_snapshot = snapshot::scan(
                &output_scope,
                &self.limits,
                self.journal.limits.file_bytes,
                None,
            )?;
            manifest.output_revision = Some(output_snapshot.fingerprint);
            manifest.output_device = output_scope.device;
            manifest.output_inode = output_scope.inode;
            manifest.copied_bytes = bytes;
            {
                let mut db = self.journal.lock()?;
                let tx = db.transaction().map_err(err)?;
                for file in files.values() {
                    retain(&self.journal, &tx, &id, file)?;
                }
                tx.execute(
                    "UPDATE recovery_jobs SET manifest=?2 WHERE id=?1 AND state='preparing'",
                    params![id, serde_json::to_string(&manifest).map_err(err)?],
                )
                .map_err(err)?;
                tx.commit().map_err(err)?;
            }
            // A changed root, tree or policy is stale, never a clean result.
            let state =
                match snapshot::scan(scope, &self.limits, self.journal.limits.file_bytes, git) {
                    Ok(latest) if latest.fingerprint == source.fingerprint => "ready",
                    _ => "stale",
                };
            self.journal.set_job_state(&id, state)?;
            // Scratch is never exposed as the candidate or used for source paths.
            fs::remove_dir_all(&scratch).map_err(err)?;
            Ok(())
        })();
        if result.is_err() {
            self.journal.set_job_state(&id, "failed")?;
        }
        result?;
        self.journal.recovery_job(scope, &id)
    }
    /// Refresh before any continuation. A stale job never becomes ready again.
    pub async fn refresh(
        &self,
        scope: Scope,
        id: String,
        sandbox: &dyn Sandbox,
        env: &ChildEnv,
    ) -> Result<Job> {
        let (journal, bound, key) = (self.journal.clone(), scope.clone(), id.clone());
        let job = tokio::task::spawn_blocking(move || journal.recovery_job(&bound, &key))
            .await
            .map_err(err)??;
        if !matches!(job.state.as_str(), "ready" | "opened") {
            return Ok(job);
        }
        let git = self.eligibility(&scope, sandbox, env).await;
        let factory = self.clone();
        tokio::task::spawn_blocking(move || {
            let valid = git
                .and_then(|git| {
                    snapshot::scan(
                        &scope,
                        &job.manifest.limits,
                        factory.journal.limits.file_bytes,
                        git.as_ref(),
                    )
                })
                .is_ok_and(|s| s.fingerprint == job.manifest.source_revision);
            if !valid {
                factory.journal.set_job_state(&id, "stale")?;
            }
            factory.journal.recovery_job(&scope, &id)
        })
        .await
        .map_err(err)?
    }
}
fn make_parent(
    root: &std::os::fd::OwnedFd,
    path: &str,
    is_dir: bool,
) -> Result<std::os::fd::OwnedFd> {
    use rustix::fs::{Mode, OFlags, mkdirat, openat};
    let path = Path::new(path);
    let parent = if is_dir {
        path
    } else {
        path.parent().unwrap_or(Path::new(""))
    };
    let flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC;
    let mut dir = openat(root, ".", flags, Mode::empty()).map_err(err)?;
    for component in parent.components() {
        let std::path::Component::Normal(name) = component else {
            return Err(err("invalid candidate directory"));
        };
        match mkdirat(&dir, name, Mode::RWXU) {
            Ok(()) | Err(rustix::io::Errno::EXIST) => {}
            Err(e) => return Err(err(e)),
        }
        rustix::fs::fsync(&dir).map_err(err)?;
        dir = openat(&dir, name, flags, Mode::empty()).map_err(err)?;
    }
    Ok(dir)
}
fn overlaps(a: &str, b: &str) -> bool {
    Path::new(a).starts_with(b) || Path::new(b).starts_with(a)
}
fn content(journal: &Journal, v: &FileVersion) -> Result<Option<Content>> {
    match v {
        FileVersion::File {
            hash, executable, ..
        } => Ok(Some(Content {
            bytes: journal.read_blob(hash)?,
            executable: *executable,
        })),
        _ => Ok(None),
    }
}
fn version(file: Option<&Content>) -> FileVersion {
    match file {
        Some(f) => FileVersion::File {
            hash: digest(&f.bytes),
            size: f.bytes.len() as u64,
            executable: f.executable,
        },
        None => FileVersion::Absent,
    }
}
fn retain(journal: &Journal, db: &rusqlite::Connection, id: &str, file: &Content) -> Result<()> {
    let observation = files::Observation {
        version: version(Some(file)),
        bytes: Some(file.bytes.clone()),
    };
    journal.save_blob(db, &observation)?;
    db.execute(
        "INSERT OR IGNORE INTO recovery_blobs(job,hash) VALUES(?1,?2)",
        params![id, observation.version.hash()],
    )
    .map_err(err)?;
    Ok(())
}
pub(super) fn binding(scope: &Scope) -> Result<String> {
    Ok(digest(
        &serde_json::to_vec(&(
            &scope.node,
            &scope.owner,
            &scope.workspace,
            &scope.session,
            scope.epoch,
            &scope.run,
            &scope.root,
            scope.device,
            scope.inode,
            &scope.policy,
        ))
        .map_err(err)?,
    ))
}
fn revision(
    scope: &Scope,
    snapshot: &Snapshot,
    ops: &[Operation],
    selection: &Selection,
) -> Result<String> {
    Ok(digest(
        &serde_json::to_vec(&(binding(scope)?, &snapshot.fingerprint, ops, selection))
            .map_err(err)?,
    ))
}
fn request_hash(scope: &Scope, request: &PrepareRequest) -> Result<String> {
    Ok(digest(
        &serde_json::to_vec(&(binding(scope)?, request)).map_err(err)?,
    ))
}
fn validate_request(request: &PrepareRequest) -> Result<()> {
    if request.version != PROTOCOL_VERSION {
        return Err(err("unsupported recovery protocol version"));
    }
    if request.key.is_empty()
        || request.key.len() > 200
        || !super::valid_hash(&request.preview_revision)
    {
        return Err(err("invalid recovery request"));
    }
    Ok(())
}
fn existing_id(
    db: &rusqlite::Connection,
    scope: &Scope,
    request: &PrepareRequest,
) -> Result<Option<String>> {
    let row:Option<(String,String)>=db.query_row("SELECT id,request_hash FROM recovery_jobs WHERE node=?1 AND owner=?2 AND workspace=?3 AND request_key=?4",params![scope.node,scope.owner,scope.workspace,request.key],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(err)?;
    row.map(|(id, hash)| {
        if hash == request_hash(scope, request)? {
            Ok(id)
        } else {
            Err(err("idempotency key already binds a different request"))
        }
    })
    .transpose()
}
pub(super) fn output_scope(source: &Scope, root: &Path) -> Result<Scope> {
    let mut scope = source.clone();
    scope.root = root.into();
    scope.policy = Default::default();
    scope.bind_root()
}
impl Journal {
    fn existing_request(&self, scope: &Scope, request: &PrepareRequest) -> Result<Option<Job>> {
        let id = existing_id(&*self.lock()?, scope, request)?;
        id.map(|id| self.recovery_job(scope, &id)).transpose()
    }
    pub fn recovery_job(&self, scope: &Scope, id: &str) -> Result<Job> {
        let db = self.lock()?;
        let (state,revision,reserved,json):(String,i64,u64,String)=db.query_row("SELECT state,revision,reserved,manifest FROM recovery_jobs WHERE id=?1 AND node=?2 AND owner=?3 AND workspace=?4 AND session=?5 AND epoch=?6 AND run=?7",params![id,scope.node,scope.owner,scope.workspace,scope.session,scope.epoch,scope.run],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).map_err(|_|err("recovery job unavailable for this bound scope"))?;
        let manifest: Manifest = serde_json::from_str(&json).map_err(err)?;
        if manifest.binding != binding(scope)? {
            return Err(err("recovery root or policy binding changed"));
        }
        let retained: Vec<(String, u64)> = {
            let mut statement=db.prepare("SELECT hash,size FROM blobs WHERE hash IN (SELECT hash FROM recovery_blobs WHERE job=?1 UNION SELECT pre_blob FROM operations WHERE capture=(SELECT capture FROM recovery_jobs WHERE id=?1) UNION SELECT post_blob FROM operations WHERE capture=(SELECT capture FROM recovery_jobs WHERE id=?1))").map_err(err)?;
            statement
                .query_map([id], |r| Ok((r.get(0)?, r.get(1)?)))
                .map_err(err)?
                .collect::<std::result::Result<_, _>>()
                .map_err(err)?
        };
        for (hash, size) in retained {
            if !self.read_blob(&hash).is_ok_and(|b| b.len() as u64 == size) {
                db.execute(
                    "UPDATE recovery_jobs SET state='failed',revision=revision+1 WHERE id=?1",
                    [id],
                )
                .map_err(err)?;
                return Err(err(
                    "recovery inputs are missing or corrupt; output preserved for review",
                ));
            }
        }
        let output = matches!(state.as_str(), "ready" | "opened")
            .then(|| self.root.join("workspaces").join(id).join("root"));
        Ok(Job {
            id: id.into(),
            state,
            revision,
            reserved_bytes: reserved,
            manifest,
            output,
        })
    }
    pub(super) fn set_job_state(&self, id: &str, state: &str) -> Result<()> {
        self.lock()?
            .execute(
                "UPDATE recovery_jobs SET state=?2,revision=revision+1 WHERE id=?1 AND state!=?2",
                params![id, state],
            )
            .map_err(err)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sandbox::unavailable::UnavailableSandbox;
    fn setup() -> (tempfile::TempDir, Scope, RecoveryFactory) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("source");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("main"), b"current").unwrap();
        let scope = Scope {
            node: "n".into(),
            owner: "o".into(),
            workspace: "w".into(),
            session: "s".into(),
            epoch: 1,
            run: "r".into(),
            root,
            device: 0,
            inode: 0,
            policy: Default::default(),
        }
        .bind_root()
        .unwrap();
        let journal = Arc::new(
            Journal::open(&dir.path().join("state"), super::super::Limits::default()).unwrap(),
        );
        let factory = RecoveryFactory::new(journal, CopyLimits::default()).unwrap();
        (dir, scope, factory)
    }
    #[tokio::test]
    async fn external_process_during_copy_marks_result_stale_without_losing_its_write() {
        let (_dir, scope, mut factory) = setup();
        let source = scope.root.clone();
        factory.after_copy = Some(Arc::new(move || {
            let result = std::process::Command::new("/bin/sh")
                .args(["-c", "printf 'external editor' > \"$1\"", "writer"])
                .arg(source.join("main"))
                .status()
                .map_err(err)?;
            if !result.success() {
                return Err(err("fixture external writer failed"));
            }
            Ok(())
        }));
        let sandbox = UnavailableSandbox::new("not used");
        let env = ChildEnv::new();
        let selection = Selection {
            operations: vec![],
            review_observational: false,
        };
        let preview = factory
            .preview(scope.clone(), selection.clone(), &sandbox, &env)
            .await
            .unwrap();
        let job = factory
            .prepare(
                scope.clone(),
                PrepareRequest {
                    version: 1,
                    key: "race".into(),
                    preview_revision: preview.revision,
                    selection,
                },
                &sandbox,
                &env,
            )
            .await
            .unwrap();
        assert_eq!(job.state, "stale");
        assert!(job.output.is_none());
        assert_eq!(
            fs::read(scope.root.join("main")).unwrap(),
            b"external editor"
        );
    }
    #[tokio::test]
    async fn failed_copy_is_durable_and_retry_never_overwrites_partial_output() {
        let (_dir, scope, mut factory) = setup();
        factory.after_copy = Some(Arc::new(|| Err(err("injected I/O failure"))));
        let sandbox = UnavailableSandbox::new("not used");
        let env = ChildEnv::new();
        let selection = Selection {
            operations: vec![],
            review_observational: false,
        };
        let preview = factory
            .preview(scope.clone(), selection.clone(), &sandbox, &env)
            .await
            .unwrap();
        let request = PrepareRequest {
            version: 1,
            key: "failure".into(),
            preview_revision: preview.revision,
            selection,
        };
        assert!(
            factory
                .prepare(scope.clone(), request.clone(), &sandbox, &env)
                .await
                .unwrap_err()
                .contains("I/O failure")
        );
        let job = factory
            .prepare(scope.clone(), request, &sandbox, &env)
            .await
            .unwrap();
        assert_eq!(job.state, "failed");
        assert!(job.output.is_none());
        assert_eq!(fs::read(scope.root.join("main")).unwrap(), b"current");
        let output = factory
            .journal
            .root
            .join("workspaces")
            .join(&job.id)
            .join("root/main");
        assert_eq!(fs::read(output).unwrap(), b"current");
    }
}
