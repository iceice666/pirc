//! The unit cases of `agent-workspace-memory.test.ts`.

use std::process::Command;

use pirc_protocol::{Message, UserContent};
use serde_json::json;

use super::*;
use crate::features::memory::ledger::tests::{custom, obs};
use crate::features::memory::ledger::{OBS_RECORDED, REF_RECORDED};
use crate::features::memory::recall;
use crate::session_store::{EntryData, SessionStore};

fn tmp() -> (tempfile::TempDir, String) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().canonicalize().unwrap().display().to_string();
    (dir, path)
}

fn git_cmd(cwd: &str, args: &[&str]) {
    let status = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .unwrap();
    assert!(status.success(), "git {args:?}");
}

fn init_repo(repo: &str) {
    git_cmd(repo, &["init", "-q", "-b", "main"]);
    git_cmd(repo, &["config", "user.email", "t@example.com"]);
    git_cmd(repo, &["config", "user.name", "T"]);
    std::fs::write(format!("{repo}/a.txt"), "a\n").unwrap();
    git_cmd(repo, &["add", "."]);
    git_cmd(
        repo,
        &["-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"],
    );
}

fn item(content: &str, extra: Value) -> Value {
    let mut out = json!({ "id": hash_id(content), "content": content, "relevance": "high",
        "timestamp": "2026-09-01 10:00", "sessionId": "s1", "sessionDir": "/nonexistent",
        "sourceMemoryIds": ["aaaaaaaaaaaa"], "tokenCount": 20 });
    for (key, value) in extra.as_object().unwrap() {
        out[key] = value.clone();
    }
    out
}

fn lines(values: Vec<Value>) -> Vec<WorkspaceLine> {
    parse_workspace_lines(
        &values
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n"),
    )
}

fn contents(items: &[WorkspaceItem]) -> Vec<&str> {
    items.iter().map(|item| item.content.as_str()).collect()
}

#[test]
fn shares_one_key_across_git_worktrees_and_records_git_state() {
    if Command::new("git").arg("--version").output().is_err() {
        return;
    }
    let (_repo_dir, repo) = tmp();
    init_repo(&repo);
    let (_wt_dir, wt_root) = tmp();
    let worktree = format!("{wt_root}/feature");
    git_cmd(
        &repo,
        &["worktree", "add", "-q", "-b", "feature", &worktree],
    );
    let main = resolve_workspace(&repo);
    assert_eq!(resolve_workspace(&worktree), main);
    assert_eq!(main.1, repo);
    let state = git_state(&worktree).unwrap();
    assert_eq!(state.branch.as_deref(), Some("feature"));
    assert!(!state.dirty);
    assert_eq!(state.worktree, worktree);
    std::fs::write(format!("{worktree}/a.txt"), "changed\n").unwrap();
    assert!(git_state(&worktree).unwrap().dirty);
    // Plain directories fall back to their own path.
    let (_plain_dir, plain) = tmp();
    assert_eq!(resolve_workspace(&plain).1, plain);
    assert_eq!(git_state(&plain), None);
}

/// The node's key (read from files) is git's for a repository, a
/// directory inside it, a worktree and a submodule, and a plain
/// directory's own path.
#[test]
fn the_nodes_key_from_files_is_gits() {
    if Command::new("git").arg("--version").output().is_err() {
        return;
    }
    let (_repo_dir, repo) = tmp();
    init_repo(&repo);
    let sub = format!("{repo}/sub/dir");
    std::fs::create_dir_all(&sub).unwrap();
    let (_wt_dir, wt_root) = tmp();
    let worktree = format!("{wt_root}/feature");
    git_cmd(
        &repo,
        &["worktree", "add", "-q", "-b", "feature", &worktree],
    );
    let (_outer_dir, outer) = tmp();
    init_repo(&outer);
    git_cmd(
        &outer,
        &[
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            "-q",
            &repo,
            "inner",
        ],
    );
    let submodule = format!("{outer}/inner");
    let (_plain_dir, plain) = tmp();
    for cwd in [&repo, &sub, &worktree, &submodule, &plain] {
        assert_eq!(
            resolve_workspace_from_files(cwd),
            resolve_workspace(cwd),
            "{cwd}"
        );
    }
    assert_eq!(resolve_workspace_from_files(&worktree).1, repo);
    // A `.git` directory that is not a repository is not git's either.
    let (_fake_dir, fake) = tmp();
    std::fs::create_dir(format!("{fake}/.git")).unwrap();
    assert_eq!(resolve_workspace_from_files(&fake).1, fake);
}

