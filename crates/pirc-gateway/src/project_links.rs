//! Links from a chat project to the directory workspaces it is about
//! (docs/history/assistant.md). A link is a default and an ordering, never a
//! permission: every delegation still needs the user's confirmation, and an
//! unlinked workspace stays reachable.
//!
//! - `assistant.context` lists linked workspaces first, and the other
//!   clones of their repositories after them.
//! - `delegate` without a workspace goes to the only linked one.
//! - `memory_search` without a workspace looks in the linked workspaces
//!   (and their clones) first.
//!
//! Only the user edits links, through the authenticated web routes; there is
//! no agent operation for them.

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

use crate::app::App;
use crate::db::{Store as _, Workspace, atomic};
use crate::dispatch::workspace_online;
use crate::error::{ApiError, ApiResult};
use crate::util::now_ms;

/// More than a project is plausibly about; it keeps the context short.
pub const MAX_LINKS: usize = 20;

/// One linked workspace as stored.
#[derive(Clone, Debug, PartialEq)]
pub struct Link {
    pub workspace_id: String,
    /// The workspace's normalized `origin` when linked (or learnt later).
    pub repo: Option<String>,
    pub created_at: i64,
}

/// How a workspace relates to a project's links.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Linked {
    /// Linked itself.
    Workspace,
    /// Another clone of a linked workspace's repository.
    Repository,
}

impl Linked {
    pub fn name(self) -> &'static str {
        match self {
            Self::Workspace => "workspace",
            Self::Repository => "repository",
        }
    }
}

/// A chat project: a chat workspace other than a node's top-level chats.
pub fn is_project(workspace: &Workspace) -> bool {
    workspace.kind.mode().projects && workspace.local_id().is_some_and(|id| id != "chats")
}

fn require_project(conn: &Connection, project_id: &str) -> ApiResult<Workspace> {
    let project = conn.get_workspace(project_id)?;
    if !is_project(&project) {
        return Err(ApiError::new(
            400,
            "invalid_input",
            "Only chat projects can be linked to workspaces",
        ));
    }
    Ok(project)
}

