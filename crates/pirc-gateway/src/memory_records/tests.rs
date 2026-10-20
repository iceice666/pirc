//! `apps/gateway/test/memory-records.test.ts`.

use serde_json::{Value, json};

use super::*;
use crate::app::App;
use crate::util::sha256_hex;

const ME: &str = "me@example.com";
const OTHER: &str = "other@example.com";
const KEY: &str = "aaaaaaaaaaaaaaaa";
const OTHER_KEY: &str = "bbbbbbbbbbbbbbbb";

fn hash_id(content: &str) -> String {
    sha256_hex(content)[..12].to_owned()
}

/// Node sessions s1/s2 belong to me (a repository and its worktree), s3 to someone else.
fn setup() -> (std::sync::Arc<App>, tempfile::TempDir) {
    let (app, dir) = crate::memory::tests::app();
    {
        let conn = app.db.lock();
        conn.sync_remote_workspaces(
            "n1",
            &[
                (
                    "repo".into(),
                    "pirc".into(),
                    crate::db::ModeId::new("directory").unwrap(),
                ),
                (
                    "wt".into(),
                    "pirc-worktree".into(),
                    crate::db::ModeId::new("directory").unwrap(),
                ),
            ],
        )
        .unwrap();
        conn.create_session("n1:repo", "node://n1/s1", "n1", "s1", ME)
            .unwrap();
        conn.create_session("n1:wt", "node://n1/s2", "n1", "s2", ME)
            .unwrap();
        conn.create_session("n1:repo", "node://n1/s3", "n1", "s3", OTHER)
            .unwrap();
    }
    (app, dir)
}

fn item(content: &str, extra: Value) -> Value {
    let mut item = json!({
        "id": hash_id(content),
        "content": content,
        "relevance": "high",
        "timestamp": "2026-09-27 10:00",
        "sessionId": "s1",
        "sourceMemoryIds": ["aaaaaaaaaaaa"],
    });
    for (key, value) in extra.as_object().unwrap() {
        if value.is_null() {
            item.as_object_mut().unwrap().remove(key);
        } else {
            item[key] = value.clone();
        }
    }
    item
}

fn all(app: &App) -> Vec<String> {
    let conn = app.db.lock();
    let mut statement = conn
        .prepare("SELECT id, status, content, owner_user FROM memory_records")
        .unwrap();
    statement
        .query_map([], |row| {
            let id: String = row.get(0)?;
            let status: String = row.get(1)?;
            let content: String = row.get(2)?;
            let owner: Option<String> = row.get(3)?;
            Ok(format!(
                "{}:{status}:{}",
                if content.is_empty() { id } else { content },
                owner.unwrap_or_else(|| "-".into())
            ))
        })
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

/// Feed lines as the ledger's next chunk (offsets advance by 100 per chunk).
struct Feeder<'a> {
    app: &'a App,
    key: &'a str,
    offset: u64,
}

impl Feeder<'_> {
    fn feed(&mut self, lines: Value) {
        self.offset = ingest(
            self.app,
            "n1",
            self.key,
            self.offset,
            self.offset + 100,
            false,
            lines.as_array().unwrap(),
        )
        .unwrap();
    }
}