/// What an agent can write in its workspace never keys it to another
/// repository, nor brings a file the node reads into the root: a `.git`
/// file naming another repository (no link back), a `.git` symlink, a
/// `commondir` beside a repository's `.git`, a `commondir` symlink.
#[test]
fn the_nodes_key_ignores_planted_git_files() {
    use std::os::unix::fs::symlink;
    let (_other_dir, other) = tmp();
    std::fs::create_dir_all(format!("{other}/.git")).unwrap();
    std::fs::write(format!("{other}/.git/HEAD"), "ref: refs/heads/main\n").unwrap();
    let (_secret_dir, secret_root) = tmp();
    let secret = format!("{secret_root}/token");
    std::fs::write(&secret, "s3cret-token\n").unwrap();

    let (_a_dir, a) = tmp();
    std::fs::write(format!("{a}/.git"), format!("gitdir: {other}/.git\n")).unwrap();
    assert_eq!(
        resolve_workspace_from_files(&a).1,
        a,
        "a .git file without its link back"
    );

    let (_b_dir, b) = tmp();
    symlink(format!("{other}/.git"), format!("{b}/.git")).unwrap();
    assert_eq!(resolve_workspace_from_files(&b).1, b, "a .git symlink");

    let (_c_dir, c) = tmp();
    std::fs::create_dir_all(format!("{c}/.git")).unwrap();
    std::fs::write(format!("{c}/.git/HEAD"), "ref: refs/heads/main\n").unwrap();
    std::fs::write(format!("{c}/.git/commondir"), format!("{other}/.git\n")).unwrap();
    assert_eq!(
        resolve_workspace_from_files(&c).1,
        c,
        "commondir beside a .git directory"
    );

    // A worktree whose `commondir` became a symlink to a secret: the
    // secret never reaches the root, and the key falls back to the path.
    let (_main_dir, main) = tmp();
    let worktrees = format!("{main}/.git/worktrees/wt");
    std::fs::create_dir_all(&worktrees).unwrap();
    std::fs::write(format!("{main}/.git/HEAD"), "ref: refs/heads/main\n").unwrap();
    std::fs::write(format!("{worktrees}/HEAD"), "ref: refs/heads/wt\n").unwrap();
    let (_wt_dir, wt) = tmp();
    std::fs::write(format!("{wt}/.git"), format!("gitdir: {worktrees}\n")).unwrap();
    std::fs::write(format!("{worktrees}/gitdir"), format!("{wt}/.git\n")).unwrap();
    std::fs::write(format!("{worktrees}/commondir"), "../..\n").unwrap();
    assert_eq!(
        resolve_workspace_from_files(&wt).1,
        main,
        "a well-formed worktree"
    );
    std::fs::remove_file(format!("{worktrees}/commondir")).unwrap();
    symlink(&secret, format!("{worktrees}/commondir")).unwrap();
    let (_, root) = resolve_workspace_from_files(&wt);
    assert!(!root.contains("s3cret"), "{root}");
    assert_eq!(root, wt);
    // A worktree whose link back names another checkout.
    std::fs::remove_file(format!("{worktrees}/commondir")).unwrap();
    std::fs::write(format!("{worktrees}/commondir"), "../..\n").unwrap();
    std::fs::write(format!("{worktrees}/gitdir"), format!("{a}/.git\n")).unwrap();
    assert_eq!(resolve_workspace_from_files(&wt).1, wt);
}