/// A project's links, oldest first; none for anything that is not a project.
pub fn links(conn: &Connection, project_id: &str) -> ApiResult<Vec<Link>> {
    let mut statement = conn.prepare(
        "SELECT workspace_id, repo, created_at FROM project_links WHERE project_workspace_id=? ORDER BY created_at, workspace_id",
    )?;
    let rows = statement.query_map([project_id], |row| {
        Ok(Link {
            workspace_id: row.get(0)?,
            repo: row.get(1)?,
            created_at: row.get(2)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Replace a project's links with `workspace_ids` (directory workspaces).
/// Links kept keep their creation time; the repository is the one known now.
pub fn set_links(
    conn: &Connection,
    project_id: &str,
    workspace_ids: &[String],
) -> ApiResult<Vec<Link>> {
    require_project(conn, project_id)?;
    let mut wanted: Vec<Workspace> = Vec::new();
    for id in workspace_ids {
        if wanted.iter().any(|workspace| &workspace.id == id) {
            continue;
        }
        let workspace = conn
            .query_row(
                "SELECT * FROM workspaces WHERE id=?",
                [id],
                Workspace::from_row,
            )
            .optional()?
            .filter(|workspace| workspace.kind.mode().repository && workspace.local_id().is_some())
            .ok_or_else(|| {
                ApiError::new(
                    400,
                    "invalid_input",
                    format!("{id} is not a directory workspace"),
                )
            })?;
        wanted.push(workspace);
    }
    if wanted.len() > MAX_LINKS {
        return Err(ApiError::new(
            400,
            "invalid_input",
            format!("A project links at most {MAX_LINKS} workspaces"),
        ));
    }
    let kept: Vec<&str> = wanted
        .iter()
        .map(|workspace| workspace.id.as_str())
        .collect();
    atomic(conn, |tx| {
        for link in links(tx, project_id)? {
            if !kept.contains(&link.workspace_id.as_str()) {
                tx.execute(
                    "DELETE FROM project_links WHERE project_workspace_id=? AND workspace_id=?",
                    params![project_id, link.workspace_id],
                )?;
            }
        }
        let at = now_ms();
        for workspace in &wanted {
            tx.execute(
                "INSERT INTO project_links (project_workspace_id,workspace_id,repo,created_at) VALUES (?,?,?,?) ON CONFLICT(project_workspace_id,workspace_id) DO UPDATE SET repo=COALESCE(excluded.repo, project_links.repo)",
                params![project_id, workspace.id, workspace.repo, at],
            )?;
        }
        links(tx, project_id)
    })
}

/// The repositories a project's links cover: each link's, and its
/// workspace's current one.
pub fn repos(conn: &Connection, links: &[Link]) -> ApiResult<Vec<String>> {
    let mut repos: Vec<String> = Vec::new();
    for link in links {
        let current: Option<String> = conn
            .query_row(
                "SELECT repo FROM workspaces WHERE id=?",
                [&link.workspace_id],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        for repo in [link.repo.clone(), current].into_iter().flatten() {
            if !repos.contains(&repo) {
                repos.push(repo);
            }
        }
    }
    Ok(repos)
}

/// How `workspace` relates to the links (and the repositories they cover).
pub fn linked(links: &[Link], repos: &[String], workspace: &Workspace) -> Option<Linked> {
    if links.iter().any(|link| link.workspace_id == workspace.id) {
        Some(Linked::Workspace)
    } else if workspace
        .repo
        .as_ref()
        .is_some_and(|repo| repos.contains(repo))
    {
        Some(Linked::Repository)
    } else {
        None
    }
}

/// Whether a workspace's node is connected but no longer reports it.
pub fn removed(app: &App, workspace: &Workspace) -> bool {
    app.nodes.get(&workspace.host_id).is_some() && !workspace_online(app, workspace)
}

/// `GET`/`PUT /api/workspaces/:id/links`: each link with what is known of
/// its workspace now.
pub fn view(app: &App, links: &[Link]) -> ApiResult<Value> {
    let conn = app.db.lock();
    let mut out = Vec::new();
    for link in links {
        let workspace = conn
            .query_row(
                "SELECT * FROM workspaces WHERE id=?",
                [&link.workspace_id],
                Workspace::from_row,
            )
            .optional()?;
        let mut item = json!({
            "workspaceId": link.workspace_id,
            "repo": link.repo,
            "createdAt": link.created_at,
        });
        match workspace {
            Some(workspace) => {
                item["name"] = json!(workspace.display_name);
                item["node"] = json!(workspace.host_id);
                item["online"] = json!(workspace_online(app, &workspace));
                item["removed"] = json!(removed(app, &workspace));
                if workspace.repo.is_some() {
                    item["repo"] = json!(workspace.repo);
                }
            }
            None => {
                item["online"] = json!(false);
                item["removed"] = json!(true);
            }
        }
        out.push(item);
    }
    Ok(json!({ "links": out }))
}

/// Read a project's links, refusing anything that is not a project.
pub fn project_links(conn: &Connection, project_id: &str) -> ApiResult<Vec<Link>> {
    require_project(conn, project_id)?;
    links(conn, project_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{Db, WorkspaceKind};

    fn db() -> Db {
        let db = Db::memory();
        {
            let conn = db.lock();
            conn.sync_remote_workspaces(
                "home",
                &[
                    ("chats".into(), "Chats".into(), Some(WorkspaceKind::Chat)),
                    ("trip".into(), "Trip".into(), Some(WorkspaceKind::Chat)),
                ],
            )
            .unwrap();
            conn.sync_remote_workspaces(
                "work",
                &[
                    ("pirc".into(), "pirc".into(), None),
                    ("site".into(), "site".into(), None),
                ],
            )
            .unwrap();
            conn.sync_remote_workspaces("lab", &[("clone".into(), "pirc".into(), None)])
                .unwrap();
        }
        db
    }

    fn ids(links: &[Link]) -> Vec<&str> {
        links
            .iter()
            .map(|link| link.workspace_id.as_str())
            .collect()
    }

    #[test]
    fn only_projects_link_directory_workspaces() {
        let db = db();
        let conn = db.lock();
        let set = |project: &str, ids: &[&str]| {
            set_links(
                &conn,
                project,
                &ids.iter().map(|id| (*id).to_owned()).collect::<Vec<_>>(),
            )
        };
        assert_eq!(set("home:chats", &["work:pirc"]).unwrap_err().status, 400);
        assert_eq!(set("work:pirc", &["work:site"]).unwrap_err().status, 400);
        assert_eq!(set("home:trip", &["home:chats"]).unwrap_err().status, 400);
        assert_eq!(set("home:trip", &["work:nope"]).unwrap_err().status, 400);
        assert_eq!(set("home:nope", &["work:pirc"]).unwrap_err().status, 404);
        assert!(project_links(&conn, "home:chats").is_err());
        assert!(links(&conn, "home:trip").unwrap().is_empty());

        let first = set("home:trip", &["work:pirc", "work:site", "work:pirc"]).unwrap();
        assert_eq!(ids(&first), ["work:pirc", "work:site"]);
        // Replacing keeps the links that stay, with their creation time.
        conn.execute(
            "UPDATE project_links SET created_at=1 WHERE workspace_id='work:site'",
            [],
        )
        .unwrap();
        let second = set("home:trip", &["work:site", "lab:clone"]).unwrap();
        assert_eq!(ids(&second), ["work:site", "lab:clone"]);
        assert_eq!(second[0].created_at, 1);
        assert!(set("home:trip", &[]).unwrap().is_empty());

        let many: Vec<String> = (0..=MAX_LINKS).map(|n| format!("work:w{n}")).collect();
        for id in &many {
            conn.sync_remote_workspaces("work", &[(id[5..].to_owned(), id.clone(), None)])
                .unwrap();
        }
        assert_eq!(
            set_links(&conn, "home:trip", &many).unwrap_err().status,
            400
        );
        assert_eq!(
            set_links(&conn, "home:trip", &many[..MAX_LINKS])
                .unwrap()
                .len(),
            MAX_LINKS
        );
    }

    #[test]
    fn a_link_covers_the_clones_of_its_repository() {
        let db = db();
        let conn = db.lock();
        // Linked before its node reported the repository.
        set_links(&conn, "home:trip", &["work:pirc".to_owned()]).unwrap();
        assert_eq!(links(&conn, "home:trip").unwrap()[0].repo, None);
        conn.set_workspace_repos(
            "work",
            &[("pirc".into(), Some("github.com/me/pirc".into()))],
        )
        .unwrap();
        conn.set_workspace_repos(
            "lab",
            &[("clone".into(), Some("github.com/me/pirc".into()))],
        )
        .unwrap();
        let stored = links(&conn, "home:trip").unwrap();
        assert_eq!(stored[0].repo.as_deref(), Some("github.com/me/pirc"));
        let repos = repos(&conn, &stored).unwrap();
        assert_eq!(repos, ["github.com/me/pirc"]);
        let of = |id: &str| linked(&stored, &repos, &conn.get_workspace(id).unwrap());
        assert_eq!(of("work:pirc"), Some(Linked::Workspace));
        assert_eq!(of("lab:clone"), Some(Linked::Repository));
        assert_eq!(of("work:site"), None);
    }

    /// A chat workspace has no repository: a key a node reports for one
    /// tags neither the workspace nor links or notes stored under its id.
    #[test]
    fn a_repository_reported_for_a_chat_workspace_is_ignored() {
        let db = db();
        let conn = db.lock();
        // A link stored under a workspace id the node now reports as a chat.
        conn.execute(
            "INSERT INTO project_links (project_workspace_id,workspace_id,repo,created_at) VALUES ('home:chats','home:trip',NULL,1)",
            [],
        )
        .unwrap();
        conn.set_workspace_repos(
            "home",
            &[("trip".into(), Some("github.com/me/pirc".into()))],
        )
        .unwrap();
        assert_eq!(conn.get_workspace("home:trip").unwrap().repo, None);
        assert_eq!(links(&conn, "home:chats").unwrap()[0].repo, None);
    }
}
