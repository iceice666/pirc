//! Golden cases from `panel.integration.test.ts` ("reports git status,
//! diffs, history and commit details", "reports a workspace that is not a
//! repository", "lists and reads files but never escapes the workspace"),
//! on temporary repositories.

use std::os::unix::fs::symlink;
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use pirc_policy::session::SessionPolicy;

use super::*;
use crate::sandbox::{BoxFuture, PrepareInput, StderrPrefixes};

/// A stand-in for the node's sandbox: runs the command under `/bin/sh`
/// with `PIRC_TEST_SANDBOXED=1` (so what git starts shows it ran beneath
/// the wrapper), records each call and counts cleanups. `None` as the
/// reason: available.
struct FakeSandbox {
    unavailable: Option<&'static str>,
    /// The wrapper fails with this on stderr (after the probe passed).
    broken: Option<&'static str>,
    /// `prepare_readonly` refuses with this (after the probe passed).
    refused: Option<&'static str>,
    calls: Mutex<Vec<ReadonlyInput>>,
    cleaned: Arc<AtomicUsize>,
}

impl FakeSandbox {
    fn new(unavailable: Option<&'static str>) -> Self {
        Self {
            unavailable,
            broken: None,
            refused: None,
            calls: Mutex::new(Vec::new()),
            cleaned: Arc::new(AtomicUsize::new(0)),
        }
    }
}

impl Sandbox for FakeSandbox {
    fn check(&self) -> BoxFuture<'_, SandboxStatus> {
        Box::pin(async {
            match self.unavailable {
                None => SandboxStatus::Active {
                    description: "fake".into(),
                },
                Some(reason) => SandboxStatus::Unavailable {
                    reason: reason.into(),
                },
            }
        })
    }

    fn prepare(&self, _: PrepareInput) -> BoxFuture<'_, ApiResult<Prepared>> {
        unreachable!("panels never start agents")
    }

    fn prepare_readonly(&self, input: ReadonlyInput) -> BoxFuture<'_, ApiResult<Prepared>> {
        Box::pin(async move {
            self.calls.lock().unwrap().push(input.clone());
            if let Some(reason) = self.refused {
                return Err(crate::sandbox::unavailable_error(reason));
            }
            let script = match self.broken {
                None => "PIRC_TEST_SANDBOXED=1 exec \"$@\"".to_owned(),
                Some(error) => format!("echo '{error}' >&2; exit 1"),
            };
            let mut args: Vec<OsString> = vec!["-c".into(), script.into(), "sandbox".into()];
            args.extend(input.command);
            let cleaned = self.cleaned.clone();
            Ok(Prepared::new(
                PathBuf::from("/bin/sh"),
                args,
                vec![("PIRC_TEST_PREPARED".into(), "1".into())],
                SessionPolicy::default(),
                Vec::new(),
                None,
                move || {
                    cleaned.fetch_add(1, Ordering::SeqCst);
                },
            )
            .with_wrapper_status(Box::new(StderrPrefixes(&["fakewrap: "]))))
        })
    }
}

/// The sandbox of the golden cases.
static HOST: LazyLock<FakeSandbox> = LazyLock::new(|| FakeSandbox::new(None));

/// What git needs to run: the test's `PATH` and `HOME`, and no repository
/// above the temporary directory.
fn env(ceiling: &Path) -> ChildEnv {
    let mut env = ChildEnv::new();
    for name in ["PATH", "HOME"] {
        if let Ok(value) = std::env::var(name) {
            env.insert(name.to_owned(), value);
        }
    }
    env.insert(
        "GIT_CEILING_DIRECTORIES".to_owned(),
        ceiling.display().to_string(),
    );
    env
}

fn run_git(dir: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_CEILING_DIRECTORIES", dir.parent().unwrap())
        .env("GIT_AUTHOR_NAME", "Ada")
        .env("GIT_AUTHOR_EMAIL", "ada@example.com")
        .env("GIT_COMMITTER_NAME", "Ada")
        .env("GIT_COMMITTER_EMAIL", "ada@example.com")
        .env("GIT_AUTHOR_DATE", "1700000000 +0000")
        .env("GIT_COMMITTER_DATE", "1700000000 +0000")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    assert!(output.status.success(), "git {args:?}: {output:?}");
    String::from_utf8(output.stdout).unwrap()
}

