//! Links from a face to the directory workspaces it is about (its
//! territory, plans/rewrite/10-faces.md; chat projects owned them before,
//! docs/architecture/assistant-memory.md). A link is a default and an
//! ordering, never a permission: an unlinked workspace stays reachable.
//!
//! - The brain's list of workspaces, as a face, has the face's linked
//!   workspaces first, and the other clones of their repositories after
//!   them.
//! - Memory search for a face looks in its linked workspaces (and their
//!   clones) first.

use rusqlite::{Connection, OptionalExtension};

use crate::app::App;
use crate::db::Workspace;
use crate::dispatch::workspace_online;
use crate::error::ApiResult;

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

/// A face's links, oldest first.
pub fn links(conn: &Connection, face_id: &str) -> ApiResult<Vec<Link>> {
    let mut statement = conn.prepare(
        "SELECT workspace_id, repo, created_at FROM project_links WHERE face_id=? ORDER BY created_at, workspace_id",
    )?;
    let rows = statement.query_map([face_id], |row| {
        Ok(Link {
            workspace_id: row.get(0)?,
            repo: row.get(1)?,
            created_at: row.get(2)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{Db, ModeId, Store as _};

    fn db() -> Db {
        let db = Db::memory();
        {
            let conn = db.lock();
            conn.sync_remote_workspaces(
                "home",
                &[(
                    "trip".into(),
                    "Trip".into(),
                    ModeId::new("project").unwrap(),
                )],
            )
            .unwrap();
            conn.sync_remote_workspaces(
                "work",
                &[
                    (
                        "pirc".into(),
                        "pirc".into(),
                        ModeId::new("directory").unwrap(),
                    ),
                    (
                        "site".into(),
                        "site".into(),
                        ModeId::new("directory").unwrap(),
                    ),
                ],
            )
            .unwrap();
            conn.sync_remote_workspaces(
                "lab",
                &[(
                    "clone".into(),
                    "pirc".into(),
                    ModeId::new("directory").unwrap(),
                )],
            )
            .unwrap();
        }
        db
    }

    #[test]
    fn a_link_covers_the_clones_of_its_repository() {
        let db = db();
        let conn = db.lock();
        // Linked before its node reported the repository.
        conn.execute(
            "INSERT INTO project_links (face_id,workspace_id,repo,created_at) VALUES ('host','work:pirc',NULL,1)",
            [],
        )
        .unwrap();
        assert_eq!(links(&conn, "host").unwrap()[0].repo, None);
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
        let stored = links(&conn, "host").unwrap();
        assert_eq!(stored[0].repo.as_deref(), Some("github.com/me/pirc"));
        let repos = repos(&conn, &stored).unwrap();
        assert_eq!(repos, ["github.com/me/pirc"]);
        let of = |id: &str| linked(&stored, &repos, &conn.get_workspace(id).unwrap());
        assert_eq!(of("work:pirc"), Some(Linked::Workspace));
        assert_eq!(of("lab:clone"), Some(Linked::Repository));
        assert_eq!(of("work:site"), None);
    }
}