#[test]
fn the_node_assigned_ledger_needs_a_key_and_a_root() {
    let env = |key: &'static str, root: &'static str| {
        move |name: &str| match name {
            "PIRC_WORKSPACE_MEMORY_KEY" => Some(key.to_owned()),
            "PIRC_WORKSPACE_MEMORY_ROOT" => Some(root.to_owned()),
            _ => None,
        }
    };
    assert_eq!(
        node_assigned_ledger(&env("0123456789abcdef", "/r")),
        Some(("0123456789abcdef".to_owned(), "/r".to_owned()))
    );
    assert_eq!(node_assigned_ledger(&env("../../etc/passwd", "/r")), None);
    assert_eq!(node_assigned_ledger(&env("0123456789ABCDEF", "/r")), None);
    assert_eq!(node_assigned_ledger(&env("0123456789abcdef", "")), None);
    assert_eq!(node_assigned_ledger(&|_| None), None);
}

/// The lock is the ledger file's `flock`: no `.lock` file beside it, so a
/// sandbox that opens only the ledger can take it.
#[test]
fn the_lock_is_on_the_ledger_file() {
    let (_dir, dir) = tmp();
    let ledger = WorkspaceLedger::new(format!("{dir}/new"), "k".to_owned(), "/r".to_owned());
    let held = ledger.try_lock().unwrap();
    assert!(held.is_some());
    let names: Vec<String> = std::fs::read_dir(format!("{dir}/new"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names, ["k.jsonl"]);
    ledger.append(&json!({"type": "x"})).unwrap();
    // Another open of the file (another process's) does not get it.
    let other = WorkspaceLedger::new(format!("{dir}/new"), "k".to_owned(), "/r".to_owned());
    assert!(other.try_lock().unwrap().is_none());
    drop(held);
    assert!(ledger.try_lock().unwrap().is_some());
}

#[test]
fn folds_recorded_retired_and_cleared_lines() {
    let (a, b, c) = (
        item("first", json!({})),
        item("second", json!({})),
        item("third", json!({})),
    );
    let fold = fold_workspace(&lines(vec![
        json!({ "type": "recorded", "at": 1, "items": [a, b] }),
        json!({ "type": "retired", "at": 2, "ids": [a["id"]], "reason": "superseded" }),
    ]));
    assert_eq!(contents(&fold.active), ["second"]);
    let cleared = fold_workspace(&lines(vec![
        json!({ "type": "recorded", "at": 1, "items": [a, b] }),
        json!({ "type": "cleared", "at": 2 }),
        json!({ "type": "recorded", "at": 3, "items": [c] }),
    ]));
    assert_eq!(contents(&cleared.active), ["third"]);
    assert!(!cleared.items.contains_key(a["id"].as_str().unwrap()));
    // Torn lines and invalid items are skipped.
    assert_eq!(
        parse_workspace_lines("{\"type\":\"recorded\",\"items\":[{\"id\":1}]}\n{torn"),
        [WorkspaceLine::Recorded { items: Vec::new() }]
    );
}

#[test]
fn forgets_items_for_good_even_across_a_clear() {
    let (a, b) = (item("first", json!({})), item("second", json!({})));
    let (ida, idb) = (a["id"].as_str().unwrap(), b["id"].as_str().unwrap());
    let fold = fold_workspace(&lines(vec![
        json!({ "type": "recorded", "at": 1, "items": [a, b] }),
        json!({ "type": "retired", "at": 2, "ids": [ida], "reason": "forgotten" }),
        json!({ "type": "retired", "at": 3, "ids": [idb], "reason": "superseded" }),
    ]));
    assert!(fold.active.is_empty());
    // Superseded items stay recallable; forgotten ones do not.
    assert!(fold.items.contains_key(idb));
    assert!(!fold.items.contains_key(ida));
    assert_eq!(fold.forgotten[ida].as_deref(), Some("first"));
    let later = fold_workspace(&lines(vec![
        json!({ "type": "recorded", "at": 1, "items": [a] }),
        json!({ "type": "retired", "at": 2, "ids": [ida], "reason": "forgotten" }),
        json!({ "type": "cleared", "at": 3 }),
        json!({ "type": "recorded", "at": 4, "items": [a] }),
    ]));
    assert!(later.active.is_empty());
    assert_eq!(later.forgotten[ida].as_deref(), Some("first"));
}

#[test]
fn selects_reflections_and_important_observations_not_yet_promoted() {
    let high = obs("decided X", "m1", "high");
    let low = obs("ran ls", "m1", "low");
    let done = obs("already carried", "m1", "critical");
    let reflection = json!({ "id": hash_id("durable"), "content": "durable",
        "supportingObservationIds": [high["id"]], "tokenCount": 3 });
    let branch = vec![
        custom(
            OBS_RECORDED,
            json!({ "observations": [high, low, done], "coversUpToId": "x" }),
        ),
        custom(
            REF_RECORDED,
            json!({ "reflections": [reflection], "coversUpToId": "x" }),
        ),
        custom(WS_PROMOTED, json!({ "memoryIds": [done["id"]] })),
    ];
    let shown: Vec<String> = promotion_candidates(&branch)
        .iter()
        .map(|c| {
            format!(
                "{}:{}",
                if c.reflection {
                    "reflection"
                } else {
                    "observation"
                },
                c.content
            )
        })
        .collect();
    assert_eq!(shown, ["reflection:durable", "observation:decided X"]);
}

#[test]
fn carries_origins_from_session_memory_to_candidates() {
    let mut from_user = obs("user chose X", "m1", "high");
    from_user["origins"] = json!(["user"]);
    let legacy = obs("old decision", "m1", "critical");
    let reflection = json!({ "id": hash_id("durable X"), "content": "durable X",
        "supportingObservationIds": [from_user["id"], legacy["id"]], "tokenCount": 3 });
    let branch = vec![
        custom(
            OBS_RECORDED,
            json!({ "observations": [from_user, legacy], "coversUpToId": "x" }),
        ),
        custom(
            REF_RECORDED,
            json!({ "reflections": [reflection], "coversUpToId": "x" }),
        ),
    ];
    let candidates = promotion_candidates(&branch);
    let origins = |content: &str| {
        candidates
            .iter()
            .find(|c| c.content == content)
            .unwrap()
            .origins
            .clone()
    };
    assert_eq!(origins("durable X"), ["unknown", "user"]);
    assert_eq!(origins("user chose X"), ["user"]);
    assert_eq!(origins("old decision"), ["unknown"]);
}

fn candidate(id: &str, origins: &[&str]) -> Candidate {
    Candidate {
        id: id.to_owned(),
        reflection: true,
        content: "x".to_owned(),
        timestamp: None,
        relevance: None,
        origins: origins.iter().map(|o| (*o).to_owned()).collect(),
    }
}

fn args(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => unreachable!(),
    }
}

