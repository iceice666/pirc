//! Repository knowledge transactions. Reads never repair; opening a writer is explicit.
use crate::{
    handoff::{self, SourceRef},
    journal::{self, Journal},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Boundary {
    pub session_id: String,
    pub after_entry_id: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Receipt {
    pub job_id: String,
    pub generation: String,
    pub session_id: String,
    pub from_entry_id: String,
    pub through_entry_id: String,
    pub outcome: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Commit {
    #[serde(rename = "type")]
    pub kind: String,
    pub version: u8,
    pub at: i64,
    pub epoch: String,
    pub generation: String,
    pub revision: u64,
    pub job_id: String,
    pub add: Vec<Value>,
    pub retire: Vec<String>,
    pub forget: Vec<String>,
    pub clear: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cutover: Option<Vec<Boundary>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clear_cutoffs: Option<Vec<Boundary>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receipt: Option<Receipt>,
}
#[derive(Clone, Debug, Default)]
pub struct Snapshot {
    pub control: Option<Commit>,
    pub cutover: Vec<Boundary>,
    pub clear_cutoffs: Vec<Boundary>,
    pub receipts: Vec<Receipt>,
    pub items: Vec<Value>,
    pub jobs: HashMap<String, Commit>,
    pub tombstones: HashSet<SourceRef>,
    pub forgotten_ranges: Vec<Receipt>,
    pub legacy_forgotten: HashSet<String>,
    pub hash: String,
    pub bytes: usize,
}
/// Errors that establish that the immutable mutation cannot commit at its original CAS.
/// Permission/readback/sync/transport failures can occur after commit and stay unknown.
pub fn mutation_rejected(code: &str) -> bool {
    matches!(
        code,
        "invalid_input"
            | "workspace_stale"
            | "workspace_job_conflict"
            | "workspace_cold_cutover_required"
            | "workspace_source_changed"
            | "workspace_source_blocked"
            | "workspace_invalid_retirement"
            | "workspace_already_active"
    )
}

pub fn id(s: &str) -> bool {
    s.len() == 12
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn item(v: &Value) -> bool {
    let Some(o) = v.as_object() else { return false };
    let keys = [
        "id",
        "content",
        "relevance",
        "timestamp",
        "sessionId",
        "sessionDir",
        "sourceMemoryIds",
        "sources",
        "origins",
        "git",
        "tokenCount",
    ];
    o.keys().all(|k| keys.contains(&k.as_str()))
        && v["id"].as_str().is_some_and(id)
        && v["content"]
            .as_str()
            .is_some_and(|s| !s.trim().is_empty() && crate::messages::js::utf16_len(s) <= 20000)
        && v["relevance"]
            .as_str()
            .is_some_and(|s| ["low", "medium", "high", "critical"].contains(&s))
        && v["timestamp"]
            .as_str()
            .is_some_and(|s| !s.is_empty() && s.len() <= 40)
        && v["sessionId"].as_str().is_some_and(handoff::key)
        && v["sessionDir"]
            .as_str()
            .is_some_and(|s| !s.is_empty() && s.len() <= 4096)
        && v["sourceMemoryIds"]
            .as_array()
            .is_some_and(|a| a.len() <= 200 && a.iter().all(|s| s.as_str().is_some_and(id)))
        && (v.get("sources").is_none()
            || serde_json::from_value::<Vec<SourceRef>>(v["sources"].clone()).is_ok_and(|a| {
                a.len() <= 100
                    && a.iter()
                        .all(|r| handoff::key(&r.session_id) && handoff::key(&r.entry_id))
            }))
        && v["tokenCount"]
            .as_f64()
            .is_some_and(|n| n.is_finite() && n >= 0.0 && n.fract() == 0.0)
}
fn boundaries(a: &[Boundary]) -> bool {
    let mut seen = HashSet::new();
    a.len() <= 10000
        && a.iter().all(|b| {
            handoff::key(&b.session_id)
                && b.after_entry_id.as_deref().is_none_or(handoff::key)
                && seen.insert(&b.session_id)
        })
}
fn validate(c: &Commit) -> bool {
    c.kind == "workspace.commit"
        && c.version == 2
        && c.at >= 0
        && handoff::key(&c.epoch)
        && handoff::key(&c.generation)
        && handoff::key(&c.job_id)
        && c.revision > 0
        && c.add.len() <= 100
        && c.add.iter().all(item)
        && c.retire.len() <= 2000
        && c.forget.len() <= 2000
        && c.retire.iter().chain(&c.forget).all(|s| id(s))
        && c.cutover.as_deref().is_none_or(boundaries)
        && c.clear_cutoffs.as_deref().is_none_or(boundaries)
        && c.receipt.as_ref().is_none_or(|r| {
            r.job_id == c.job_id
                && r.generation == c.generation
                && handoff::key(&r.session_id)
                && handoff::key(&r.from_entry_id)
                && handoff::key(&r.through_entry_id)
                && ["recorded", "empty"].contains(&r.outcome.as_str())
                && r.mode.as_deref().is_none_or(|m| m == "catchup")
                && (r.outcome == "empty") == (c.add.is_empty() && c.retire.is_empty())
        })
}
pub fn fold(values: &[Value]) -> Result<Snapshot, String> {
    let mut s = Snapshot::default();
    let mut all = HashMap::<String, Value>::new();
    let mut provenance = HashMap::<String, Receipt>::new();
    let mut order = Vec::new();
    let mut active = HashSet::new();
    for v in values {
        let (add, retire, forget, clear) = if v["type"] == "workspace.commit" {
            let c: Commit =
                serde_json::from_value(v.clone()).map_err(|_| "invalid_workspace_commit")?;
            if !validate(&c) || s.jobs.contains_key(&c.job_id) {
                return Err("invalid_workspace_commit".into());
            }
            if let Some(old) = &s.control {
                if c.cutover.is_some()
                    || c.epoch != old.epoch
                    || c.revision != old.revision + 1
                    || (c.generation != old.generation) != c.clear
                    || c.clear != c.clear_cutoffs.is_some()
                {
                    return Err("invalid_workspace_revision".into());
                }
            } else {
                if c.revision != 1
                    || c.cutover.is_none()
                    || c.clear
                    || c.clear_cutoffs.is_some()
                    || c.receipt.is_some()
                    || !c.add.is_empty()
                    || !c.retire.is_empty()
                {
                    return Err("invalid_workspace_cutover".into());
                }
                s.cutover = c.cutover.clone().unwrap();
            }
            if let Some(b) = &c.clear_cutoffs {
                s.clear_cutoffs = b.clone();
            }
            if let Some(r) = &c.receipt {
                for item in &c.add {
                    if let Some(id) = item["id"].as_str() {
                        provenance.insert(id.into(), r.clone());
                    }
                }
                s.receipts.push(r.clone());
            }
            s.jobs.insert(c.job_id.clone(), c.clone());
            s.control = Some(c.clone());
            (c.add, c.retire, c.forget, c.clear)
        } else {
            if s.control.is_some() {
                return Err("legacy_workspace_writer_after_cutover".into());
            }
            match v["type"].as_str() {
                Some("recorded") => {
                    let a = v["items"].as_array().ok_or("invalid_workspace_legacy")?;
                    if a.len() > 2000 || !a.iter().all(item) {
                        return Err("invalid_workspace_legacy".into());
                    }
                    (a.clone(), Vec::new(), Vec::new(), false)
                }
                Some("retired") => {
                    let ids: Vec<String> = serde_json::from_value(v["ids"].clone())
                        .map_err(|_| "invalid_workspace_legacy")?;
                    if !ids.iter().all(|s| id(s)) {
                        return Err("invalid_workspace_legacy".into());
                    }
                    if v["reason"] == "forgotten" {
                        (vec![], vec![], ids, false)
                    } else {
                        (vec![], ids, vec![], false)
                    }
                }
                Some("cleared") => (vec![], vec![], vec![], true),
                _ => return Err("invalid_workspace_line".into()),
            }
        };
        for id in &forget {
            s.legacy_forgotten.insert(id.clone());
            if let Some(receipt) = provenance.get(id) {
                s.forgotten_ranges.push(receipt.clone());
            }
            if let Some(v) = all.get(id) {
                if let Some(refs) = v.get("sources") {
                    s.tombstones.extend(
                        serde_json::from_value::<Vec<SourceRef>>(refs.clone())
                            .map_err(|_| "invalid_workspace_sources")?,
                    );
                }
                s.legacy_forgotten.insert(id.clone());
                if let Some(ids) = v["sourceMemoryIds"].as_array() {
                    s.legacy_forgotten
                        .extend(ids.iter().filter_map(Value::as_str).map(str::to_owned));
                }
            }
        }
        if clear {
            active.clear();
            all.retain(|id, _| s.legacy_forgotten.contains(id));
        }
        for id in retire.iter().chain(&forget) {
            active.remove(id);
        }
        let versioned = v["type"] == "workspace.commit";
        for v in add {
            let id = v["id"].as_str().ok_or("invalid_workspace_id")?.to_owned();
            if all.contains_key(&id) || s.legacy_forgotten.contains(&id) {
                if versioned {
                    return Err("duplicate_workspace_item".into());
                } else {
                    continue;
                }
            }
            order.push(id.clone());
            active.insert(id.clone());
            all.insert(id, v);
        }
    }
    s.items = order
        .into_iter()
        .filter(|id| active.contains(id))
        .filter_map(|id| all.remove(&id))
        .collect();
    Ok(s)
}
pub fn parse(raw: &[u8]) -> Result<Snapshot, String> {
    let p = journal::parse(raw)?;
    if p.incomplete
        || (p.needs_newline
            && p.values
                .last()
                .is_some_and(|v| v["type"] == "workspace.commit"))
    {
        return Err("workspace_incomplete_tail".into());
    }
    let mut s = fold(&p.values)?;
    s.hash = journal::digest(raw);
    s.bytes = raw.len();
    Ok(s)
}
pub fn validate_values(values: &[Value]) -> Result<(), String> {
    fold(values).map(|_| ())
}
pub fn read(path: &Path) -> Result<Snapshot, String> {
    use std::io::Read;
    use std::os::unix::fs::OpenOptionsExt;
    let file = match std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK)
        .open(path)
    {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return parse(&[]),
        Err(_) => return Err("workspace_unavailable".into()),
    };
    if !file
        .metadata()
        .map_err(|_| "workspace_unavailable")?
        .is_file()
    {
        return Err("workspace_unavailable".into());
    }
    let mut raw = Vec::new();
    file.take(journal::MAX_BYTES + 1)
        .read_to_end(&mut raw)
        .map_err(|_| "workspace_unavailable")?;
    parse(&raw)
}
/// An immutable job is replayed only when its exact frame is already durable.
pub fn append(path: &Path, frame: &Commit, expected: &Snapshot) -> Result<Snapshot, String> {
    append_checked(path, frame, expected, || Ok(()))
}
/// The check may return an admission guard. Keep it until the append and fsync
/// finish, then release it before reacquiring the journal for the final read.
pub fn append_checked<G>(
    path: &Path,
    frame: &Commit,
    expected: &Snapshot,
    check: impl FnOnce() -> Result<G, String>,
) -> Result<Snapshot, String> {
    if !validate(frame) {
        return Err("invalid_workspace_commit".into());
    }
    use std::os::unix::fs::DirBuilderExt;
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path.parent().ok_or("unsafe_journal_path")?)
        .map_err(|_| "workspace_directory_unavailable")?;
    let writer = Journal::at_path_without_repair(path, validate_values)?;
    let mut admission = None;
    writer.transaction(|raw| {
        let current = parse(raw)?;
        if let Some(old) = current.jobs.get(&frame.job_id) {
            if serde_json::to_value(old).unwrap() != serde_json::to_value(frame).unwrap() {
                return Err("workspace_job_conflict".into());
            }
            return Ok(((), Vec::new()));
        }
        admission = Some(check()?);
        if current.hash != expected.hash {
            return Err("workspace_stale".into());
        }
        let mut values = journal::parse(raw)?.values;
        values.push(serde_json::to_value(frame).unwrap());
        validate_values(&values)?;
        let mut delta = serde_json::to_vec(frame).map_err(|_| "invalid_workspace_commit")?;
        delta.push(b'\n');
        Ok(((), delta))
    })?;
    // Do not hold an admission lock while reacquiring this journal: another
    // checked writer may already hold the journal and be waiting for admission.
    drop(admission);
    // Re-read under the same OS mutex and synchronize before acknowledging.
    parse(&writer.snapshot()?)
}
pub fn frame(s: &Snapshot, job: &str) -> Commit {
    let new = || format!("{:032x}", rand_id());
    Commit {
        kind: "workspace.commit".into(),
        version: 2,
        at: crate::now_ms() as i64,
        epoch: s
            .control
            .as_ref()
            .map(|c| c.epoch.clone())
            .unwrap_or_else(new),
        generation: s
            .control
            .as_ref()
            .map(|c| c.generation.clone())
            .unwrap_or_else(new),
        revision: s.control.as_ref().map_or(1, |c| c.revision + 1),
        job_id: job.into(),
        add: vec![],
        retire: vec![],
        forget: vec![],
        clear: false,
        cutover: None,
        clear_cutoffs: None,
        receipt: None,
    }
}
fn rand_id() -> u128 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let x = format!(
        "{}:{}:{}",
        std::process::id(),
        crate::now_ms(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    );
    u128::from_str_radix(&journal::digest(x.as_bytes())[..32], 16).unwrap()
}
pub fn control(s: &Snapshot) -> Value {
    s.control.as_ref().map_or(Value::Null,|c|json!({"version":2,"epoch":c.epoch,"generation":c.generation,"revision":c.revision,"cutover":s.cutover,"clearCutoffs":s.clear_cutoffs,"receipts":s.receipts}))
}
/// Legacy upgrade proof: the same complete projection the gateway already stored.
pub fn projection(raw: &[u8]) -> Result<String, String> {
    let p = crate::journal::parse(raw)?;
    if p.incomplete {
        return Err("workspace_incomplete_tail".into());
    }
    let mut records = std::collections::BTreeMap::<String, (String, String)>::new();
    for v in p.values {
        let (add, retire, forget, clear) = if v["type"] == "workspace.commit" {
            let c: Commit = serde_json::from_value(v).map_err(|_| "invalid_workspace_commit")?;
            (c.add, c.retire, c.forget, c.clear)
        } else {
            match v["type"].as_str() {
                Some("recorded") => (
                    v["items"].as_array().cloned().unwrap_or_default(),
                    vec![],
                    vec![],
                    false,
                ),
                Some("retired") => {
                    let ids = serde_json::from_value::<Vec<String>>(v["ids"].clone())
                        .map_err(|_| "invalid_workspace_legacy")?;
                    if v["reason"] == "forgotten" {
                        (vec![], vec![], ids, false)
                    } else {
                        (vec![], ids, vec![], false)
                    }
                }
                Some("cleared") => (vec![], vec![], vec![], true),
                _ => return Err("invalid_workspace_line".into()),
            }
        };
        if clear {
            records.retain(|_, (status, _)| status == "forgotten");
        }
        for id in retire {
            if let Some((status, _)) = records.get_mut(&id)
                && status == "active"
            {
                *status = "superseded".into();
            }
        }
        for id in forget {
            records.insert(id, ("forgotten".into(), String::new()));
        }
        for v in add {
            if let (Some(id), Some(content)) = (v["id"].as_str(), v["content"].as_str()) {
                records
                    .entry(id.into())
                    .or_insert(("active".into(), content.into()));
            }
        }
    }
    let rows: Vec<_> = records
        .into_iter()
        .map(|(id, (status, content))| json!([id, status, content]))
        .collect();
    Ok(crate::journal::digest(
        serde_json::to_string(&rows).unwrap().as_bytes(),
    ))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn atomic_clear_receipt_and_legacy_fence() {
        let s = parse(b"").unwrap();
        let mut c = frame(&s, "cold");
        c.cutover = Some(vec![]);
        let mut values = vec![serde_json::to_value(&c).unwrap()];
        let s = fold(&values).unwrap();
        let mut next = frame(&s, "clear");
        next.clear = true;
        next.generation = "next".into();
        next.clear_cutoffs = Some(vec![]);
        values.push(serde_json::to_value(next).unwrap());
        assert!(fold(&values).is_ok());
        values.push(json!({"type":"cleared","at":0}));
        assert_eq!(
            fold(&values).unwrap_err(),
            "legacy_workspace_writer_after_cutover"
        );
    }
    #[test]
    fn malformed_transaction_never_applies_retirement() {
        let mut c = frame(&Snapshot::default(), "j");
        c.cutover = Some(vec![]);
        c.add.push(json!({"content":"bad"}));
        assert!(fold(&[serde_json::to_value(c).unwrap()]).is_err());
    }
}

#[cfg(test)]
mod recovery_tests {
    use super::*;
    #[test]
    fn complete_frame_without_delimiter_requires_writer_open() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("ledger.jsonl");
        let mut c = frame(&Snapshot::default(), "cold");
        c.cutover = Some(vec![]);
        std::fs::write(&path, serde_json::to_vec(&c).unwrap()).unwrap();
        assert_eq!(read(&path).unwrap_err(), "workspace_incomplete_tail");
        Journal::at_path(&path, validate_values).unwrap();
        assert!(read(&path).unwrap().control.is_some());
        assert!(std::fs::read(&path).unwrap().ends_with(b"\n"));
    }
}

#[cfg(test)]
mod outcome_tests {
    use super::*;
    #[test]
    fn mutation_rejections_never_include_ambiguous_delivery_or_lock_errors() {
        assert!(mutation_rejected("workspace_invalid_retirement"));
        assert!(mutation_rejected("workspace_source_blocked"));
        for code in [
            "forbidden",
            "not_found",
            "writer_busy",
            "journal_sync_unknown",
            "workspace_authority_unavailable",
            "internal_error",
        ] {
            assert!(!mutation_rejected(code), "{code}");
        }
    }
}

#[cfg(test)]
mod admission_tests {
    use super::*;
    use std::{
        cell::Cell,
        sync::{Mutex, MutexGuard},
    };

    struct Admission<'a> {
        _lock: MutexGuard<'a, ()>,
        path: &'a Path,
        expected_job: &'a str,
        dropped: &'a Cell<bool>,
    }
    impl Drop for Admission<'_> {
        fn drop(&mut self) {
            // The file must already contain the durable commit at release.
            assert!(
                read(self.path)
                    .unwrap()
                    .jobs
                    .contains_key(self.expected_job)
            );
            // Admission must not be released from inside the journal lock.
            Journal::at_path(self.path, validate_values)
                .unwrap()
                .snapshot()
                .unwrap();
            self.dropped.set(true);
        }
    }
    #[test]
    fn admission_survives_append_and_is_released_before_the_final_read() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.jsonl");
        let state = read(&path).unwrap();
        let mut cold = frame(&state, "cold_guarded");
        cold.cutover = Some(vec![]);
        let lock = Mutex::new(());
        let dropped = Cell::new(false);
        let result = append_checked(&path, &cold, &state, || {
            let guard = lock.lock().unwrap();
            assert!(lock.try_lock().is_err());
            Ok(Admission {
                _lock: guard,
                path: &path,
                expected_job: "cold_guarded",
                dropped: &dropped,
            })
        })
        .unwrap();
        assert!(dropped.get());
        assert!(lock.try_lock().is_ok());
        assert!(result.jobs.contains_key("cold_guarded"));
        // A lost ACK replays its immutable receipt even if new work is active;
        // it does not perform another cutover or reacquire fresh authority.
        let result = append_checked(&path, &cold, &state, || -> Result<(), String> {
            panic!("a committed immutable frame must not be reapplied");
        })
        .unwrap();
        assert_eq!(result.jobs.len(), 1);
    }
    #[test]
    fn checked_append_never_repairs_bytes_before_its_admission_check() {
        for complete in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("workspace.jsonl");
            let state = parse(b"").unwrap();
            let mut cold = frame(&state, "cold");
            cold.cutover = Some(vec![]);
            let mut raw = serde_json::to_vec(&cold).unwrap();
            if !complete {
                raw.truncate(raw.len() / 2);
            }
            std::fs::write(&path, &raw).unwrap();
            let result = append_checked(&path, &cold, &state, || -> Result<(), String> {
                panic!("must reject an unrepaired journal before entering commit checks");
            });
            assert_eq!(result.unwrap_err(), "journal_repair_required");
            assert_eq!(std::fs::read(&path).unwrap(), raw);
            assert!(!std::fs::read_dir(dir.path()).unwrap().any(|entry| {
                entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .contains(".incomplete-")
            }));
            // Explicit authorized repair is still supported, followed by append.
            Journal::at_path(&path, validate_values).unwrap();
            let repaired = read(&path).unwrap();
            assert!(append(&path, &cold, &repaired).is_ok());
        }
    }

    #[test]
    fn stale_cas_releases_admission_without_writing_another_frame() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.jsonl");
        let empty = read(&path).unwrap();
        let mut cold = frame(&empty, "existing");
        cold.cutover = Some(vec![]);
        let current = append(&path, &cold, &empty).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        let mut clear = frame(&current, "stale");
        clear.clear = true;
        clear.clear_cutoffs = Some(vec![]);
        let lock = Mutex::new(());
        let dropped = Cell::new(false);
        let result = append_checked(&path, &clear, &empty, || {
            Ok(Admission {
                _lock: lock.lock().unwrap(),
                path: &path,
                expected_job: "existing",
                dropped: &dropped,
            })
        });
        assert_eq!(result.unwrap_err(), "workspace_stale");
        assert!(dropped.get());
        assert!(lock.try_lock().is_ok());
        assert_eq!(std::fs::read(path).unwrap(), bytes);
    }
}