struct Fixture {
    _dir: tempfile::TempDir,
    run: PathBuf,
    ws: PathBuf,
}

#[tokio::test]
async fn checkpoint_eligibility_uses_readonly_git_and_keeps_tracked_ignored_files() {
    let f = fixture();
    let sandbox = FakeSandbox::new(None);
    let env = env(&f.run);
    run_git(&f.ws, &["init", "-q"]);
    std::fs::write(f.ws.join(".gitignore"), "*.log\n").unwrap();
    std::fs::write(f.ws.join("tracked.log"), "tracked").unwrap();
    run_git(&f.ws, &["add", "-f", "tracked.log"]);
    let index = std::fs::read(f.ws.join(".git/index")).unwrap();
    std::fs::write(f.ws.join("ignored.log"), "ignored").unwrap();
    assert!(
        !checkpoint_eligible(&sandbox, &f.ws, "ignored.log", &env)
            .await
            .unwrap()
    );
    assert!(
        checkpoint_eligible(&sandbox, &f.ws, "tracked.log", &env)
            .await
            .unwrap()
    );
    assert!(
        checkpoint_eligible(&sandbox, &f.ws, "new.rs", &env)
            .await
            .unwrap()
    );
    assert_eq!(sandbox.calls.lock().unwrap().len(), 3);
    assert_eq!(sandbox.cleaned.load(Ordering::SeqCst), 3);
    assert_eq!(std::fs::read(f.ws.join(".git/index")).unwrap(), index);
    let unavailable = FakeSandbox::new(Some("no wrapper"));
    assert!(
        checkpoint_eligible(&unavailable, &f.ws, "new.rs", &env)
            .await
            .is_err()
    );
    let mut broken = FakeSandbox::new(None);
    broken.broken = Some("fakewrap: refused");
    assert!(
        checkpoint_eligible(&broken, &f.ws, "new.rs", &env)
            .await
            .is_err()
    );
}

fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let run = dir.path().canonicalize().unwrap();
    let ws = run.join("workspace");
    std::fs::create_dir(&ws).unwrap();
    Fixture { _dir: dir, run, ws }
}

fn status(error: ApiError) -> (u16, String, String) {
    (error.status, error.code.into_owned(), error.message)
}

#[test]
fn parses_porcelain_status() {
    let parsed = parse_status(
        "## main...origin/main [ahead 2, behind 1]\0M  a.txt\0R  new\0old\0?? dir/x y\0",
    );
    assert_eq!(parsed.branch.as_deref(), Some("main"));
    assert_eq!(parsed.upstream.as_deref(), Some("origin/main"));
    assert_eq!((parsed.ahead, parsed.behind), (2.0, 1.0));
    assert_eq!(
        parsed.files,
        vec![
            json!({ "path": "a.txt", "index": "M", "worktree": " " }),
            json!({ "path": "new", "index": "R", "worktree": " ", "origPath": "old" }),
            json!({ "path": "dir/x y", "index": "?", "worktree": "?" }),
        ]
    );
    let unborn = parse_status("## No commits yet on main\0");
    assert_eq!(unborn.branch.as_deref(), Some("main"));
    assert_eq!(unborn.upstream, None);
    let detached = parse_status("## HEAD (no branch)\0");
    assert_eq!(detached.branch.as_deref(), Some("HEAD (no branch)"));
}