#[test]
fn validates_promoter_tool_calls() {
    let existing = item("old note", json!({}));
    let fold = fold_workspace(&lines(vec![
        json!({ "type": "recorded", "at": 1, "items": [existing] }),
    ]));
    let git = GitState {
        head: "abcdef123456".to_owned(),
        branch: Some("main".to_owned()),
        dirty: true,
        worktree: "/w".to_owned(),
    };
    let mut tool = PromoterTool::new(
        fold,
        // The candidate carried no origins (older session memory).
        &[candidate("bbbbbbbbbbbb", &[])],
        PromotionContext {
            session_id: "s2".to_owned(),
            session_dir: "/s2".to_owned(),
            git: Some(git),
        },
    );
    let receipt = tool.execute(&args(json!({
        "add": [
            { "content": "new note", "relevance": "high", "sourceMemoryIds": ["bbbbbbbbbbbb", "invented"] },
            { "content": "no source", "relevance": "high", "sourceMemoryIds": ["invented"] },
            { "content": "old note", "relevance": "high", "sourceMemoryIds": ["bbbbbbbbbbbb"] },
        ],
        "retire": [existing["id"], "ffffffffffff"],
    })));
    assert!(
        receipt.contains("Added 1, retired 1, rejected 1"),
        "{receipt}"
    );
    assert!(receipt.contains("skipped 1 already in workspace memory"));
    assert_eq!(tool.out.add.len(), 1);
    let added = &tool.out.add[0];
    assert_eq!(added["sourceMemoryIds"], json!(["bbbbbbbbbbbb"]));
    assert_eq!(added["origins"], json!(["unknown"]));
    assert_eq!(added["git"]["branch"], "main");
    assert_eq!(tool.out.retire, [existing["id"].as_str().unwrap()]);
}

