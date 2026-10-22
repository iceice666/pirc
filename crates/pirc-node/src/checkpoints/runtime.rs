//! Runner capture opt-in and durable recovery service; no agent-chosen roots.
use super::{Journal, Limits, Scope};
use crate::runner::Runner;
use crate::services::Node;
use pirc_config::{Env, NodeConfig};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::path::Path;
use std::sync::Arc;

pub struct CaptureService {
    pub journal: Arc<Journal>,
    enabled: BTreeSet<String>,
    inherited: std::sync::RwLock<BTreeSet<String>>,
    pub(super) continuation_gate: tokio::sync::Mutex<()>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Begin {
    path: String,
    tool: String,
    expected: Option<String>,
}

impl CaptureService {
    pub fn configured(config: &NodeConfig, env: &Env) -> Result<Option<Arc<Self>>, String> {
        let value = env.get("PIRC_CHECKPOINT_WORKSPACES").unwrap_or("[]");
        let enabled: BTreeSet<String> = serde_json::from_str(value).map_err(|_| {
            "PIRC_CHECKPOINT_WORKSPACES must be a JSON array of workspace ids".to_owned()
        })?;
        if enabled.len() > 1000 || enabled.iter().any(|s| s.is_empty() || s.len() > 200) {
            return Err("invalid checkpoint workspace ids".into());
        }
        // Disabling future capture must not strand already adopted workspaces.
        // A fresh opt-out still creates no store; existing private journals keep
        // their recovery execution authority and retained evidence available.
        if enabled.is_empty()
            && !config
                .state_dir
                .join("checkpoints/index.sqlite")
                .try_exists()
                .map_err(super::err)?
        {
            return Ok(None);
        }
        Ok(Some(Arc::new(Self {
            journal: Arc::new(Journal::open(&config.state_dir, Limits::default())?),
            enabled,
            inherited: Default::default(),
            continuation_gate: tokio::sync::Mutex::new(()),
        })))
    }

    /// Trusted node handoff only; agent checkpoint RPCs cannot prepare/claim.
    pub fn recovery_factory(
        &self,
        limits: super::recovery::CopyLimits,
    ) -> Result<super::recovery::RecoveryFactory, String> {
        super::recovery::RecoveryFactory::new(self.journal.clone(), limits)
    }

    pub(super) fn inherit(&self, id: &str, source: &str) {
        if self.enabled(source) {
            self.inherited
                .write()
                .unwrap_or_else(|e| e.into_inner())
                .insert(id.into());
        }
    }
    pub(crate) fn load_inherited(&self, db: &rusqlite::Connection) -> crate::error::ApiResult<()> {
        let mut statement=db.prepare("SELECT w.workspace_id,i.scope_json FROM checkpoint_workspaces w JOIN checkpoint_intents i ON i.job=w.job")?;
        let rows: Vec<(String, String)> = statement
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        let mut pending = rows;
        loop {
            let before = pending.len();
            pending.retain(|(id, json)| {
                let Ok(scope) = serde_json::from_str::<super::Scope>(json) else {
                    return true;
                };
                if self.enabled(&scope.workspace) {
                    self.inherit(id, &scope.workspace);
                    false
                } else {
                    true
                }
            });
            if pending.len() == before {
                break;
            }
        }
        Ok(())
    }

    pub fn enabled(&self, workspace: &str) -> bool {
        self.enabled.contains(workspace)
            || self
                .inherited
                .read()
                .unwrap_or_else(|e| e.into_inner())
                .contains(workspace)
    }

    pub(crate) async fn maintenance(self: Arc<Self>, mut stop: tokio::sync::watch::Receiver<bool>) {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(3600));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        interval.tick().await; // startup already swept synchronously
        loop {
            if *stop.borrow() {
                return;
            }
            tokio::select! {
                changed=stop.changed()=>{if changed.is_err() || *stop.borrow() {return;}},
                _=interval.tick()=>{
                    let service=self.clone();
                    if let Ok(Err(error))=tokio::task::spawn_blocking(move||service.journal.sweep()).await {crate::log::error(&error);}
                }
            }
        }
    }

    pub(crate) fn start(&self, node: &Node, runner: &Runner) -> Result<(), String> {
        let scope = runner.checkpoint_scope(node)?;
        if !self.enabled(&scope.workspace) {
            return Ok(());
        }
        self.journal.start(&scope)
    }

    pub(crate) fn note(&self, node: &Node, runner: &Runner, tool: &str) -> Result<(), String> {
        let scope = runner.checkpoint_scope(node)?;
        if !self.enabled(&scope.workspace) {
            return Ok(());
        }
        self.journal.note_uncovered(&scope, tool)
    }