#[test]
fn resolves_inside_the_workspace() {
    let f = fixture();
    std::fs::create_dir(f.ws.join("src")).unwrap();
    std::fs::write(f.ws.join("src/main.ts"), "x").unwrap();
    std::fs::write(f.run.join("secret.txt"), "nope").unwrap();
    symlink(f.run.join("secret.txt"), f.ws.join("leak")).unwrap();
    symlink("src", f.ws.join("dir-link")).unwrap();

    assert_eq!(resolve_inside(&f.ws, "src").unwrap(), f.ws.join("src"));
    assert_eq!(resolve_inside(&f.ws, "/src/").unwrap(), f.ws.join("src"));
    assert_eq!(resolve_inside(&f.ws, ".").unwrap(), f.ws);
    assert_eq!(resolve_inside(&f.ws, "").unwrap(), f.ws);
    // Lexical `..` first (Node's `path.resolve`), then the real path.
    assert_eq!(
        resolve_inside(&f.ws, "dir-link/../src/main.ts").unwrap(),
        f.ws.join("src/main.ts")
    );
    let inside = f.ws.join("src/main.ts").display().to_string();
    assert_eq!(
        resolve_inside(&f.ws, &inside).unwrap(),
        f.ws.join("src/main.ts")
    );
    let forbidden = (
        403,
        "forbidden".to_owned(),
        "Path is outside the workspace".to_owned(),
    );
    let missing = (404, "not_found".to_owned(), "Path not found".to_owned());
    assert_eq!(
        status(resolve_inside(&f.ws, "leak").unwrap_err()),
        forbidden
    );
    assert_eq!(status(resolve_inside(&f.ws, "..").unwrap_err()), forbidden);
    assert_eq!(
        status(resolve_inside(&f.ws, "src/../../secret.txt").unwrap_err()),
        forbidden
    );
    // An absolute path outside is read as workspace-relative: missing.
    let outside = f.run.join("secret.txt").display().to_string();
    assert_eq!(
        status(resolve_inside(&f.ws, &outside).unwrap_err()),
        missing
    );
    assert_eq!(status(resolve_inside(&f.ws, "nope").unwrap_err()), missing);
    assert_eq!(
        status(resolve_inside(&f.ws, "src\0").unwrap_err()),
        (400, "invalid_input".to_owned(), "Invalid path".to_owned())
    );
    assert_eq!(
        status(resolve_inside(&f.run.join("gone"), "x").unwrap_err()),
        (
            404,
            "not_found".to_owned(),
            "Workspace directory is missing".to_owned()
        )
    );
}

#[test]
fn pathspecs_are_literal_and_contained() {
    let f = fixture();
    std::fs::create_dir(f.ws.join("src")).unwrap();
    assert_eq!(pathspec(&f.ws, "a.txt").unwrap(), ":(literal)a.txt");
    assert_eq!(pathspec(&f.ws, "/a.txt").unwrap(), ":(literal)a.txt");
    assert_eq!(
        pathspec(&f.ws, "src\\lib.rs").unwrap(),
        ":(literal)src/lib.rs"
    );
    assert_eq!(pathspec(&f.ws, "src/../a.txt").unwrap(), ":(literal)a.txt");
    assert_eq!(pathspec(&f.ws, "*.txt").unwrap(), ":(literal)*.txt");
    assert_eq!(pathspec(&f.ws, "src/").unwrap(), ":(literal)src/");
    for path in ["../secret.txt", "..", ".", "", "a/../.."] {
        assert_eq!(
            status(pathspec(&f.ws, path).unwrap_err()),
            (400, "invalid_input".to_owned(), "Invalid path".to_owned()),
            "{path:?}"
        );
    }
    assert_eq!(pathspec(&f.ws, "nowhere/x").unwrap_err().status, 404);
}