#[test]
fn skips_notes_the_ledger_already_knows_and_records_origins_without_secrets() {
    let superseded = item("retired note", json!({}));
    let gone = item("forgotten note", json!({}));
    let fold = fold_workspace(&lines(vec![
        json!({ "type": "recorded", "at": 1, "items": [superseded, gone] }),
        json!({ "type": "retired", "at": 2, "ids": [superseded["id"]], "reason": "superseded" }),
        json!({ "type": "retired", "at": 3, "ids": [gone["id"]], "reason": "forgotten" }),
    ]));
    let mut tool = PromoterTool::new(
        fold.clone(),
        &[candidate("cccccccccccc", &["tool:bash", "user"])],
        PromotionContext {
            session_id: "s3".to_owned(),
            session_dir: "/s3".to_owned(),
            git: None,
        },
    );
    let token = format!("ghp_{}", "a".repeat(36));
    let receipt = tool.execute(&args(json!({ "add": [
        { "content": "retired note", "relevance": "high", "sourceMemoryIds": ["cccccccccccc"] },
        { "content": "forgotten note", "relevance": "high", "sourceMemoryIds": ["cccccccccccc"] },
        { "content": format!("CI uses {token}"), "relevance": "high", "sourceMemoryIds": ["cccccccccccc"] },
    ] })));
    assert!(
        receipt.contains("Added 1, retired 0, rejected 0"),
        "{receipt}"
    );
    assert!(receipt.contains("1 recorded before and retired"));
    assert!(receipt.contains("1 forgotten by the user"));
    assert_eq!(tool.out.add[0]["content"], "CI uses ghp_[REDACTED]");
    assert_eq!(tool.out.add[0]["origins"], json!(["tool:bash", "user"]));
    // The promoter is told what was forgotten; superseded notes are not listed.
    let prompt = promoter_prompt(&fold, &[], None, 100);
    assert!(prompt.contains(
        "FORGOTTEN (the user asked to forget these; never record them again):\n- forgotten note"
    ));
    assert!(!prompt.contains("retired note"));
    assert!(!promoter_prompt(&fold_workspace(&[]), &[], None, 100).contains("FORGOTTEN"));
}

#[test]
fn renders_within_budget_preferring_relevant_and_recent_items() {
    let items: Vec<WorkspaceItem> = [
        item("old low", json!({ "relevance": "low" })),
        item("old critical", json!({ "relevance": "critical" })),
        item("new medium", json!({ "relevance": "medium" })),
        item(
            "newer medium",
            json!({ "relevance": "medium", "git": { "head": "abcdef123456", "branch": "main",
            "dirty": true, "worktree": "/w" } }),
        ),
    ]
    .iter()
    .map(|value| WorkspaceItem::parse(value).unwrap())
    .collect();
    let text = render_workspace_memory(&items, "/repo", None, 60);
    assert!(text.contains("## Workspace memory"));
    assert!(text.contains("old critical"));
    assert!(text.contains("newer medium"));
    assert!(text.contains("(main@abcdef1*)"));
    assert!(text.contains("new medium"));
    assert!(!text.contains("old low"));
    // Chronological order is preserved.
    assert!(text.find("old critical") < text.find("newer medium"));
    assert_eq!(render_workspace_memory(&[], "/repo", None, 60), "");
}