fn ids(hits: &[Value]) -> Vec<String> {
    hits.iter()
        .map(|hit| hit["id"].as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn lines_are_applied_like_the_fold_only_in_order() {
    let (app, _dir) = setup();
    let a = item("A note", json!({}));
    let b = item("B note", json!({ "sessionId": "s3" }));
    let c = item("C note", json!({ "sessionId": null }));
    let d = item("D note", json!({ "sessionId": "unknown" }));
    let feed = |offset, end, reset, lines: Value| {
        ingest(
            &app,
            "n1",
            KEY,
            offset,
            end,
            reset,
            lines.as_array().unwrap(),
        )
        .unwrap()
    };
    assert_eq!(
        feed(
            0,
            100,
            false,
            json!([{ "type": "recorded", "items": [a, b, c, d] }])
        ),
        100
    );
    // Owners come from the sessions that wrote the notes; unknown sessions have none.
    assert_eq!(
        all(&app),
        [
            format!("A note:active:{ME}"),
            format!("B note:active:{OTHER}"),
            "C note:active:-".into(),
            "D note:active:-".into(),
        ]
    );
    // A chunk that does not continue the stored part is ignored: the answer says where to resume.
    assert_eq!(feed(150, 200, false, json!([{ "type": "cleared" }])), 100);
    assert_eq!(feed(50, 200, false, json!([{ "type": "cleared" }])), 100);
    assert_eq!(all(&app).len(), 4);

    let mut changed = a.clone();
    changed["content"] = json!("A changed");
    feed(
        100,
        180,
        false,
        json!([
            { "type": "retired", "ids": [a["id"]], "reason": "superseded" },
            { "type": "retired", "ids": [b["id"], hash_id("never seen")], "reason": "forgotten" },
            // A forgotten note never comes back, and the first record of an id wins.
            { "type": "recorded", "items": [b, changed] },
            { "type": "bogus" },
            { "type": "recorded", "items": [{ "id": "not hex" }, item("E note", json!({}))] },
        ]),
    );
    assert_eq!(
        all(&app),
        [
            format!("A note:superseded:{ME}"),
            format!("{}:forgotten:{OTHER}", b["id"].as_str().unwrap()),
            "C note:active:-".into(),
            "D note:active:-".into(),
            format!("{}:forgotten:-", hash_id("never seen")),
            format!("E note:active:{ME}"),
        ]
    );

    // Clearing keeps only what was forgotten.
    feed(
        180,
        250,
        false,
        json!([{ "type": "cleared" }, { "type": "recorded", "items": [item("F note", json!({}))] }]),
    );
    assert_eq!(
        all(&app),
        [
            format!("{}:forgotten:{OTHER}", b["id"].as_str().unwrap()),
            format!("{}:forgotten:-", hash_id("never seen")),
            format!("F note:active:{ME}"),
        ]
    );
    assert_eq!(watermarks(&app, "n1"), json!({ KEY: 250 }));

    // A ledger that shrank starts over.
    assert_eq!(
        feed(
            0,
            40,
            true,
            json!([{ "type": "recorded", "items": [item("G note", json!({}))] }])
        ),
        40
    );
    assert_eq!(all(&app), [format!("G note:active:{ME}")]);
}

#[test]
fn notes_and_delegations_are_found_by_any_word_in_any_script() {
    let (app, _dir) = setup();
    let mut feed = Feeder {
        app: &app,
        key: KEY,
        offset: 0,
    };
    let deploy = item(
        "部署 uses nginx on lumo",
        json!({ "git": { "head": "abcdef123456", "branch": "main", "dirty": true } }),
    );
    let config = item(
        "The nginx config lives in nix/module.nix",
        json!({ "sessionId": "s2" }),
    );
    let theirs = item("lumo 部署 notes", json!({ "sessionId": "s3" }));
    let percent = item("100% of the tests pass", json!({}));
    feed.feed(json!([{ "type": "recorded", "items": [
        deploy, config, theirs, percent, item("unrelated", json!({})), item("1000 items", json!({})),
    ] }]));
    Feeder {
        app: &app,
        key: OTHER_KEY,
        offset: 0,
    }
    .feed(json!([{ "type": "recorded", "items": [
        item("nginx elsewhere, a later note", json!({ "timestamp": "2026-09-28 09:00" })),
    ] }]));
    app.db
        .lock()
        .execute(
            "INSERT INTO delegations (id,owner_user,assistant_session_id,workspace_id,title,task,status,result,expires_at,created_at,updated_at) VALUES ('d12345678',?,'chat','n1:repo','Fix nginx','Reload it.','completed','nginx reloaded',0,0,?)",
            rusqlite::params![ME, crate::util::now_ms()],
        )
        .unwrap();

    let hits = search(&app, ME, "部署 NGINX", None, None).unwrap();
    // Most words first: the two-character Chinese word counts like any other.
    assert_eq!(
        hits[0],
        json!({ "id": deploy["id"], "kind": "workspace", "workspace": "pirc on n1",
            "date": "2026-09-27 10:00", "status": "active", "git": "main@abcdef1*",
            "relevance": "high", "content": "部署 uses nginx on lumo" })
    );
    let found = ids(&hits);
    assert!(!found.contains(&theirs["id"].as_str().unwrap().to_owned()));
    for id in [
        config["id"].as_str().unwrap().to_owned(),
        "d12345678".into(),
        hash_id("nginx elsewhere, a later note"),
    ] {
        assert!(found.contains(&id), "{id} in {found:?}");
    }
    let delegation = hits.iter().find(|hit| hit["kind"] == "delegation").unwrap();
    assert_eq!(
        (
            &delegation["workspace"],
            &delegation["status"],
            &delegation["content"]
        ),
        (
            &json!("pirc on n1"),
            &json!("completed"),
            &json!("Fix nginx: nginx reloaded")
        )
    );
    assert_eq!(
        ids(&search(&app, ME, "部署", None, None).unwrap()),
        [deploy["id"].as_str().unwrap()]
    );
    assert_eq!(
        ids(&search(&app, OTHER, "部署", None, None).unwrap()),
        [theirs["id"].as_str().unwrap()]
    );
    // Wildcards are words, not patterns.
    assert_eq!(
        ids(&search(&app, ME, "100%", None, None).unwrap()),
        [percent["id"].as_str().unwrap()]
    );

    // Superseded notes come after current ones with as many matching words.
    feed.feed(json!([{ "type": "retired", "ids": [config["id"]], "reason": "superseded" }]));
    let nginx = search(&app, ME, "nginx", None, None).unwrap();
    let last = nginx.last().unwrap();
    assert_eq!(
        (&last["id"], &last["status"]),
        (&config["id"], &json!("superseded"))
    );
    // A workspace narrows to the ledgers its sessions wrote (a worktree shares its repository's).
    let mut narrowed = ids(&search(&app, ME, "nginx", Some("n1:wt"), None).unwrap());
    narrowed.sort();
    let mut expected = vec![
        deploy["id"].as_str().unwrap().to_owned(),
        config["id"].as_str().unwrap().to_owned(),
    ];
    expected.sort();
    assert_eq!(narrowed, expected);
    let error = search(&app, ME, "   ", None, None).unwrap_err();
    assert_eq!(error.message, "query is required");
    assert_eq!(search(&app, ME, "nginx", None, Some(1)).unwrap().len(), 1);
}

/// Clones of one repository on other nodes find each other's notes and
/// delegations; a workspace without a repository keeps to its own ledgers.
#[test]
fn clones_of_a_repository_find_each_others_notes() {
    use crate::db::Store as _;
    let (app, _dir) = setup();
    {
        let conn = app.db.lock();
        conn.sync_remote_workspaces(
            "n2",
            &[
                (
                    "clone".into(),
                    "pirc-clone".into(),
                    crate::db::ModeId::new("directory").unwrap(),
                ),
                (
                    "else".into(),
                    "other".into(),
                    crate::db::ModeId::new("directory").unwrap(),
                ),
            ],
        )
        .unwrap();
        conn.create_session("n2:clone", "node://n2/c1", "n2", "c1", ME)
            .unwrap();
        conn.create_session("n2:else", "node://n2/e1", "n2", "e1", ME)
            .unwrap();
    }
    let feed = |node: &str, key: &str, items: Vec<Value>| {
        ingest(
            &app,
            node,
            key,
            0,
            100,
            false,
            &[json!({ "type": "recorded", "items": items })],
        )
        .unwrap();
    };
    let worktree = item("nginx in the worktree", json!({ "sessionId": "s2" }));
    feed(
        "n1",
        KEY,
        vec![
            item("nginx on the first clone", json!({})),
            worktree.clone(),
        ],
    );
    // Recorded before the gateway knew the repository: tagged when it learns it.
    let early = item("nginx on the second clone", json!({ "sessionId": "c1" }));
    feed("n2", KEY, vec![early.clone()]);
    let repos = |conn: &rusqlite::Connection| -> Vec<(String, Option<String>)> {
        let mut statement = conn
            .prepare("SELECT id, repo FROM workspaces ORDER BY id")
            .unwrap();
        statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    };
    {
        let conn = app.db.lock();
        conn.set_workspace_repos("n1", &[("repo".into(), Some("github.com/me/pirc".into()))])
            .unwrap();
        conn.set_workspace_repos(
            "n2",
            &[
                ("clone".into(), Some("github.com/me/pirc".into())),
                ("else".into(), Some("github.com/me/other".into())),
            ],
        )
        .unwrap();
        // Only keys a node could have normalized are kept.
        conn.set_workspace_repos(
            "n1",
            &[("wt".into(), Some("user:tok@github.com/x/y".into()))],
        )
        .unwrap();
        assert_eq!(
            repos(&conn),
            [
                ("n1:repo".to_owned(), Some("github.com/me/pirc".to_owned())),
                ("n1:wt".to_owned(), None),
                ("n2:clone".to_owned(), Some("github.com/me/pirc".to_owned())),
                ("n2:else".to_owned(), Some("github.com/me/other".to_owned())),
            ]
        );
    }
    let late = item(
        "nginx on the second clone, later",
        json!({ "sessionId": "c1" }),
    );
    let elsewhere = item("nginx in another repository", json!({ "sessionId": "e1" }));
    ingest(
        &app,
        "n2",
        KEY,
        100,
        200,
        false,
        &[json!({ "type": "recorded", "items": [late.clone()] })],
    )
    .unwrap();
    feed("n2", OTHER_KEY, vec![elsewhere.clone()]);
    app.db
        .lock()
        .execute(
            "INSERT INTO delegations (id,owner_user,assistant_session_id,workspace_id,title,task,status,result,expires_at,created_at,updated_at) VALUES ('d87654321',?,'chat','n2:clone','Fix nginx','Reload it.','completed','nginx reloaded',0,0,?)",
            rusqlite::params![ME, crate::util::now_ms()],
        )
        .unwrap();

    let hits = search(&app, ME, "nginx", Some("n1:repo"), Some(20)).unwrap();
    let mut found = ids(&hits);
    found.sort();
    let mut expected = vec![
        hash_id("nginx on the first clone"),
        worktree["id"].as_str().unwrap().to_owned(),
        early["id"].as_str().unwrap().to_owned(),
        late["id"].as_str().unwrap().to_owned(),
        "d87654321".to_owned(),
    ];
    expected.sort();
    assert_eq!(found, expected);
    // Labelled with the workspace that wrote them.
    let from_clone = hits.iter().find(|hit| hit["id"] == late["id"]).unwrap();
    assert_eq!(from_clone["workspace"], "pirc-clone on n2");
    // The same from the other side, but for the worktree's note: its
    // workspace reported no repository, so only its ledger links it.
    let mut from_other_side = ids(&search(&app, ME, "nginx", Some("n2:clone"), Some(20)).unwrap());
    from_other_side.sort();
    expected.retain(|id| *id != worktree["id"]);
    assert_eq!(from_other_side, expected);
    assert_eq!(
        ids(&search(&app, ME, "nginx", Some("n2:else"), None).unwrap()),
        [elsewhere["id"].as_str().unwrap()]
    );
    // Without a repository: its own ledger only (shared with n1:repo, a worktree).
    let mut own = ids(&search(&app, ME, "nginx", Some("n1:wt"), None).unwrap());
    own.sort();
    let mut ledger = vec![
        hash_id("nginx on the first clone"),
        worktree["id"].as_str().unwrap().to_owned(),
    ];
    ledger.sort();
    assert_eq!(own, ledger);
    // Never someone else's.
    assert!(
        search(&app, OTHER, "nginx", Some("n1:repo"), None)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn notes_are_recalled_for_their_owner_only_never_forgotten() {
    let (app, _dir) = setup();
    let mut feed = Feeder {
        app: &app,
        key: KEY,
        offset: 0,
    };
    let note = item("Staging first", json!({}));
    let id = note["id"].as_str().unwrap().to_owned();
    feed.feed(json!([{ "type": "recorded", "items": [note] }]));
    assert_eq!(
        find(&app, ME, &id).unwrap(),
        [Found {
            node_id: "n1".into(),
            ledger_key: KEY.into(),
            workspace: "pirc on n1".into(),
            date: "2026-09-27 10:00".into(),
            status: "active".into(),
            content: "Staging first".into(),
        }]
    );
    assert!(find(&app, OTHER, &id).unwrap().is_empty());
    feed.feed(json!([{ "type": "retired", "ids": [id], "reason": "forgotten" }]));
    assert!(find(&app, ME, &id).unwrap().is_empty());
    assert!(search(&app, ME, "staging", None, None).unwrap().is_empty());
}

#[test]
fn a_project_searches_its_linked_workspaces_first() {
    use crate::db::{ModeId, Store as _};
    let (app, _dir) = setup();
    {
        let conn = app.db.lock();
        conn.sync_remote_workspaces(
            "home",
            &[
                ("chats".into(), "Chats".into(), ModeId::new("chat").unwrap()),
                ("trip".into(), "Trip".into(), ModeId::new("chat").unwrap()),
                ("blog".into(), "Blog".into(), ModeId::new("chat").unwrap()),
            ],
        )
        .unwrap();
        conn.sync_remote_workspaces(
            "n2",
            &[
                (
                    "clone".into(),
                    "pirc-clone".into(),
                    ModeId::new("directory").unwrap(),
                ),
                (
                    "else".into(),
                    "other".into(),
                    ModeId::new("directory").unwrap(),
                ),
            ],
        )
        .unwrap();
        conn.create_session("n2:clone", "node://n2/c1", "n2", "c1", ME)
            .unwrap();
        conn.create_session("n2:else", "node://n2/e1", "n2", "e1", ME)
            .unwrap();
        conn.set_workspace_repos("n1", &[("repo".into(), Some("github.com/me/pirc".into()))])
            .unwrap();
        conn.set_workspace_repos("n2", &[("clone".into(), Some("github.com/me/pirc".into()))])
            .unwrap();
        conn.execute(
            "INSERT INTO project_links (project_workspace_id,workspace_id,repo,created_at) VALUES ('home:trip','n1:repo',NULL,1)",
            [],
        )
        .unwrap();
    }
    let feed = |node: &str, key: &str, items: Vec<Value>| {
        ingest(
            &app,
            node,
            key,
            0,
            100,
            false,
            &[json!({ "type": "recorded", "items": items })],
        )
        .unwrap();
    };
    let linked = item("nginx on the linked repository", json!({}));
    let worktree = item("nginx in its worktree", json!({ "sessionId": "s2" }));
    let clone = item("nginx on a clone", json!({ "sessionId": "c1" }));
    let elsewhere = item("nginx and postgres elsewhere", json!({ "sessionId": "e1" }));
    feed("n1", KEY, vec![linked.clone(), worktree.clone()]);
    feed("n2", KEY, vec![clone.clone()]);
    feed("n2", OTHER_KEY, vec![elsewhere.clone()]);
    let id = |value: &Value| value["id"].as_str().unwrap().to_owned();
    let sorted = |hits: Vec<Value>| {
        let mut found = ids(&hits);
        found.sort();
        found
    };
    let mut in_project = vec![id(&linked), id(&worktree), id(&clone)];
    in_project.sort();
    let mut everything = [in_project.clone(), vec![id(&elsewhere)]].concat();
    everything.sort();
    let run = |query: &str, workspace: Option<&str>, project: Option<&str>, everywhere: bool| {
        let (hits, searched) =
            search_in(&app, ME, query, workspace, Some(20), project, everywhere).unwrap();
        (sorted(hits), searched)
    };

    // The linked workspace, its ledger and the clones of its repository.
    assert_eq!(
        run("nginx", None, Some("home:trip"), false),
        (in_project.clone(), Some(Searched::Linked))
    );
    // Nothing there: every workspace, said so.
    assert_eq!(
        run("postgres", None, Some("home:trip"), false),
        (vec![id(&elsewhere)], Some(Searched::Everywhere))
    );
    assert_eq!(
        run("redis", None, Some("home:trip"), false),
        (vec![], Some(Searched::Everywhere))
    );
    // Asked for everything, or for one workspace: links play no part.
    assert_eq!(
        run("nginx", None, Some("home:trip"), true),
        (everything.clone(), None)
    );
    assert_eq!(
        run("nginx", Some("n2:else"), Some("home:trip"), false),
        (vec![id(&elsewhere)], None)
    );
    // A project without links, and the top-level chats, search everything.
    assert_eq!(
        run("nginx", None, Some("home:blog"), false),
        (everything.clone(), None)
    );
    assert_eq!(
        run("nginx", None, Some("home:chats"), false),
        (everything, None)
    );
    // Never someone else's.
    assert!(
        search_in(&app, OTHER, "nginx", None, None, Some("home:trip"), false)
            .unwrap()
            .0
            .is_empty()
    );
}

#[test]
fn a_node_keeps_at_most_its_quota() {
    let (app, _dir) = setup();
    let feed = |offset: u64, lines: Value, limits| {
        ingest_within(
            &app,
            "n1",
            KEY,
            (offset, offset + 10, false),
            lines.as_array().unwrap(),
            limits,
        )
        .unwrap()
    };
    // Three rows at most: the third and fourth notes are not kept, but the
    // ledger still advances.
    let notes = json!([{ "type": "recorded", "items": [
        item("one", json!({})), item("two", json!({})),
        item("three", json!({})), item("four", json!({})),
    ] }]);
    assert_eq!(feed(0, notes, (3, 1000)), 10);
    assert_eq!(all(&app).len(), 3);
    // A tombstone takes a row too; with no room it is refused.
    let forget = json!([{ "type": "retired", "ids": [hash_id("unseen")], "reason": "forgotten" }]);
    feed(10, forget, (3, 1000));
    assert_eq!(all(&app).len(), 3);
    // Bytes: "one", "two", "three" hold 11; "eleven" (6) fits in 14 only
    // because forgetting "one" freed 3 bytes first.
    let lines = json!([
        { "type": "retired", "ids": [hash_id("one")], "reason": "forgotten" },
        { "type": "recorded", "items": [item("eleven", json!({}))] },
    ]);
    feed(20, lines, (4, 14));
    let kept = all(&app);
    assert!(kept.contains(&format!("eleven:active:{ME}")), "{kept:?}");
    // Clearing frees the rows it deletes.
    let lines = json!([
        { "type": "cleared" },
        { "type": "recorded", "items": [item("after", json!({}))] },
    ]);
    feed(30, lines, (3, 1000));
    let kept = all(&app);
    assert!(kept.contains(&format!("after:active:{ME}")), "{kept:?}");
}
