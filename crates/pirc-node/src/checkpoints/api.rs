//! Authenticated session APIs; the agent RPC channel cannot call these routes.
use super::{
    FileVersion, Journal, Scope,
    recovery::{CopyLimits, Job, PrepareRequest, RecoveryFactory, Selection},
};
use crate::{
    error::{ApiError, ApiResult},
    router::{Request, Response, Route, get, post},
    sandbox::ReadonlyInput,
    services::Node,
    store::{SessionRow, Store, Workspace},
};
use rusqlite::params;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Arc};

pub(super) fn failure(error: String) -> ApiError {
    crate::log::warn(&error);
    ApiError::new(
        409,
        "checkpoint_unavailable",
        if error.contains("stale") || error.contains("changed") {
            "Checkpoint or workspace changed. Refresh before continuing."
        } else if error.contains("budget") || error.contains("limit") || error.contains("space") {
            "Checkpoint storage or copy limit reached."
        } else if error.contains("writer group") {
            "Recovery workspace already has an active agent."
        } else if error.contains("keep-current") {
            "Review unresolved files and confirm keeping current content."
        } else {
            "Checkpoint operation unavailable. Refresh and review its coverage."
        },
    )
}
fn source(node: &Node, r: &Request) -> ApiResult<(SessionRow, Workspace)> {
    let db = node.db.lock();
    let s = db.claim_session(r.param("id").unwrap_or_default(), &r.user, false)?;
    let w = db.get_workspace(&s.workspace_id)?;
    super::continuation::require_workspace_owner(&db, &w.id, &r.user)?;
    Ok((s, w))
}
fn service(node: &Node, w: &Workspace) -> ApiResult<Arc<super::runtime::CaptureService>> {
    if node.workspace_mode(w)?.workdir != pirc_protocol::mode::Workdir::Workspace {
        return Err(ApiError::conflict(
            "Checkpoints require a directory workspace",
        ));
    }
    node.checkpoints
        .as_ref()
        .filter(|c| c.enabled(&w.id))
        .cloned()
        .ok_or_else(|| ApiError::conflict("Checkpoint capture is disabled for this workspace"))
}
fn env(node: &Node) -> crate::panels::inspect::ChildEnv {
    pirc_config::env_allowlist::without_secrets(&node.env, &[])
}
/// Strip ephemeral readonly-command temp grants. Rebuild effective configured
/// write denies too, so absolute source rules retain their meaning after copy.
async fn policy(node: &Node, w: &Workspace) -> ApiResult<pirc_policy::PathPolicy> {
    let prepared = node
        .sandbox
        .prepare_readonly(ReadonlyInput {
            workspace_root: w.canonical_path.clone().into(),
            command: vec!["/bin/true".into()],
        })
        .await?;
    let mut p = prepared.policy.paths.clone();
    let temps = p.allow_write.clone();
    p.allow_read
        .retain(|s| !temps.iter().any(|t| std::path::Path::new(s).starts_with(t)));
    p.allow_write = vec![w.canonical_path.clone()];
    p.shared_write = None;
    let cfg = pirc_policy::session::read_agent_config(
        &node.config.config_dir.to_string_lossy(),
        &node.env.home().to_string_lossy(),
    );
    p.deny_write = cfg
        .sandbox
        .filesystem
        .deny_write
        .iter()
        .map(|s| {
            pirc_policy::real_resolve(&pirc_policy::resolve_path(
                &cfg.config_dir,
                &pirc_policy::expand_home_path(s, &node.env.home().to_string_lossy()),
            ))
        })
        .collect();
    p.deny_write.push(
        PathBuf::from(&w.canonical_path)
            .join(".pirc")
            .to_string_lossy()
            .into_owned(),
    );
    prepared.cleanup();
    // Bind source-local effective policy, not ephemeral command/node temp
    // directories. Private rules outside this source are rebuilt by the new
    // sandbox; retaining random temp grants would break jobs after restart.
    let root = std::path::Path::new(&w.canonical_path);
    let relevant = |rule: &String| {
        let path = std::path::Path::new(rule);
        path.starts_with(root) || root.starts_with(path)
    };
    p.deny_read.retain(relevant);
    p.allow_read.retain(relevant);
    p.deny_write.retain(relevant);
    for rules in [&mut p.deny_read, &mut p.allow_read, &mut p.deny_write] {
        rules.sort();
        rules.dedup();
    }
    Ok(p)
}
async fn bound(
    node: &Node,
    r: &Request,
    s: &SessionRow,
    w: &Workspace,
) -> ApiResult<(Arc<super::runtime::CaptureService>, Scope)> {
    let service = service(node, w)?;
    let policy = policy(node, w).await?;
    let capture = r.param("capture").unwrap_or_default();
    let scope = service
        .journal
        .api_scope(&node.config.node_id, &r.user, s, w, capture, policy)
        .map_err(failure)?;
    Ok((service, scope))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PreviewBody {
    operations: Vec<String>,
    review_observational: bool,
}
impl PreviewBody {
    fn selection(self) -> ApiResult<Selection> {
        if self.operations.is_empty() || self.operations.len() > 1000 {
            return Err(ApiError::invalid_input());
        }
        Ok(Selection {
            operations: self.operations,
            review_observational: self.review_observational,
        })
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PrepareBody {
    version: u32,
    key: String,
    preview_revision: String,
    operations: Vec<String>,
    review_observational: bool,
    client_id: String,
    generation: i64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ContinueBody {
    revision: i64,
    accept_unresolved: bool,
    client_id: String,
    generation: i64,
}
fn lease(node: &Node, s: &SessionRow, client: &str, generation: i64) -> ApiResult<()> {
    node.db.lock().validate_lease(&s.id, client, generation)
}
fn changed(node: &Node, s: &SessionRow) {
    node.events
        .publish(&s.id, s.runner_epoch, "checkpoints_changed", json!({}));
}
fn factory(s: &super::runtime::CaptureService) -> ApiResult<RecoveryFactory> {
    s.recovery_factory(CopyLimits::default()).map_err(failure)
}

async fn load_job(
    service: &super::runtime::CaptureService,
    scope: &Scope,
    id: &str,
) -> ApiResult<Job> {
    let (journal, scope, id) = (service.journal.clone(), scope.clone(), id.to_owned());
    tokio::task::spawn_blocking(move || journal.recovery_job(&scope, &id))
        .await
        .map_err(|_| ApiError::internal())?
        .map_err(failure)
}

pub fn routes() -> Vec<Route> {
    vec![
        get("/api/sessions/:id/checkpoints", |node, r| async move {
            let (s, w) = source(&node, &r)?;
            let origin = super::continuation::origin(&node.db.lock(), &w.id, &r.user)?;
            let Ok(service) = service(&node, &w) else {
                return Ok(Response::json(
                    json!({"version":1,"enabled":false,"captures":[],"jobs":[],"more":false,"origin":origin}),
                ));
            };
            let cursor = r.single_query("cursor")?.map(str::to_owned);
            let (journal, nid, user) = (
                service.journal.clone(),
                node.config.node_id.clone(),
                r.user.clone(),
            );
            let source_id = s.id.clone();
            let source_owner = r.user.clone();
            let (captures, more, cursor, mut jobs) = tokio::task::spawn_blocking(move || {
                journal.api_list(&nid, &user, &s, &w, cursor.as_deref())
            })
            .await
            .map_err(|_| ApiError::internal())?
            .map_err(failure)?;
            for job in &mut jobs {
                if let Some(id) = job["id"].as_str() {
                    let mapped = super::continuation::mapped(
                        &node.db.lock(),
                        id,
                        &source_owner,
                        &source_id,
                    )?;
                    job["continuation"] = mapped
                        .map(|(w, s)| json!({"sessionId":s.id,"workspaceId":w.id}))
                        .unwrap_or(Value::Null);
                }
            }
            Ok(Response::json(
                json!({"version":1,"enabled":true,"captures":captures,"jobs":jobs,"more":more,"cursor":cursor,"origin":origin}),
            ))
        }),
        post(
            "/api/sessions/:id/checkpoints/:capture/preview",
            |node, r| async move {
                let body: PreviewBody = r.parse_body()?;
                let selection = body.selection()?;
                let (s, w) = source(&node, &r)?;
                let (service, scope) = bound(&node, &r, &s, &w).await?;
                let preview = factory(&service)?
                    .preview(scope, selection, &*node.sandbox, &env(&node))
                    .await
                    .map_err(failure)?;
                Ok(Response::json(
                    json!({"version":preview.version,"revision":preview.revision,"copiedBytes":preview.copied_bytes,"exclusions":preview.exclusions,"coverage":preview.coverage}),
                ))
            },
        ),
        post(
            "/api/sessions/:id/checkpoints/:capture/recoveries",
            |node, r| async move {
                let body: PrepareBody = r.parse_body()?;
                let selection = PreviewBody {
                    operations: body.operations,
                    review_observational: body.review_observational,
                }
                .selection()?;
                let (s, w) = source(&node, &r)?;
                lease(&node, &s, &body.client_id, body.generation)?;
                let (service, scope) = bound(&node, &r, &s, &w).await?;
                let job = factory(&service)?
                    .prepare(
                        scope,
                        PrepareRequest {
                            version: body.version,
                            key: body.key,
                            preview_revision: body.preview_revision,
                            selection,
                        },
                        &*node.sandbox,
                        &env(&node),
                    )
                    .await
                    .map_err(failure)?;
                lease(&node, &s, &body.client_id, body.generation)?;
                changed(&node, &s);
                Ok(Response::json(dto_job(
                    &node,
                    &s,
                    r.param("capture").unwrap_or_default(),
                    job,
                )?))
            },
        ),
        get(
            "/api/sessions/:id/checkpoints/:capture/recoveries/:job",
            |node, r| async move {
                let (s, w) = source(&node, &r)?;
                let (service, scope) = bound(&node, &r, &s, &w).await?;
                let job_id = r.param("job").unwrap_or_default().to_owned();
                // Once adopted, the result belongs to its new workspace. Original edits
                // never recopy, invalidate or overwrite the user's new workspace.
                let adopted =
                    super::continuation::mapped(&node.db.lock(), &job_id, &r.user, &s.id)?
                        .is_some();
                let job = if adopted {
                    load_job(&service, &scope, &job_id).await?
                } else {
                    factory(&service)?
                        .refresh(scope, job_id, &*node.sandbox, &env(&node))
                        .await
                        .map_err(failure)?
                };
                Ok(Response::json(dto_job(
                    &node,
                    &s,
                    r.param("capture").unwrap_or_default(),
                    job,
                )?))
            },
        ),
        post(
            "/api/sessions/:id/checkpoints/:capture/recoveries/:job/continue",
            |node, r| async move {
                let body: ContinueBody = r.parse_body()?;
                let (s, w) = source(&node, &r)?;
                lease(&node, &s, &body.client_id, body.generation)?;
                let (service, scope) = bound(&node, &r, &s, &w).await?;
                let _gate = service.continuation_gate.lock().await;
                lease(&node, &s, &body.client_id, body.generation)?;
                let id = r.param("job").unwrap_or_default();
                let capture = r.param("capture").unwrap_or_default();
                let existing = super::continuation::mapped(&node.db.lock(), id, &r.user, &s.id)?;
                if let Some((workspace, session)) = existing {
                    let job = load_job(&service, &scope, id).await?;
                    return Ok(Response::json(
                        json!({"session":session,"workspace":workspace,"job":dto_job(&node,&s,capture,job)?}),
                    ));
                }
                let job = load_job(&service, &scope, id).await?;
                if !matches!(job.state.as_str(), "ready" | "opened")
                    || (job.state == "ready" && job.revision != body.revision)
                {
                    return Err(ApiError::conflict(
                        "Recovery confirmation is stale. Refresh before continuing.",
                    ));
                }
                if !body.accept_unresolved
                    && job
                        .manifest
                        .paths
                        .iter()
                        .any(|p| p.status != "inverse_reviewed_observation")
                {
                    return Err(ApiError::conflict(
                        "Review unresolved paths and confirm keeping current content.",
                    ));
                }
                {
                    let mut db = node.db.lock();
                    let tx = db.transaction()?;
                    tx.validate_lease(&s.id, &body.client_id, body.generation)?;
                    super::continuation::intent(
                        &tx,
                        id,
                        &r.user,
                        &s.id,
                        capture,
                        body.revision,
                        job.revision,
                        body.accept_unresolved,
                        &scope,
                    )?;
                    tx.commit()?;
                }
                // Matching durable intent permits resumption after a crash between claim
                // and adoption, without creating a second workspace or stealing a lease.
                let ticket = factory(&service)?
                    .claim(
                        scope.clone(),
                        id.into(),
                        if job.state == "opened" {
                            job.revision
                        } else {
                            body.revision
                        },
                        body.accept_unresolved,
                        &*node.sandbox,
                        &env(&node),
                    )
                    .await
                    .map_err(failure)?;
                let (workspace, session) = super::continuation::adopt(
                    &node,
                    &s,
                    &scope,
                    capture,
                    id,
                    ticket.root(),
                    &body.client_id,
                    body.generation,
                )?;
                let job = load_job(&service, &scope, id).await?;
                drop(ticket);
                changed(&node, &s);
                node.activity.notify_one();
                Ok(Response::json(
                    json!({"session":session,"workspace":workspace,"job":dto_job(&node,&s,capture,job)?}),
                ))
            },
        ),
        get(
            "/api/sessions/:id/checkpoints/:capture/file",
            |node, r| async move {
                let (s, w) = source(&node, &r)?;
                let (service, scope) = bound(&node, &r, &s, &w).await?;
                let operation = r
                    .single_query("operation")?
                    .ok_or_else(ApiError::invalid_input)?
                    .to_owned();
                let side = r
                    .single_query("side")?
                    .ok_or_else(ApiError::invalid_input)?
                    .to_owned();
                let job = r.single_query("job")?.map(str::to_owned);
                let j = service.journal.clone();
                let body = tokio::task::spawn_blocking(move || {
                    j.api_file(&scope, &operation, &side, job.as_deref())
                })
                .await
                .map_err(|_| ApiError::internal())?
                .map_err(failure)?;
                Ok(Response::json(body))
            },
        ),
    ]
}
fn dto_job(node: &Node, s: &SessionRow, capture: &str, job: Job) -> ApiResult<Value> {
    let continuation = super::continuation::mapped(
        &node.db.lock(),
        &job.id,
        s.owner_user.as_deref().unwrap_or_default(),
        &s.id,
    )?
    .map(|(w, s)| json!({"workspaceId":w.id,"sessionId":s.id}));
    Ok(
        json!({"id":job.id,"captureId":capture,"operations":job.manifest.selection.operations,"state":job.state,"revision":job.revision,"reservedBytes":job.reserved_bytes,"manifest":{"paths":job.manifest.paths,"exclusions":job.manifest.exclusions,"copiedBytes":job.manifest.copied_bytes,"coverage":job.manifest.coverage},"continuation":continuation}),
    )
}
type CapturePage = (Vec<Value>, bool, Option<String>, Vec<Value>);

impl Journal {
    fn api_scope(
        &self,
        node: &str,
        owner: &str,
        s: &SessionRow,
        w: &Workspace,
        capture: &str,
        policy: pirc_policy::PathPolicy,
    ) -> super::Result<Scope> {
        let (epoch,run,root,device,inode):(i64,String,String,String,String)=self.lock()?.query_row("SELECT epoch,run,root,device,inode FROM captures WHERE id=?1 AND node=?2 AND owner=?3 AND workspace=?4 AND session=?5",params![capture,node,owner,w.id,s.id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).map_err(|_|super::err("capture unavailable for this owner/session"))?;
        if PathBuf::from(&w.canonical_path)
            .canonicalize()
            .map_err(super::err)?
            != std::path::Path::new(&root)
        {
            return Err(super::err("workspace root changed"));
        }
        let scope = Scope {
            node: node.into(),
            owner: owner.into(),
            workspace: w.id.clone(),
            session: s.id.clone(),
            epoch,
            run,
            root: root.into(),
            device: 0,
            inode: 0,
            policy,
        }
        .bind_root()?;
        if (scope.device.to_string(), scope.inode.to_string()) != (device, inode) {
            return Err(super::err("workspace identity changed"));
        }
        Ok(scope)
    }
    fn api_list(
        &self,
        node: &str,
        owner: &str,
        s: &SessionRow,
        w: &Workspace,
        cursor: Option<&str>,
    ) -> super::Result<CapturePage> {
        let db = self.lock()?;
        let (time, key) = if let Some(cursor) = cursor {
            let (t, k) = cursor
                .split_once(':')
                .ok_or_else(|| super::err("invalid cursor"))?;
            (t.parse::<i64>().map_err(super::err)?, k.to_owned())
        } else {
            (i64::MAX, String::new())
        };
        let rows: Vec<(String, String, bool, bool, i64, String)> = {
            let mut q=db.prepare("SELECT id,state,pinned,gaps,created,run FROM captures WHERE node=?1 AND owner=?2 AND workspace=?3 AND session=?4 AND (created<?5 OR (created=?5 AND id<?6)) ORDER BY created DESC,id DESC LIMIT 11").map_err(super::err)?;
            q.query_map(params![node, owner, w.id, s.id, time, key], |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                ))
            })
            .map_err(super::err)?
            .collect::<rusqlite::Result<_>>()
            .map_err(super::err)?
        };
        let more = rows.len() > 10;
        let mut captures = Vec::new();
        let mut next = None;
        for (id, state, pinned, gaps, created, run) in rows.into_iter().take(10) {
            let mut q=db.prepare("SELECT id,path,tool,state,before_json,after_json FROM operations WHERE capture=?1 ORDER BY seq LIMIT 101").map_err(super::err)?;
            let ops: Vec<(String, String, String, String, String, Option<String>)> = q
                .query_map([&id], |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                    ))
                })
                .map_err(super::err)?
                .collect::<rusqlite::Result<_>>()
                .map_err(super::err)?;
            let truncated = ops.len() > 100;
            let operations:Vec<Value>=ops.into_iter().take(100).map(|(id,path,tool,state,before,after)|Ok(json!({"id":id,"path":path,"tool":tool,"state":state,"before":serde_json::from_str::<Value>(&before).map_err(super::err)?,"after":after.map(|s|serde_json::from_str::<Value>(&s)).transpose().map_err(super::err)?}))).collect::<super::Result<_>>()?;
            captures.push(json!({"id":id,"state":state,"coverage":"observational: main-agent direct file tools only; shell, children, terminals and external writers uncovered","pinned":pinned,"gaps":gaps,"created":created,"run":run,"operations":operations,"operationsTruncated":truncated}));
            next = Some(format!("{created}:{id}"));
        }
        let mut q=db.prepare("SELECT r.id,r.state,r.revision,r.reserved,r.manifest,c.id FROM recovery_jobs r JOIN captures c ON c.id=r.capture WHERE r.node=?1 AND r.owner=?2 AND r.workspace=?3 AND r.session=?4 ORDER BY r.created DESC,r.id DESC LIMIT 20").map_err(super::err)?;
        let rows = q
            .query_map(params![node, owner, w.id, s.id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, u64>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, String>(5)?,
                ))
            })
            .map_err(super::err)?;
        let mut jobs = Vec::new();
        for row in rows {
            let (id, state, revision, reserved, json, capture) = row.map_err(super::err)?;
            let manifest: super::recovery::Manifest =
                serde_json::from_str(&json).map_err(super::err)?;
            jobs.push(json!({"id":id,"captureId":capture,"operations":manifest.selection.operations,"state":state,"revision":revision,"reservedBytes":reserved,"manifest":{"paths":manifest.paths,"copiedBytes":manifest.copied_bytes,"coverage":manifest.coverage,"exclusions":manifest.exclusions}}));
        }
        Ok((captures, more, if more { next } else { None }, jobs))
    }
    fn api_file(
        &self,
        scope: &Scope,
        operation: &str,
        side: &str,
        job: Option<&str>,
    ) -> super::Result<Value> {
        let operations = self.operations(scope)?;
        let op = operations
            .into_iter()
            .find(|op| op.id == operation)
            .ok_or_else(|| super::err("operation unavailable"))?;
        self.bound_operation(&*self.lock()?, scope, operation)?;
        let guard = pirc_policy::PathGuard::new(&scope.root.to_string_lossy(), &scope.policy, &[]);
        guard
            .resolve(&scope.root.join(&op.path).to_string_lossy(), false)
            .map_err(super::err)?;
        let version = match side {
            "before" => op.before,
            "after" => op
                .after
                .ok_or_else(|| super::err("postimage unavailable"))?,
            "current" | "candidate" => {
                let job =
                    self.recovery_job(scope, job.ok_or_else(|| super::err("job required"))?)?;
                if !job
                    .manifest
                    .selection
                    .operations
                    .iter()
                    .any(|id| id == operation)
                {
                    return Err(super::err("operation not selected in this job"));
                }
                let path = job
                    .manifest
                    .paths
                    .iter()
                    .find(|p| p.path == op.path)
                    .ok_or_else(|| super::err("path not selected in this job"))?;
                if side == "current" {
                    path.current.clone()
                } else {
                    path.candidate.clone()
                }
            }
            _ => return Err(super::err("invalid file side")),
        };
        let mut text = None;
        let mut binary = false;
        let mut truncated = false;
        if let FileVersion::File { hash, .. } = &version {
            let bytes = self.read_blob(hash)?;
            binary = bytes.contains(&0) || std::str::from_utf8(&bytes).is_err();
            if !binary {
                let value = String::from_utf8(bytes).map_err(super::err)?;
                let mut end = value.len().min(256 * 1024);
                while !value.is_char_boundary(end) {
                    end -= 1;
                }
                truncated = end < value.len();
                text = Some(value[..end].to_owned());
            }
        }
        Ok(
            json!({"path":op.path,"side":side,"text":text,"binary":binary,"truncated":truncated,"absent":matches!(version,FileVersion::Absent),"excluded":matches!(version,FileVersion::Excluded{..}),"executable":match version{FileVersion::File{executable,..}=>Some(executable),_=>None}}),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pirc_config::{Env, NodeConfig};
    use pirc_protocol::{HttpMethod, ModeId, NodeHttpRequest, NodeHttpResponse, NodeRole};
    use std::fs;
    struct Fixture {
        dir: tempfile::TempDir,
        node: Node,
        config: NodeConfig,
        env: Env,
        session: SessionRow,
        scope: Scope,
        operation: String,
        capture: String,
        generation: i64,
    }
    impl Fixture {
        async fn new() -> Self {
            let dir = tempfile::Builder::new()
                .prefix("p4-")
                .tempdir_in("/tmp")
                .unwrap();
            let root = dir.path().canonicalize().unwrap();
            let state = root.join("state");
            let work = root.join("work");
            let temp = root.join("tmp");
            fs::create_dir(&work).unwrap();
            fs::create_dir(&temp).unwrap();
            let env = Env::new(
                [
                    ("HOME", root.to_str().unwrap()),
                    ("TMPDIR", temp.to_str().unwrap()),
                    ("PIRC_STATE_DIR", state.to_str().unwrap()),
                    ("PIRC_CONFIG_DIR", root.join("config").to_str().unwrap()),
                    ("PIRC_NODE_ID", "n"),
                    ("PIRC_NODE_TOKEN", "0123456789abcdef0123456789abcdef"),
                    ("PIRC_DAEMON_URL", "ws://127.0.0.1:8787"),
                    ("PIRC_ALLOWED_USERS", "owner,other"),
                    ("PIRC_BROWSER", "false"),
                    ("PIRC_CHECKPOINT_WORKSPACES", "[\"w\"]"),
                ],
                &root,
            );
            let mut config = NodeConfig::load(&env, NodeRole::Node).unwrap();
            config.agent_command = "/bin/sh".into();
            config.agent_args.clear();
            let node = crate::services::Services::start(config.clone(), env.clone())
                .await
                .unwrap();
            node.replace_modes(vec![pirc_protocol::mode::default_work()])
                .await;
            let (w, s, generation) = {
                let db = node.db.lock();
                let w = db
                    .add_workspace(
                        "w",
                        "n",
                        "Original",
                        work.to_str().unwrap(),
                        ModeId::new("directory").unwrap(),
                    )
                    .unwrap();
                let s = db
                    .create_session(
                        "w",
                        state.join("sessions/source").to_str().unwrap(),
                        "owner",
                    )
                    .unwrap();
                let lease = db.acquire_lease(&s.id, "phone", true, 300_000).unwrap();
                (w, s, lease.generation)
            };
            fs::write(work.join("main"), b"user baseline\r\n").unwrap();
            let scope = Scope {
                node: "n".into(),
                owner: "owner".into(),
                workspace: w.id.clone(),
                session: s.id.clone(),
                epoch: 1,
                run: "run".into(),
                root: work,
                device: 0,
                inode: 0,
                policy: Default::default(),
            }
            .bind_root()
            .unwrap();
            let journal = &node.checkpoints.as_ref().unwrap().journal;
            let operation = journal
                .begin(&scope, &scope.root.join("main"), "write", None)
                .unwrap();
            fs::write(scope.root.join("main"), b"agent edit\n").unwrap();
            journal.finish(&scope, &operation, true).unwrap();
            journal.seal(&s.id, 1, Some("run"), false).unwrap();
            let capture = journal.info(&scope).unwrap().unwrap().id;
            Self {
                dir,
                node,
                config,
                env,
                session: s,
                scope,
                operation,
                capture,
                generation,
            }
        }
        fn base(&self) -> String {
            format!(
                "/api/sessions/{}/checkpoints/{}",
                self.session.id, self.capture
            )
        }
        async fn request(
            &self,
            method: HttpMethod,
            url: String,
            payload: Option<Value>,
            user: &str,
        ) -> NodeHttpResponse {
            tokio::time::timeout(
                std::time::Duration::from_secs(15),
                self.node.router.handle(
                    &self.node,
                    NodeHttpRequest {
                        method,
                        url,
                        user: user.into(),
                        payload,
                        body_base64: None,
                        content_type: None,
                    },
                ),
            )
            .await
            .expect("request deadlock")
        }
        async fn prepare(&self, key: &str) -> Value {
            let preview = self
                .request(
                    HttpMethod::Post,
                    format!("{}/preview", self.base()),
                    Some(json!({"operations":[self.operation],"reviewObservational":true})),
                    "owner",
                )
                .await;
            assert_eq!(preview.status, 200, "{:?}", preview.body);
            let response=self.request(HttpMethod::Post,format!("{}/recoveries",self.base()),Some(json!({"version":1,"key":key,"previewRevision":preview.body.unwrap()["revision"],"operations":[self.operation],"reviewObservational":true,"clientId":"phone","generation":self.generation})),"owner").await;
            assert_eq!(response.status, 200, "{:?}", response.body);
            response.body.unwrap()
        }
        async fn continue_job(&self, job: &Value, revision: i64) -> NodeHttpResponse {
            self.request(HttpMethod::Post,format!("{}/recoveries/{}/continue",self.base(),job["id"].as_str().unwrap()),Some(json!({"revision":revision,"acceptUnresolved":true,"clientId":"phone","generation":self.generation})),"owner").await
        }
    }
    #[tokio::test]
    async fn routes_own_lease_revision_and_idempotent_adoption_preserve_source_and_user_edits() {
        let f = Fixture::new().await;
        let job = f.prepare("one").await;
        assert_eq!(
            job["manifest"]["paths"][0]["status"],
            "inverse_reviewed_observation"
        );
        assert!(job.get("output").is_none());
        assert!(!job.to_string().contains(f.dir.path().to_str().unwrap()));
        let stale = f.continue_job(&job, 999).await;
        assert_eq!(stale.status, 409);
        let first = f
            .continue_job(&job, job["revision"].as_i64().unwrap())
            .await;
        assert_eq!(first.status, 200, "{:?}", first.body);
        let first = first.body.unwrap();
        let again = f
            .continue_job(&job, job["revision"].as_i64().unwrap())
            .await;
        assert_eq!(again.status, 200, "{:?}", again.body);
        assert_eq!(again.body.unwrap()["session"]["id"], first["session"]["id"]);
        let workspace = f
            .node
            .db
            .lock()
            .get_workspace(first["workspace"]["id"].as_str().unwrap())
            .unwrap();
        let origin = f
            .request(
                HttpMethod::Get,
                format!(
                    "/api/sessions/{}/checkpoints",
                    first["session"]["id"].as_str().unwrap()
                ),
                None,
                "owner",
            )
            .await;
        assert_eq!(origin.status, 200);
        assert_eq!(
            origin.body.unwrap()["origin"],
            json!({"sessionId":f.session.id,"workspaceId":"w","captureId":f.capture,"jobId":job["id"]})
        );
        let root = PathBuf::from(&workspace.canonical_path);
        assert_eq!(fs::read(root.join("main")).unwrap(), b"user baseline\r\n");
        assert_eq!(
            fs::read(f.scope.root.join("main")).unwrap(),
            b"agent edit\n"
        );
        assert!(f.node.checkpoints.as_ref().unwrap().enabled(&workspace.id));
        let recovery_mode = f.node.workspace_mode(&workspace).unwrap();
        assert!(!recovery_mode.workspace_memory);
        let recovery_session = f
            .node
            .db
            .lock()
            .get_session(first["session"]["id"].as_str().unwrap())
            .unwrap();
        // The new host-authorized memory path must obey the recovery mode,
        // even if an agent calls workspace RPCs directly instead of its tools.
        let denied = crate::workspace_memory::scope(
            &f.node,
            &recovery_session.id,
            &recovery_mode,
            recovery_session.runner_epoch,
            true,
        )
        .err()
        .expect("recovery must not acquire repository memory authority");
        assert_eq!(denied.code, "forbidden");
        assert_eq!(denied.message, "This mode cannot access repository memory");
        // Own-session history remains available to handoff compression/search.
        let history = crate::workspace_memory::scope(
            &f.node,
            &recovery_session.id,
            &recovery_mode,
            recovery_session.runner_epoch,
            false,
        )
        .unwrap();
        assert_eq!(history.caller, recovery_session.id);
        assert!(history.key.is_empty());
        assert!(
            f.node
                .db
                .lock()
                .get_workspace_trust(&workspace.id)
                .unwrap()
                .is_none()
        );
        fs::write(root.join("main"), b"user modified recovery").unwrap();
        fs::write(f.scope.root.join("main"), b"later original change").unwrap();
        let ticket = super::super::continuation::runner_ticket(&f.node, &workspace, "owner")
            .await
            .unwrap()
            .unwrap();
        let prepared = f
            .node
            .sandbox
            .prepare(ticket.prepare_input(
                first["session"]["id"].as_str().unwrap().into(),
                f.config.sessions_dir.join("fresh"),
                None,
            ))
            .await
            .unwrap();
        assert!(!pirc_policy::write_allowed(
            &prepared.policy.paths,
            f.scope.root.join("main").to_str().unwrap()
        ));
        assert!(pirc_policy::write_allowed(
            &prepared.policy.paths,
            root.join("main").to_str().unwrap()
        ));
        prepared.cleanup();
        drop(ticket);
        assert_eq!(
            fs::read(root.join("main")).unwrap(),
            b"user modified recovery"
        );
        assert_eq!(
            fs::read(f.scope.root.join("main")).unwrap(),
            b"later original change"
        );
        let denied = f
            .request(
                HttpMethod::Post,
                "/api/sessions".into(),
                Some(json!({"workspaceId":workspace.id})),
                "other",
            )
            .await;
        assert_eq!(denied.status, 404);
        let denied = f
            .request(
                HttpMethod::Get,
                format!("/api/workspaces/{}/project-config", workspace.id),
                None,
                "other",
            )
            .await;
        assert_eq!(denied.status, 404);
        let adopted_session = first["session"]["id"].as_str().unwrap();
        {
            let db = f.node.db.lock();
            db.begin_session_deletion(adopted_session, "owner").unwrap();
            db.finish_session_deletion(adopted_session).unwrap();
        }
        assert_eq!(
            fs::read(root.join("main")).unwrap(),
            b"user modified recovery"
        );
        let no_resurrection = f
            .continue_job(&job, job["revision"].as_i64().unwrap())
            .await;
        assert_eq!(no_resurrection.status, 404);
        f.node.close().await;
    }
    #[tokio::test]
    async fn owner_scoped_files_and_missing_or_superseded_control_fail_without_mutation() {
        let f = Fixture::new().await;
        let listed = f
            .request(
                HttpMethod::Get,
                format!("/api/sessions/{}/checkpoints", f.session.id),
                None,
                "owner",
            )
            .await;
        assert_eq!(listed.status, 200);
        assert_eq!(
            listed.body.unwrap()["captures"][0]["operations"][0]["id"],
            f.operation
        );
        let other = f
            .request(
                HttpMethod::Get,
                format!("/api/sessions/{}/checkpoints", f.session.id),
                None,
                "other",
            )
            .await;
        assert!(other.status == 403 || other.status == 404);
        let file = f
            .request(
                HttpMethod::Get,
                format!("{}/file?operation={}&side=before", f.base(), f.operation),
                None,
                "owner",
            )
            .await;
        assert_eq!(file.status, 200);
        assert_eq!(file.body.unwrap()["text"], "user baseline\r\n");
        let forged = f
            .request(
                HttpMethod::Post,
                format!("{}/preview", f.base()),
                Some(json!({"operations":[f.operation],"reviewObservational":true,"root":"/"})),
                "owner",
            )
            .await;
        assert_eq!(forged.status, 400);
        let job = f.prepare("one").await;
        let _ = f
            .node
            .db
            .lock()
            .acquire_lease(&f.session.id, "web", true, 300_000)
            .unwrap();
        let response = f
            .continue_job(&job, job["revision"].as_i64().unwrap())
            .await;
        assert_eq!(response.status, 409);
        assert_eq!(
            f.node
                .db
                .lock()
                .query_row("SELECT COUNT(*) FROM checkpoint_workspaces", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            fs::read(f.scope.root.join("main")).unwrap(),
            b"agent edit\n"
        );
        f.node.close().await;
    }
    #[tokio::test]
    async fn durable_mapping_and_source_local_policy_survive_node_restart() {
        let f = Fixture::new().await;
        let job = f.prepare("one").await;
        let response = f
            .continue_job(&job, job["revision"].as_i64().unwrap())
            .await;
        assert_eq!(response.status, 200, "{:?}", response.body);
        let result = response.body.unwrap();
        let workspace_id = result["workspace"]["id"].as_str().unwrap().to_owned();
        let Fixture {
            dir,
            node,
            config,
            env,
            session,
            scope,
            operation,
            capture,
            generation: _,
        } = f;
        node.close().await;
        drop(node);
        tokio::task::yield_now().await;
        let node = crate::services::Services::start(config.clone(), env.clone())
            .await
            .unwrap();
        node.replace_modes(vec![pirc_protocol::mode::default_work()])
            .await;
        let generation = node
            .db
            .lock()
            .acquire_lease(&session.id, "phone", true, 300_000)
            .unwrap()
            .generation;
        let f = Fixture {
            dir,
            node,
            config,
            env,
            session,
            scope,
            operation,
            capture,
            generation,
        };
        let again = f
            .continue_job(&job, job["revision"].as_i64().unwrap())
            .await;
        assert_eq!(again.status, 200, "{:?}", again.body);
        assert_eq!(
            again.body.unwrap()["session"]["id"],
            result["session"]["id"]
        );
        let workspace = f.node.db.lock().get_workspace(&workspace_id).unwrap();
        assert!(f.node.workspace_mode(&workspace).is_ok());
        assert!(f.node.checkpoints.as_ref().unwrap().enabled(&workspace_id));
        assert!(
            super::super::continuation::runner_ticket(&f.node, &workspace, "owner")
                .await
                .is_ok()
        );
        f.node.close().await;
        let config = f.config.clone();
        let disabled = Env::new(
            f.env
                .vars()
                .filter(|(name, _)| *name != "PIRC_CHECKPOINT_WORKSPACES"),
            f.dir.path(),
        );
        drop(f.node);
        tokio::task::yield_now().await;
        let node = crate::services::Services::start(config, disabled)
            .await
            .unwrap();
        node.replace_modes(vec![pirc_protocol::mode::default_work()])
            .await;
        assert!(!node.checkpoints.as_ref().unwrap().enabled(&workspace_id));
        assert!(
            super::super::continuation::runner_ticket(&node, &workspace, "owner")
                .await
                .unwrap()
                .is_some()
        );
        node.close().await;
    }
}

#[cfg(test)]
mod interrupted_tests {
    use super::*;
    #[test]
    fn newer_confirmations_can_resume_an_unadopted_intent_without_poisoning_it() {
        let db = crate::store::Db::memory();
        let root = tempfile::tempdir().unwrap();
        let scope = Scope {
            node: "n".into(),
            owner: "owner".into(),
            workspace: "w".into(),
            session: "source".into(),
            epoch: 1,
            run: "r".into(),
            root: root.path().into(),
            device: 0,
            inode: 0,
            policy: Default::default(),
        }
        .bind_root()
        .unwrap();
        super::super::continuation::intent(
            &db.lock(),
            "job",
            "owner",
            "source",
            "capture",
            2,
            2,
            false,
            &scope,
        )
        .unwrap();
        assert!(
            super::super::continuation::intent(
                &db.lock(),
                "job",
                "owner",
                "source",
                "capture",
                1,
                3,
                true,
                &scope
            )
            .is_err()
        );
        super::super::continuation::intent(
            &db.lock(),
            "job",
            "owner",
            "source",
            "capture",
            3,
            3,
            true,
            &scope,
        )
        .unwrap();
        super::super::continuation::intent(
            &db.lock(),
            "job",
            "owner",
            "source",
            "capture",
            3,
            4,
            true,
            &scope,
        )
        .unwrap();
        assert!(
            super::super::continuation::intent(
                &db.lock(),
                "job",
                "other",
                "source",
                "capture",
                4,
                4,
                true,
                &scope
            )
            .is_err()
        );
    }
}