#[test]
fn recalls_a_workspace_item_through_its_source_session() {
    let (_dir, dir) = tmp();
    let mut store = SessionStore::open(dir.clone().into(), &dir).unwrap();
    let message = store
        .append(EntryData::Message(Message::User {
            content: UserContent::Text("We chose sqlite over postgres.".to_owned()),
            timestamp: crate::now_ms(),
        }))
        .unwrap();
    let observation = obs("User chose sqlite", &message.id, "high");
    store
        .append(EntryData::Custom {
            custom_type: OBS_RECORDED.to_owned(),
            data: json!({ "observations": [observation], "coversUpToId": message.id }),
        })
        .unwrap();
    let source = json!({ "sessionDir": dir, "sourceMemoryIds": [observation["id"]] });
    let kept = WorkspaceItem::parse(&item("Chose sqlite", source.clone())).unwrap();
    let (text, status) = recall_workspace_item(&kept, recall).unwrap();
    assert_eq!(status, "ok");
    assert!(text.contains("We chose sqlite over postgres."));
    let gone = WorkspaceItem::parse(&item("gone", json!({}))).unwrap();
    assert_eq!(
        recall_workspace_item(&gone, recall).unwrap().1,
        "source_unavailable"
    );
    // Through the fold: superseded items still recall, forgotten ones
    // answer without content.
    let dropped = item("Also chose sqlite", source);
    let fold = fold_workspace(&lines(vec![
        json!({ "type": "recorded", "at": 1, "items": [kept.raw, dropped] }),
        json!({ "type": "retired", "at": 2, "ids": [kept.id], "reason": "superseded" }),
        json!({ "type": "retired", "at": 3, "ids": [dropped["id"]], "reason": "forgotten" }),
    ]));
    assert_eq!(
        recall_from_workspace(&fold, &kept.id, recall)
            .unwrap()
            .unwrap()
            .1,
        "ok"
    );
    let (text, status) = recall_from_workspace(&fold, dropped["id"].as_str().unwrap(), recall)
        .unwrap()
        .unwrap();
    assert_eq!(status, "forgotten");
    assert!(!text.contains("sqlite"));
    assert_eq!(
        recall_from_workspace(&fold, "ffffffffffff", recall).unwrap(),
        None
    );
}

#[test]
fn skips_work_when_another_process_holds_the_lock() {
    let (_dir, dir) = tmp();
    let ledger = WorkspaceLedger::new(dir, "k".to_owned(), "/r".to_owned());
    let held = ledger.try_lock().unwrap();
    assert!(held.is_some());
    assert!(ledger.try_lock().unwrap().is_none());
    drop(held);
    assert!(ledger.try_lock().unwrap().is_some());
}

/// Output past the pipe buffer is read while git runs (it used to stall
/// git until the 5 s kill), and output past `maxBuffer` fails the call.
#[test]
fn git_reads_large_output_and_refuses_more_than_a_mebibyte() {
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().to_str().unwrap();
    let alias = |bytes: usize| format!("alias.big=!head -c {bytes} /dev/zero | tr '\\0' a");
    let started = std::time::Instant::now();
    let output = super::git(cwd, &["-c", &alias(200_000), "big"]).expect("output");
    assert_eq!(output.len(), 200_000);
    assert!(super::git(cwd, &["-c", &alias(2_000_000), "big"]).is_none());
    assert!(started.elapsed() < std::time::Duration::from_secs(4));
}
