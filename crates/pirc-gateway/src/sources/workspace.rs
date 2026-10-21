//! A workspace as a source (plans/rewrite/08-nodes.md's `workspace.read`):
//! once a day its node is asked for the latest commits, and those since
//! the last poll's head are what changed. Its node must be online; the
//! request goes as the source's owner.

use serde_json::{Value, json};

use super::store::{NewItem, Source};
use super::{Polled, SourceError, clip};
use crate::app::AppState;

const COMMITS: u64 = 20;

/// A workspace source's configuration from the API: `{workspace}`.
pub fn configure(app: &AppState, config: &Value) -> Result<Value, String> {
    let reference = config
        .get("workspace")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .ok_or("`workspace` is required")?;
    let workspace = crate::dispatch::resolve_directory_workspace(app, reference)
        .map_err(|error| error.message)?;
    Ok(json!({ "workspace": workspace.id, "workspaceName": workspace.display_name }))
}

async fn commits(app: &AppState, source: &Source, n: u64) -> Result<Vec<Value>, SourceError> {
    let reference = source.config_str("workspace").unwrap_or_default();
    let workspace = crate::brain::readable_workspace(app, reference)
        .map_err(|error| SourceError::new(error.message))?;
    let url = format!(
        "/api/workspaces/{}/read",
        crate::routes::urlencoding_component(workspace.local_id().unwrap_or_default())
    );
    let answer = crate::dispatch::node_request(
        app,
        &workspace.host_id,
        &source.owner,
        pirc_protocol::HttpMethod::Post,
        url,
        Some(json!({ "op": "git_log", "n": n })),
    )
    .await
    .map_err(|failure| SourceError::new(failure.0))?;
    Ok(answer
        .get("commits")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default())
}

fn item(commit: &Value) -> Option<NewItem> {
    let sha = commit.get("sha")?.as_str()?;
    let subject = commit
        .get("subject")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let author = commit
        .get("author")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let short = commit
        .get("short")
        .and_then(Value::as_str)
        .unwrap_or(&sha[..sha.len().min(7)]);
    Some(NewItem {
        external_id: format!("commit:{sha}"),
        kind: "commit",
        title: clip(subject, 300),
        who: Some(author.to_owned()).filter(|author| !author.is_empty()),
        at: commit
            .get("time")
            .and_then(Value::as_f64)
            .map(|time| time as i64),
        summary: clip(&format!("{author}: {subject} ({short})"), 600),
        url: None,
    })
}

pub async fn poll(app: &AppState, source: &Source) -> Result<Polled, SourceError> {
    let found = commits(app, source, COMMITS).await?;
    let head = source
        .cursor
        .as_ref()
        .and_then(|cursor| cursor.get("head"))
        .and_then(Value::as_str);
    let mut items = Vec::new();
    for commit in &found {
        if commit.get("sha").and_then(Value::as_str) == head {
            break;
        }
        items.extend(item(commit));
    }
    if head.is_none() {
        items.truncate(5);
    }
    let newest = found
        .first()
        .and_then(|commit| commit.get("sha"))
        .and_then(Value::as_str)
        .or(head);
    Ok(Polled {
        baseline: source.cursor.is_none(),
        cursor: json!({ "head": newest }),
        items,
        removed: Vec::new(),
    })
}

pub async fn test(app: &AppState, source: &Source) -> Result<String, SourceError> {
    let found = commits(app, source, 1).await?;
    Ok(match found.first().and_then(item) {
        Some(item) => format!("Latest commit: {}", item.summary),
        None => "No commits yet".to_owned(),
    })
}
