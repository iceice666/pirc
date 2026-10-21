//! Choosing a machine for a worker (plans/rewrite/08-nodes.md): its
//! workspace when the brain names one, else the scratch workspace of a
//! machine that fits. Nodes say what they can do when they register
//! (`Capabilities`); that is a fact to choose by, never a permission.
//!
//! Among the workspaces that could take the task: those on a machine the
//! `node_hint` names (its id, or its OS: "mac", "linux"), with a GPU its
//! sandbox reaches when the task needs one; then online before offline,
//! idle (fewer agents running than it means to run) before busy, in the
//! order the gateway lists them.

use crate::app::App;
use crate::db::{Store as _, Workspace};
use crate::dispatch::workspace_online;
use crate::error::{ApiError, ApiResult};

/// What the brain asked of the machine.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Hint {
    /// "mac", "linux", a node's id or part of it.
    pub node: Option<String>,
    /// The task needs a GPU (in the sandbox).
    pub gpu: bool,
}

/// Whether node `node_id`, with what it said it can do, matches `hint`.
fn fits(app: &App, node_id: &str, hint: &Hint) -> bool {
    let caps = app.nodes.get(node_id).and_then(|node| node.capabilities);
    if hint.gpu && !caps.as_ref().is_some_and(|caps| caps.sandbox.gpu) {
        return false;
    }
    let Some(wanted) = hint
        .node
        .as_deref()
        .map(str::trim)
        .filter(|w| !w.is_empty())
    else {
        return true;
    };
    let wanted = wanted.to_lowercase();
    if node_id.to_lowercase().contains(&wanted) {
        return true;
    }
    let os = caps
        .as_ref()
        .map(|caps| caps.os.as_str())
        .unwrap_or_default();
    let named = match wanted.as_str() {
        "mac" | "macos" | "macbook" | "darwin" | "osx" | "apple" => "macos",
        "linux" => "linux",
        "windows" | "wsl" => "windows",
        other => other,
    };
    !os.is_empty() && os == named
}

/// Idle: online with fewer agents running than it means to run.
fn idle(app: &App, node_id: &str) -> bool {
    app.nodes.get(node_id).is_some_and(|node| {
        node.capabilities
            .as_ref()
            .is_none_or(|caps| node.running < caps.max_running as usize)
    })
}

/// The best of `candidates` for `hint`, or why none fits.
pub fn pick(app: &App, candidates: Vec<Workspace>, hint: &Hint) -> ApiResult<Workspace> {
    let mut fitting: Vec<Workspace> = candidates
        .into_iter()
        .filter(|workspace| fits(app, &workspace.host_id, hint))
        .collect();
    // Stable: online and idle, online, then the rest.
    fitting.sort_by_key(|workspace| {
        match (
            workspace_online(app, workspace),
            idle(app, &workspace.host_id),
        ) {
            (true, true) => 0,
            (true, false) => 1,
            _ => 2,
        }
    });
    fitting.into_iter().next().ok_or_else(|| {
        let mut wanted = Vec::new();
        if let Some(node) = &hint.node {
            wanted.push(format!("on {node}"));
        }
        if hint.gpu {
            wanted.push("with a GPU its sandbox can use".to_owned());
        }
        ApiError::new(
            404,
            "not_found",
            format!(
                "No machine fits{}; say so in the room",
                if wanted.is_empty() {
                    String::new()
                } else {
                    format!(" ({})", wanted.join(", "))
                }
            ),
        )
    })
}

/// The workspaces a worker can be sent to (delegate targets on a node).
fn targets(app: &App) -> ApiResult<Vec<Workspace>> {
    Ok(app
        .db
        .lock()
        .list_workspaces()?
        .into_iter()
        .filter(|workspace| {
            app.mode(&workspace.mode)
                .is_some_and(|mode| mode.delegate_target)
                && workspace.id.contains(':')
        })
        .collect())
}

/// Where a new worker goes: `reference` (a workspace id, a name, or
/// `scratch`), or a scratch workspace when it names none; several of the
/// same name are chosen among by `hint`.
pub fn choose(app: &App, reference: Option<&str>, hint: &Hint) -> ApiResult<Workspace> {
    let reference = reference.map(str::trim).filter(|r| !r.is_empty());
    let all = targets(app)?;
    let scratch = |all: Vec<Workspace>| -> Vec<Workspace> {
        all.into_iter()
            .filter(|workspace| workspace.mode.as_str() == pirc_config::node::SCRATCH)
            .collect()
    };
    match reference {
        None | Some("scratch") => {
            let candidates = scratch(all);
            if candidates.is_empty() {
                return Err(ApiError::new(
                    404,
                    "not_found",
                    "No machine has a scratch workspace; name a workspace",
                ));
            }
            pick(app, candidates, hint)
        }
        Some(reference) => {
            if let Some(exact) = all.iter().find(|workspace| workspace.id == reference) {
                return Ok(exact.clone());
            }
            let lower = reference.to_lowercase();
            let named: Vec<Workspace> = all
                .iter()
                .filter(|workspace| workspace.display_name.to_lowercase() == lower)
                .cloned()
                .collect();
            if named.len() > 1 {
                return pick(app, named, hint);
            }
            crate::dispatch::resolve_directory_workspace(app, reference)
        }
    }
}