#[test]
fn lists_directories_in_locale_order() {
    let f = fixture();
    for dir in ["src", ".git", ".config", "Zeta", "alpha"] {
        std::fs::create_dir(f.ws.join(dir)).unwrap();
    }
    for name in ["b10.txt", "b2.txt", "B1.txt", "_under.txt", "émile.txt"] {
        std::fs::write(f.ws.join(name), name).unwrap();
    }
    std::fs::write(f.run.join("secret.txt"), "nope").unwrap();
    symlink(f.run.join("secret.txt"), f.ws.join("leak")).unwrap();
    symlink("src", f.ws.join("dir-link")).unwrap();
    symlink("nowhere", f.ws.join("dangling")).unwrap();
    let listed = list_directory(&f.ws, "").unwrap();
    let names: Vec<(String, String)> = listed["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| {
            (
                e["name"].as_str().unwrap().to_owned(),
                e["kind"].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    let expected = [
        (".config", "dir"),
        ("alpha", "dir"),
        ("dir-link", "dir"),
        ("src", "dir"),
        ("Zeta", "dir"),
        ("_under.txt", "file"),
        ("B1.txt", "file"),
        ("b10.txt", "file"),
        ("b2.txt", "file"),
        ("dangling", "symlink"),
        ("émile.txt", "file"),
        ("leak", "symlink"),
    ];
    assert_eq!(
        names,
        expected
            .iter()
            .map(|(n, k)| ((*n).to_owned(), (*k).to_owned()))
            .collect::<Vec<_>>()
    );
    assert_eq!(listed["path"], "");
    assert_eq!(listed["truncated"], false);
    assert_eq!(
        listed["entries"][5],
        json!({ "name": "_under.txt", "kind": "file", "size": 10 })
    );
    assert_eq!(list_directory(&f.ws, "dir-link").unwrap()["path"], "src");
    assert_eq!(
        status(list_directory(&f.ws, "b2.txt").unwrap_err()),
        (
            400,
            "invalid_input".to_owned(),
            "Not a directory".to_owned()
        )
    );
}

#[test]
fn reads_files_text_binary_and_images() {
    let f = fixture();
    std::fs::write(f.ws.join("README.md"), "hello\n").unwrap();
    std::fs::write(f.ws.join("bin.dat"), [1u8, 0, 2]).unwrap();
    let png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";
    std::fs::write(f.ws.join("shot.PNG"), png).unwrap();
    std::fs::write(f.ws.join("icon.svg"), "<svg/>").unwrap();
    std::fs::File::create(f.ws.join("huge.jpg"))
        .unwrap()
        .set_len(9 * 1_048_576)
        .unwrap();
    std::fs::write(
        f.ws.join("big-utf8.txt"),
        format!("{}é tail", "x".repeat(1_048_575)),
    )
    .unwrap();

    let text = read_workspace_file(&f.ws, "README.md").unwrap();
    let keys: Vec<&String> = text.as_object().unwrap().keys().collect();
    assert_eq!(
        keys,
        [
            "path",
            "size",
            "modifiedAt",
            "binary",
            "truncated",
            "content"
        ]
    );
    assert_eq!(text["content"], "hello\n");
    assert!(text["modifiedAt"].is_number());

    let binary = read_workspace_file(&f.ws, "bin.dat").unwrap();
    assert_eq!(binary["binary"], true);
    assert!(binary.get("content").is_none());

    let image = read_workspace_file(&f.ws, "shot.PNG").unwrap();
    assert_eq!(image["binary"], true);
    assert_eq!(image["image"]["mimeType"], "image/png");
    assert_eq!(
        image["image"]["dataBase64"],
        base64::engine::general_purpose::STANDARD.encode(png)
    );

    let svg = read_workspace_file(&f.ws, "icon.svg").unwrap();
    assert_eq!(svg["content"], "<svg/>");
    assert_eq!(svg["image"]["mimeType"], "image/svg+xml");

    let huge = read_workspace_file(&f.ws, "huge.jpg").unwrap();
    assert_eq!(huge["imageTooLarge"], true);
    assert_eq!(huge["truncated"], true);
    assert_eq!(huge["binary"], true);
    assert!(huge.get("image").is_none());

    // The cut splits `é`: decoded lossily.
    let big = read_workspace_file(&f.ws, "big-utf8.txt").unwrap();
    assert_eq!(big["truncated"], true);
    let content = big["content"].as_str().unwrap();
    assert!(
        content.ends_with("x\u{FFFD}"),
        "{:?}",
        &content[content.len() - 8..]
    );

    assert_eq!(
        status(read_workspace_file(&f.ws, ".").unwrap_err()),
        (400, "invalid_input".to_owned(), "Not a file".to_owned())
    );
}

#[test]
fn reads_recording_chunks() {
    let f = fixture();
    std::fs::create_dir_all(f.ws.join(".pirc/recordings/dir.webm")).unwrap();
    std::fs::write(f.ws.join(".pirc/recordings/r.webm"), b"0123456789").unwrap();
    let chunk = read_recording_chunk(&f.ws, ".pirc/recordings/r.webm", 3, 4).unwrap();
    assert_eq!(
        chunk,
        json!({ "size": 10, "offset": 3, "mimeType": "video/webm", "dataBase64": "MzQ1Ng==" })
    );
    let past = read_recording_chunk(&f.ws, ".pirc/recordings/r.webm", 50, 4).unwrap();
    assert_eq!(past["offset"], 10);
    assert_eq!(past["dataBase64"], "");
    // A tracked symlink out of the workspace is refused; one inside is a file.
    let outside = f.ws.parent().unwrap().join("secret.txt");
    std::fs::write(&outside, b"secret").unwrap();
    std::os::unix::fs::symlink(&outside, f.ws.join(".pirc/recordings/out.webm")).unwrap();
    std::os::unix::fs::symlink("r.webm", f.ws.join(".pirc/recordings/in.webm")).unwrap();
    let inside = read_recording_chunk(&f.ws, ".pirc/recordings/in.webm", 0, 4).unwrap();
    assert_eq!(inside["dataBase64"], "MDEyMw==");
    for path in [
        ".pirc/recordings/dir.webm",
        ".pirc/recordings/missing.webm",
        ".pirc/recordings/out.webm",
    ] {
        assert_eq!(
            status(read_recording_chunk(&f.ws, path, 0, 4).unwrap_err()),
            (
                404,
                "not_found".to_owned(),
                "Recording not found".to_owned()
            )
        );
    }
}

#[tokio::test]
async fn git_outside_a_repository() {
    let f = fixture();
    let env = env(&f.run);
    assert_eq!(
        git_status(&*HOST, &f.ws, &env).await.unwrap(),
        json!({ "repo": false })
    );
    assert_eq!(
        git_log(&*HOST, &f.ws, &env, 0, 50).await.unwrap(),
        json!({ "commits": [], "more": false })
    );
    let error = git_show(&*HOST, &f.ws, &env, "abcd1234").await.unwrap_err();
    assert_eq!((error.status, error.code.as_ref()), (400, "invalid_input"));
    assert_eq!(
        status(
            git_show(&*HOST, &f.ws, &env, "not-a-sha")
                .await
                .unwrap_err()
        ),
        (
            400,
            "invalid_input".to_owned(),
            "Invalid commit id".to_owned()
        )
    );
}

#[tokio::test]
async fn git_status_diff_log_and_show() {
    let f = fixture();
    let ws = &f.ws;
    let env = env(&f.run);
    run_git(ws, &["init", "-q", "-b", "main"]);
    let unborn = git_status(&*HOST, ws, &env).await.unwrap();
    assert_eq!(unborn["branch"], "main");
    assert_eq!(unborn["root"], "");
    // `rev-parse --verify --quiet HEAD` exits 1, which passes (TS), so
    // `git log` itself fails.
    assert_eq!(
        status(git_log(&*HOST, ws, &env, 0, 50).await.unwrap_err()),
        (
            400,
            "invalid_input".to_owned(),
            "fatal: your current branch 'main' does not have any commits yet".to_owned()
        )
    );

    std::fs::write(ws.join("a.txt"), "one\n").unwrap();
    std::fs::write(ws.join("old name.txt"), "renamed content\n").unwrap();
    run_git(ws, &["add", "."]);
    run_git(ws, &["commit", "-q", "-m", "first commit"]);
    run_git(ws, &["branch", "base"]);
    std::fs::write(ws.join("a.txt"), "one\ntwo\n").unwrap();
    run_git(
        ws,
        &["commit", "-q", "-am", "second commit", "-m", "With a body."],
    );
    run_git(ws, &["tag", "v1"]);
    run_git(ws, &["branch", "-q", "--set-upstream-to", "base"]);
    run_git(ws, &["mv", "old name.txt", "new name.txt"]);
    std::fs::write(ws.join("a.txt"), "one\ntwo\nthree\n").unwrap();
    std::fs::write(ws.join("-dash.txt"), "dash\n").unwrap();
    std::fs::write(ws.join("ünïcode.txt"), "ü\n").unwrap();

    let changes = git_status(&*HOST, ws, &env).await.unwrap();
    assert_eq!(changes["branch"], "main");
    assert_eq!(changes["upstream"], "base");
    assert_eq!(changes["ahead"], 1);
    assert_eq!(changes["behind"], 0);
    let files = changes["files"].as_array().unwrap();
    assert!(files.contains(
        &json!({ "path": "new name.txt", "index": "R", "worktree": " ",
        "origPath": "old name.txt" })
    ));
    assert!(files.contains(&json!({ "path": "a.txt", "index": " ", "worktree": "M" })));
    // core.quotepath=false: names as they are.
    assert!(files.contains(&json!({ "path": "ünïcode.txt", "index": "?", "worktree": "?" })));

    let diff = git_diff(&*HOST, ws, &env, Some("a.txt"), false, false)
        .await
        .unwrap();
    assert!(diff["diff"].as_str().unwrap().contains("+three"));
    assert_eq!(diff["truncated"], false);
    let staged = git_diff(&*HOST, ws, &env, None, true, false).await.unwrap();
    assert!(
        staged["diff"]
            .as_str()
            .unwrap()
            .contains("rename to new name.txt")
    );
    let untracked = git_diff(&*HOST, ws, &env, Some("-dash.txt"), true, true)
        .await
        .unwrap();
    assert!(untracked["diff"].as_str().unwrap().contains("+dash"));
    let glob = git_diff(&*HOST, ws, &env, Some("*.txt"), false, false)
        .await
        .unwrap();
    assert_eq!(glob["diff"], "");
    assert_eq!(
        git_diff(&*HOST, ws, &env, Some("../secret.txt"), false, false)
            .await
            .unwrap_err()
            .status,
        400
    );

    let log = git_log(&*HOST, ws, &env, 0, 1).await.unwrap();
    assert_eq!(log["more"], true);
    let head = &log["commits"][0];
    assert_eq!(head["subject"], "second commit");
    assert_eq!(head["author"], "Ada");
    assert_eq!(head["email"], "ada@example.com");
    assert_eq!(head["time"], json!(1_700_000_000_000_u64));
    assert_eq!(head["refs"], json!(["HEAD -> main", "tag: v1"]));
    let rest = git_log(&*HOST, ws, &env, 1, 50).await.unwrap();
    assert_eq!(rest["more"], false);
    assert_eq!(rest["commits"][0]["refs"], json!(["base"]));

    let sha = head["sha"].as_str().unwrap().to_uppercase();
    let show = git_show(&*HOST, ws, &env, &sha).await.unwrap();
    assert_eq!(show["message"], "second commit\n\nWith a body.");
    assert_eq!(show["time"], json!(1_700_000_000_000_u64));
    let patch = show["diff"].as_str().unwrap();
    assert!(patch.starts_with(" a.txt | 1 +"), "{patch}");
    assert!(patch.contains("+two"));
    let unknown = git_show(&*HOST, ws, &env, "deadbeef0").await.unwrap_err();
    assert_eq!(unknown.status, 400);

    // A subdirectory of the repository: its path and only its files.
    std::fs::create_dir(ws.join("sub")).unwrap();
    std::fs::write(ws.join("sub/inner.txt"), "x").unwrap();
    let sub = git_status(&*HOST, &ws.join("sub"), &env).await.unwrap();
    assert_eq!(sub["root"], "sub");
    assert_eq!(
        sub["files"],
        json!([{ "path": "sub/inner.txt", "index": "?", "worktree": "?" }])
    );
}

/// Security audit S8: every git call goes through `prepare_readonly`
/// (the workspace, git's flags) and is cleaned up; what the repository's
/// config makes git run (a clean filter here) runs beneath the sandbox
/// wrapper, with the caller's environment and the sandbox's.
#[tokio::test]
async fn git_runs_in_the_sandbox() {
    let f = fixture();
    let ws = &f.ws;
    let env = env(&f.run);
    let sandbox = FakeSandbox::new(None);
    run_git(ws, &["init", "-q", "-b", "main"]);
    std::fs::write(ws.join(".gitattributes"), "*.txt filter=x\n").unwrap();
    std::fs::write(ws.join("a.txt"), "one\n").unwrap();
    run_git(ws, &["add", "."]);
    run_git(ws, &["commit", "-q", "-m", "first"]);
    let marker = f.run.join("marker");
    run_git(
        ws,
        &[
            "config",
            "filter.x.clean",
            &format!(
                "sh -c 'echo \"$PIRC_TEST_SANDBOXED $PIRC_TEST_PREPARED\" >> {}; cat'",
                marker.display()
            ),
        ],
    );
    std::fs::write(ws.join("a.txt"), "one\ntwo\n").unwrap();

    let status = git_status(&sandbox, ws, &env).await.unwrap();
    assert_eq!(status["repo"], true);
    let diff = git_diff(&sandbox, ws, &env, Some("a.txt"), false, false)
        .await
        .unwrap();
    assert!(diff["diff"].as_str().unwrap().contains("+two"));
    let log = git_log(&sandbox, ws, &env, 0, 50).await.unwrap();
    let sha = log["commits"][0]["sha"].as_str().unwrap().to_owned();
    git_show(&sandbox, ws, &env, &sha).await.unwrap();

    let marks = std::fs::read_to_string(&marker).unwrap();
    assert!(!marks.is_empty());
    assert!(marks.lines().all(|line| line == "1 1"), "{marks}");
    let calls = sandbox.calls.lock().unwrap().clone();
    // status: rev-parse + status; diff; log: rev-parse + log; show: 2.
    assert_eq!(calls.len(), 7);
    for call in &calls {
        assert_eq!(call.workspace_root, *ws);
        assert_eq!(
            call.command[..8],
            [
                "git",
                "--no-pager",
                "-c",
                "core.quotepath=false",
                "-c",
                "core.fsmonitor=false",
                "-c",
                "color.ui=false"
            ]
            .map(OsString::from)
        );
    }
    assert_eq!(calls[1].command[8], "status");
    assert_eq!(sandbox.cleaned.load(Ordering::SeqCst), 7);
}

/// Without a sandbox the Git panel is unavailable: 503, never "not a
/// repository" or an empty history, and git never runs.
#[tokio::test]
async fn git_is_unavailable_without_a_sandbox() {
    let f = fixture();
    let env = env(&f.run);
    run_git(&f.ws, &["init", "-q", "-b", "main"]);
    let sandbox = FakeSandbox::new(Some("bubblewrap is missing"));
    let expected = (
        503,
        "runner_unavailable".to_owned(),
        "The Git panel runs git in the sandbox, and it is unavailable on this node: bubblewrap is missing"
            .to_owned(),
    );
    assert_eq!(
        status(git_status(&sandbox, &f.ws, &env).await.unwrap_err()),
        expected
    );
    assert_eq!(
        status(git_log(&sandbox, &f.ws, &env, 0, 50).await.unwrap_err()),
        expected
    );
    assert_eq!(
        status(
            git_diff(&sandbox, &f.ws, &env, None, false, false)
                .await
                .unwrap_err()
        ),
        expected
    );
    assert_eq!(
        status(
            git_show(&sandbox, &f.ws, &env, "abcd1234")
                .await
                .unwrap_err()
        ),
        expected
    );
    assert!(sandbox.calls.lock().unwrap().is_empty());
}

/// A sandbox that fails once git is prepared (bubblewrap's own exit 1: a
/// mount gone since the plan, git missing) is 503 too, never git's "no":
/// not a clean repository, an empty history or an empty diff.
#[tokio::test]
async fn a_failing_sandbox_is_not_a_clean_repository() {
    let f = fixture();
    let env = env(&f.run);
    run_git(&f.ws, &["init", "-q", "-b", "main"]);
    let mut sandbox = FakeSandbox::new(None);
    sandbox.broken = Some("fakewrap: execvp git: No such file or directory");
    let expected = (
        503,
        "runner_unavailable".to_owned(),
        "The Git panel runs git in the sandbox, and it is unavailable on this node: fakewrap: execvp git: No such file or directory"
            .to_owned(),
    );
    assert_eq!(
        status(git_status(&sandbox, &f.ws, &env).await.unwrap_err()),
        expected
    );
    assert_eq!(
        status(git_log(&sandbox, &f.ws, &env, 0, 50).await.unwrap_err()),
        expected
    );
    assert_eq!(
        status(
            git_diff(&sandbox, &f.ws, &env, None, false, false)
                .await
                .unwrap_err()
        ),
        expected
    );
    // git's own exit 1 is still an answer (`diff --no-index` of a new file).
    std::fs::write(f.ws.join("new.txt"), "x\n").unwrap();
    let diff = git_diff(&*HOST, &f.ws, &env, Some("new.txt"), false, true)
        .await
        .unwrap();
    assert!(diff["diff"].as_str().unwrap().contains("+x"), "{diff}");
}

/// A sandbox the probe found working that refuses this command (a plan
/// refusal, a profile too long) answers in the Git panel's words.
#[tokio::test]
async fn a_refused_readonly_sandbox_is_the_git_panels_503() {
    let f = fixture();
    let env = env(&f.run);
    let mut sandbox = FakeSandbox::new(None);
    sandbox.refused = Some("the protected path goes through a symbolic link");
    let error = git_status(&sandbox, &f.ws, &env).await.unwrap_err();
    assert_eq!(
        status(error),
        (
            503,
            "runner_unavailable".to_owned(),
            "The Git panel runs git in the sandbox, and it is unavailable on this node: the protected path goes through a symbolic link"
                .to_owned(),
        )
    );
}

/// A git that outlives its deadline is killed with its whole process
/// group (the sandbox wrapper's children too), and the answer does not wait
/// past the drain for a process that left the group but holds the pipe.
#[tokio::test]
async fn a_stuck_git_is_killed_with_its_group() {
    let f = fixture();
    let pid_file = f.run.join("child.pid");
    let script = format!(
        "sleep 100 & echo $! > {}; (command -v setsid >/dev/null && setsid sleep 5) & echo started; wait",
        pid_file.display()
    );
    let prepared = Prepared::new(
        PathBuf::from("/bin/sh"),
        vec!["-c".into(), script.into()],
        Vec::new(),
        SessionPolicy::default(),
        Vec::new(),
        None,
        || {},
    );
    let started = std::time::Instant::now();
    let timeout = Duration::from_millis(500);
    let error = run_prepared(&prepared, &f.ws, &env(&f.run), timeout)
        .await
        .err()
        .unwrap();
    let elapsed = started.elapsed();
    let GitError::Api(error) = error else {
        panic!("not an exit code")
    };
    assert_eq!(error.message, "git exited with 137");
    assert!(
        elapsed >= timeout && elapsed < timeout + KILL_DRAIN + Duration::from_secs(2),
        "{elapsed:?}"
    );
    let pid: i32 = std::fs::read_to_string(&pid_file)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    let pid = nix::unistd::Pid::from_raw(pid);
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while nix::sys::signal::kill(pid, None).is_ok() {
        assert!(
            std::time::Instant::now() < deadline,
            "the group's child lives on"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// Git LFS's storage goes to the sandbox's temp directory, as `-c` would
/// put it, after the pairs the node's environment already has.
#[tokio::test]
async fn lfs_storage_is_the_sandboxs_temp_directory() {
    let f = fixture();
    let mut env = env(&f.run);
    env.insert("GIT_CONFIG_COUNT".to_owned(), "1".to_owned());
    env.insert("GIT_CONFIG_KEY_0".to_owned(), "core.abbrev".to_owned());
    env.insert("GIT_CONFIG_VALUE_0".to_owned(), "9".to_owned());
    let prepared = Prepared::new(
        PathBuf::from("/bin/sh"),
        vec![
            "-c".into(),
            "git config --get lfs.storage && git config --get core.abbrev".into(),
        ],
        Vec::new(),
        SessionPolicy::default(),
        Vec::new(),
        None,
        || {},
    )
    .with_temp_dir(f.run.join("tmp"));
    let result = run_prepared(&prepared, &f.ws, &env, GIT_TIMEOUT)
        .await
        .ok()
        .unwrap();
    assert_eq!(
        result.stdout,
        format!("{}\n9\n", f.run.join("tmp/lfs").display())
    );
}