    pub(crate) async fn request(
        self: Arc<Self>,
        node: Node,
        runner: Arc<Runner>,
        op: String,
        args: Value,
    ) -> Result<Value, String> {
        let mut scope = runner.checkpoint_scope(&node)?;
        if !self.enabled(&scope.workspace) {
            return Err("checkpoint capture is disabled for this workspace".into());
        }
        let path = match op.as_str() {
            "checkpoint.begin" => {
                let request: Begin = serde_json::from_value(args.clone())
                    .map_err(|_| "invalid checkpoint begin arguments")?;
                if !matches!(request.tool.as_str(), "write" | "edit")
                    || request
                        .expected
                        .as_deref()
                        .is_some_and(|h| !super::valid_hash(h))
                {
                    return Err("invalid checkpoint file operation".into());
                }
                Path::new(&request.path).to_path_buf()
            }
            "checkpoint.finish" => self.journal.operation_path(
                &scope,
                args.get("operation")
                    .and_then(Value::as_str)
                    .ok_or("missing checkpoint operation")?,
            )?,
            _ => return Err("unknown local checkpoint operation".into()),
        };
        if op == "checkpoint.begin" && !path.starts_with(&scope.root) {
            if !path.is_absolute()
                || path.as_os_str().len() > 4096
                || path.components().any(|c| {
                    matches!(
                        c,
                        std::path::Component::ParentDir | std::path::Component::CurDir
                    )
                })
            {
                return Err("invalid checkpoint file path".into());
            }
            // Keep explicitly allowed external writes working, without reading
            // outside this capture root or treating a response as a write grant.
            let guard =
                pirc_policy::PathGuard::new(&scope.root.to_string_lossy(), &scope.policy, &[]);
            guard.resolve(&path.to_string_lossy(), true)?;
            let service = self.clone();
            tokio::task::spawn_blocking(move || {
                service
                    .journal
                    .note_uncovered(&scope, "file_tool_outside_workspace")
            })
            .await
            .map_err(|_| "checkpoint worker failed")??;
            return Ok(json!({"excluded":"outside_workspace","operation":null}));
        }
        let relative = super::files::relative(&scope, &path)?;
        if std::fs::symlink_metadata(scope.root.join(".git")).is_ok() {
            let env = pirc_config::env_allowlist::without_secrets(&node.env, &[]);
            let eligible = crate::panels::inspect::checkpoint_eligible(
                node.sandbox.as_ref(),
                &scope.root,
                &relative,
                &env,
            )
            .await
            .map_err(|e| e.message)?;
            if !eligible {
                scope
                    .policy
                    .deny_read
                    .push(path.to_string_lossy().into_owned());
            }
        }
        // Sandbox classification can yield; recheck runner authority afterward.
        let current = runner.checkpoint_scope(&node)?;
        if current.run != scope.run
            || current.owner != scope.owner
            || current.epoch != scope.epoch
            || current.root != scope.root
            || current.device != scope.device
            || current.inode != scope.inode
        {
            return Err("checkpoint scope changed during classification".into());
        }
        tokio::task::spawn_blocking(move || self.perform(&scope, &op, args))
            .await
            .map_err(|_| "checkpoint worker failed".to_owned())?
    }

    fn perform(&self, scope: &Scope, op: &str, args: Value) -> Result<Value, String> {
        if op == "checkpoint.begin" {
            let request: Begin =
                serde_json::from_value(args).map_err(|_| "invalid checkpoint begin arguments")?;
            let operation = self.journal.begin(
                scope,
                Path::new(&request.path),
                &request.tool,
                request.expected.as_deref(),
            )?;
            Ok(json!({"operation":operation,"coverage":"observational"}))
        } else if op == "checkpoint.finish" {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Finish {
                operation: String,
                succeeded: bool,
            }
            let request: Finish =
                serde_json::from_value(args).map_err(|_| "invalid checkpoint finish arguments")?;
            if request.operation.len() > 100 {
                return Err("invalid checkpoint operation id".into());
            }
            self.journal
                .finish(scope, &request.operation, request.succeeded)?;
            Ok(json!({"recorded":true}))
        } else {
            Err("unknown local checkpoint operation".into())
        }
    }

    pub(crate) fn seal(
        self: &Arc<Self>,
        session: String,
        epoch: i64,
        run: Option<String>,
        interrupted: bool,
    ) {
        let service = self.clone();
        tokio::task::spawn_blocking(move || {
            if let Err(error) = service
                .journal
                .seal(&session, epoch, run.as_deref(), interrupted)
            {
                crate::log::error(&error);
            }
        });
    }
}
