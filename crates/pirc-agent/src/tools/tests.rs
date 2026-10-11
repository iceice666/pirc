//! The core tools (`agent-core.test.ts` tool parts); expected texts were
//! recorded from the TS tools.

use std::fs;
use std::os::unix::fs::symlink;

use serde_json::{Value, json};

use super::bash::{BashTool, ShellOptions, run_shell};
use super::testing::{self, args, text_of};
use super::*;
use crate::signal::{AbortController, AbortSignal};

struct Fixture {
    _dir: tempfile::TempDir,
    root: String,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap().display().to_string();
        let ws = format!("{root}/ws");
        fs::create_dir_all(format!("{ws}/src/deep")).unwrap();
        fs::create_dir_all(format!("{ws}/node_modules/x")).unwrap();
        fs::create_dir_all(format!("{ws}/_u")).unwrap();
        fs::create_dir_all(format!("{ws}/B")).unwrap();
        fs::write(format!("{ws}/hello.txt"), "line one\nline two\n").unwrap();
        fs::write(format!("{ws}/a.txt"), "alpha\nbeta\ngamma\nbeta\n").unwrap();
        fs::write(
            format!("{ws}/src/lib.rs"),
            "pub fn answer() -> u32 {\n    42\n}\n",
        )
        .unwrap();
        fs::write(format!("{ws}/src/notes.md"), "notes\nTODO: x\n").unwrap();
        fs::write(format!("{ws}/src/deep/x.ts"), "deep TODO\n").unwrap();
        fs::write(format!("{ws}/node_modules/x/i.js"), "TODO hidden\n").unwrap();
        fs::write(format!("{ws}/bin.dat"), "bin\0ary TODO").unwrap();
        fs::write(format!("{ws}/bad.txt"), b"\xff\xfeTODO bad utf8\n").unwrap();
        for file in [".hidden", "Zeta", "zeta", "_u/f", "B/f"] {
            fs::write(format!("{ws}/{file}"), "").unwrap();
        }
        symlink("hello.txt", format!("{ws}/link")).unwrap();
        Self { _dir: dir, root }
    }

    fn ws(&self) -> String {
        format!("{}/ws", self.root)
    }

    fn context(&self) -> testing::Context {
        testing::context(testing::config(&self.ws(), json!({})), AbortSignal::never())
    }

    async fn call(&self, name: &str, request: Value) -> Result<ToolResult, String> {
        let tools = builtin_tools();
        let tool = tools.iter().find(|tool| tool.name() == name).unwrap();
        tool.execute(args(request), self.context().ctx).await
    }

    async fn text(&self, name: &str, request: Value) -> String {
        text_of(&self.call(name, request).await.unwrap())
    }

    async fn data(&self, name: &str, request: Value) -> Value {
        Value::Object(self.call(name, request).await.unwrap().data.unwrap())
    }
}

/// A bash for systems without `/bin/bash`.
fn bash() -> String {
    std::env::var("PATH")
        .unwrap_or_default()
        .split(':')
        .map(|dir| format!("{dir}/bash"))
        .find(|path| std::path::Path::new(path).exists())
        .expect("bash on PATH")
}

#[test]
fn lists_the_builtin_tools_in_order() {
    let names: Vec<String> = builtin_tools()
        .iter()
        .map(|tool| tool.name().to_owned())
        .collect();
    assert_eq!(
        names,
        ["read", "write", "edit", "bash", "ls", "find", "grep"]
    );
    assert!(builtin_tools().iter().all(|tool| tool.ptc()));
}

#[tokio::test]
async fn reads_text_with_line_numbers_and_typed_data() {
    let f = Fixture::new();
    assert_eq!(
        f.text("read", json!({ "path": "hello.txt" })).await,
        "1\tline one\n2\tline two\n3\t"
    );
    let result = f
        .call("read", json!({ "path": "a.txt", "offset": 2, "limit": 2 }))
        .await
        .unwrap();
    assert_eq!(
        text_of(&result),
        "2\tbeta\n3\tgamma\n\n[Showing lines 2-3 of 5. Use offset=4 to continue.]"
    );
    assert_eq!(
        Value::Object(result.data.unwrap()),
        json!({
            "kind": "text", "path": "a.txt", "content": "beta\ngamma", "contentTruncated": false,
            "offset": 2, "lines": 2, "totalLines": 5, "nextOffset": 4, "truncated": false,
        })
    );
    assert_eq!(
        f.text(
            "read",
            json!({ "path": "a.txt", "offset": 2.7, "limit": 0 })
        )
        .await,
        "2\tbeta\n\n[Showing lines 2-2 of 5. Use offset=3 to continue.]"
    );
    assert_eq!(
        f.data("read", json!({ "path": "a.txt", "offset": 10 }))
            .await["nextOffset"],
        Value::Null
    );
    assert_eq!(
        f.text("read", json!({ "path": "bad.txt" })).await,
        "1\t\u{FFFD}\u{FFFD}TODO bad utf8\n2\t"
    );
    assert_eq!(
        f.text("read", json!({ "path": "link" })).await,
        "1\tline one\n2\tline two\n3\t"
    );
}

#[tokio::test]
async fn reports_read_errors_like_bun() {
    let f = Fixture::new();
    let ws = f.ws();
    assert_eq!(
        f.call("read", json!({ "path": "missing.txt" }))
            .await
            .unwrap_err(),
        format!("ENOENT: no such file or directory, stat '{ws}/missing.txt'")
    );
    assert_eq!(
        f.call("read", json!({ "path": "src" })).await.unwrap_err(),
        "src is a directory; use ls"
    );
    assert_eq!(
        f.call("read", json!({ "path": "a.txt", "offset": "x" }))
            .await
            .unwrap_err(),
        "offset must be a number"
    );
    assert_eq!(
        f.call("read", json!({ "path": "" })).await.unwrap_err(),
        "path must be a non-empty string"
    );
}

#[tokio::test]
async fn reads_images_as_images() {
    let f = Fixture::new();
    fs::write(format!("{}/pixel.PNG", f.ws()), [0x89, b'P', b'N', b'G']).unwrap();
    let result = f
        .call("read", json!({ "path": "pixel.PNG" }))
        .await
        .unwrap();
    assert_eq!(text_of(&result), "Image pixel.PNG (4 bytes)");
    assert_eq!(
        result.content[1],
        pirc_protocol::UserBlock::Image {
            data: "iVBORw==".to_owned(),
            mime_type: "image/png".to_owned()
        }
    );
    assert_eq!(
        Value::Object(result.data.unwrap()),
        json!({ "kind": "image", "path": "pixel.PNG", "mimeType": "image/png", "bytes": 4 })
    );
}

#[tokio::test]
async fn lists_directories_in_locale_order() {
    let f = Fixture::new();
    assert_eq!(
        f.text("ls", json!({})).await,
        "_u/\n.hidden\na.txt\nB/\nbad.txt\nbin.dat\nhello.txt\nlink\nnode_modules/\nsrc/\nzeta\nZeta"
    );
    let data = f.data("ls", json!({ "path": "src" })).await;
    assert_eq!(
        data,
        json!({
            "entries": [
                { "name": "deep", "type": "directory" },
                { "name": "lib.rs", "type": "file" },
                { "name": "notes.md", "type": "file" },
            ],
            "total": 3,
            "truncated": false,
        })
    );
    fs::create_dir(format!("{}/empty", f.ws())).unwrap();
    assert_eq!(f.text("ls", json!({ "path": "empty" })).await, "(empty)");
    assert_eq!(
        f.call("ls", json!({ "path": "missing" }))
            .await
            .unwrap_err(),
        format!(
            "ENOENT: no such file or directory, scandir '{}/missing'",
            f.ws()
        )
    );
    assert_eq!(
        f.call("ls", json!({ "path": "hello.txt" }))
            .await
            .unwrap_err(),
        format!("ENOTDIR: not a directory, scandir '{}/hello.txt'", f.ws())
    );
}

#[tokio::test]
async fn finds_files_by_glob_skipping_dependency_dirs() {
    let f = Fixture::new();
    assert_eq!(
        f.text("find", json!({ "pattern": "**/*.ts" })).await,
        "src/deep/x.ts"
    );
    assert_eq!(
        f.text("find", json!({ "pattern": "*.{md,rs}", "path": "src" }))
            .await,
        "lib.rs\nnotes.md"
    );
    assert_eq!(
        f.text("find", json!({ "pattern": "*" })).await,
        ".hidden\nZeta\na.txt\nbad.txt\nbin.dat\nhello.txt\nzeta"
    );
    assert_eq!(
        f.text("find", json!({ "pattern": "nothing" })).await,
        "No matches"
    );
    assert_eq!(
        f.data("find", json!({ "pattern": "*", "path": "missing" }))
            .await,
        json!({ "paths": [], "truncated": false })
    );
}

#[tokio::test]
async fn greps_with_javascript_regexes() {
    let f = Fixture::new();
    let all = f.text("grep", json!({ "pattern": "TODO" })).await;
    let mut lines: Vec<&str> = all.lines().collect();
    lines.sort_unstable();
    assert_eq!(
        lines,
        [
            "bad.txt:1: \u{FFFD}\u{FFFD}TODO bad utf8",
            "src/deep/x.ts:1: deep TODO",
            "src/notes.md:2: TODO: x",
        ]
    );
    assert_eq!(
        f.text(
            "grep",
            json!({ "pattern": "todo", "ignoreCase": true, "glob": "*.md" })
        )
        .await,
        "src/notes.md:2: TODO: x"
    );
    assert_eq!(
        f.data("grep", json!({ "pattern": "TODO", "path": "src/notes.md" }))
            .await,
        json!({
            "matches": [{ "path": "notes.md", "line": 2, "text": "TODO: x" }],
            "truncated": false,
        })
    );
    assert_eq!(
        f.text(
            "grep",
            json!({ "pattern": "beta", "path": "a.txt", "limit": 1 })
        )
        .await,
        "a.txt:2: beta\n[limit 1 reached]"
    );
    assert_eq!(
        f.text("grep", json!({ "pattern": "(?<=a)l", "path": "a.txt" }))
            .await,
        "a.txt:1: alpha"
    );
    assert_eq!(
        f.call("grep", json!({ "pattern": "(" })).await.unwrap_err(),
        "Invalid regular expression: missing )"
    );
    assert_eq!(
        f.call("grep", json!({ "pattern": "x", "path": "missing" }))
            .await
            .unwrap_err(),
        format!(
            "ENOENT: no such file or directory, stat '{}/missing'",
            f.ws()
        )
    );
}

#[tokio::test]
async fn edits_files_and_reports_a_diff() {
    let f = Fixture::new();
    assert_eq!(
        f.call(
            "edit",
            json!({ "path": "a.txt", "oldText": "beta", "newText": "B" })
        )
        .await
        .unwrap_err(),
        "oldText matches 2 times in a.txt; add context or set replaceAll"
    );
    assert_eq!(
        f.call(
            "edit",
            json!({ "path": "a.txt", "oldText": "zzz", "newText": "B" })
        )
        .await
        .unwrap_err(),
        "oldText not found in a.txt"
    );
    let result = f
        .call(
            "edit",
            json!({ "path": "a.txt", "oldText": "beta", "newText": "B", "replaceAll": true }),
        )
        .await
        .unwrap();
    assert_eq!(text_of(&result), "Edited a.txt (2 replacements)");
    let diff = "--- a.txt\n+++ a.txt\n@@ -1 +1 @@\n alpha\n-beta\n-gamma\n-beta\n+B\n+gamma\n+B\n ";
    assert_eq!(result.details, Some(json!({ "diff": diff })));
    assert_eq!(
        Value::Object(result.data.unwrap()),
        json!({ "path": "a.txt", "replacements": 2, "diff": diff })
    );
    assert_eq!(
        fs::read_to_string(format!("{}/a.txt", f.ws())).unwrap(),
        "alpha\nB\ngamma\nB\n"
    );
    let one = f
        .call(
            "edit",
            json!({ "path": "hello.txt", "oldText": "line one", "newText": "first\nsecond" }),
        )
        .await
        .unwrap();
    assert_eq!(text_of(&one), "Edited hello.txt (1 replacement)");
    assert_eq!(
        one.details.unwrap()["diff"],
        "--- hello.txt\n+++ hello.txt\n@@ -1 +1 @@\n-line one\n+first\n+second\n line two\n "
    );
    assert_eq!(
        f.call(
            "edit",
            json!({ "path": "src", "oldText": "a", "newText": "b" })
        )
        .await
        .unwrap_err(),
        "EISDIR: illegal operation on a directory, read"
    );
}

#[tokio::test]
async fn writes_files_creating_parents_and_taking_the_lease() {
    let f = Fixture::new();
    let context = f.context();
    let tools = builtin_tools();
    let write = &tools[1];
    let result = write
        .execute(
            args(json!({ "path": "sub/dir/new.txt", "content": "héllo" })),
            context.ctx.clone(),
        )
        .await
        .unwrap();
    assert_eq!(text_of(&result), "Wrote 6 bytes to sub/dir/new.txt");
    assert_eq!(
        Value::Object(result.data.unwrap()),
        json!({ "path": "sub/dir/new.txt", "bytes": 6 })
    );
    assert_eq!(
        fs::read_to_string(format!("{}/sub/dir/new.txt", f.ws())).unwrap(),
        "héllo"
    );
    assert_eq!(
        *context.leases.borrow(),
        [format!("{}/sub/dir/new.txt", f.ws())]
    );
    // A refused lease writes nothing.
    *context.refuse.borrow_mut() = Some("busy elsewhere".to_owned());
    assert_eq!(
        write
            .execute(
                args(json!({ "path": "other/b.txt", "content": "x" })),
                context.ctx.clone()
            )
            .await
            .unwrap_err(),
        "busy elsewhere"
    );
    assert!(!std::path::Path::new(&format!("{}/other", f.ws())).exists());
    assert_eq!(
        f.call("write", json!({ "path": "n.txt", "content": 1 }))
            .await
            .unwrap_err(),
        "content must be a string"
    );
    assert_eq!(
        f.call("write", json!({ "path": "src", "content": "x" }))
            .await
            .unwrap_err(),
        format!(
            "EISDIR: illegal operation on a directory, open '{}/src'",
            f.ws()
        )
    );
}

#[tokio::test]
async fn keeps_writes_inside_the_writable_paths() {
    let f = Fixture::new();
    let outside = format!("{}/outside", f.root);
    fs::create_dir(&outside).unwrap();
    fs::write(format!("{outside}/notes.txt"), "readable").unwrap();
    symlink(&outside, format!("{}/escape", f.ws())).unwrap();
    // Reads anywhere.
    assert_eq!(
        f.text("read", json!({ "path": format!("{outside}/notes.txt") }))
            .await,
        "1\treadable"
    );
    let refused = f
        .call("write", json!({ "path": "escape/new.txt", "content": "x" }))
        .await
        .unwrap_err();
    assert!(refused.contains("outside the writable paths"), "{refused}");
    assert!(!std::path::Path::new(&format!("{outside}/new.txt")).exists());
    // A dangling link is refused, a link to an outside file is re-checked.
    symlink(format!("{outside}/missing"), format!("{}/dangling", f.ws())).unwrap();
    assert_eq!(
        f.call("write", json!({ "path": "dangling", "content": "x" }))
            .await
            .unwrap_err(),
        "dangling is a symbolic link to a missing target; refusing to write through it"
    );
    symlink(
        format!("{outside}/notes.txt"),
        format!("{}/out-link", f.ws()),
    )
    .unwrap();
    let refused = f
        .call(
            "edit",
            json!({ "path": "out-link", "oldText": "r", "newText": "x" }),
        )
        .await
        .unwrap_err();
    assert!(refused.contains("outside the writable paths"), "{refused}");
    assert_eq!(
        fs::read_to_string(format!("{outside}/notes.txt")).unwrap(),
        "readable"
    );
    let refused = f
        .call(
            "write",
            json!({ "path": ".pirc/config.json", "content": "{}" }),
        )
        .await
        .unwrap_err();
    assert!(refused.contains("protected"), "{refused}");
}

#[tokio::test]
async fn runs_shell_commands_with_exit_codes_and_timeouts() {
    let f = Fixture::new();
    let context = f.context();
    let tool = BashTool::with_shell(&bash());
    let result = tool
        .execute(
            args(json!({ "command": "cat a.txt; exit 3" })),
            context.ctx.clone(),
        )
        .await
        .unwrap();
    assert_eq!(text_of(&result), "alpha\nbeta\ngamma\nbeta\n[exit 3]");
    assert!(result.is_error);
    assert_eq!(
        result.details,
        Some(json!({ "exitCode": 3, "truncated": false }))
    );
    assert_eq!(
        Value::Object(result.data.unwrap()),
        json!({
            "output": "alpha\nbeta\ngamma\nbeta\n", "exitCode": 3, "timedOut": false,
            "aborted": false, "truncated": false,
        })
    );
    assert!(!context.updates.borrow().is_empty());
    let ok = tool
        .execute(
            args(json!({ "command": "printf hi >&2" })),
            context.ctx.clone(),
        )
        .await
        .unwrap();
    assert_eq!(text_of(&ok), "hi\n[exit 0]");
    assert!(!ok.is_error);
    let quiet = tool
        .execute(args(json!({ "command": "true" })), context.ctx.clone())
        .await
        .unwrap();
    assert_eq!(text_of(&quiet), "[exit 0]");
    let started = std::time::Instant::now();
    let slow = tool
        .execute(
            args(json!({ "command": "sleep 5", "timeout": 0.3 })),
            context.ctx.clone(),
        )
        .await
        .unwrap();
    assert!(started.elapsed() < std::time::Duration::from_secs(3));
    assert_eq!(text_of(&slow), "[timed out]");
    assert!(slow.is_error);
    assert_eq!(slow.data.unwrap()["exitCode"], Value::Null);
}

#[tokio::test]
async fn aborts_shell_commands_and_caps_output() {
    let f = Fixture::new();
    let controller = AbortController::new();
    let signal = controller.signal();
    let ws = f.ws();
    let shell = bash();
    let local = tokio::task::LocalSet::new();
    let result = local
        .run_until(async move {
            let run = tokio::task::spawn_local(async move {
                run_shell(
                    &shell,
                    "sleep 5 & sleep 5",
                    ShellOptions {
                        cwd: &ws,
                        env: &[],
                        timeout_ms: 60_000,
                        max_bytes: 1000,
                        signal: &signal,
                        on_output: None,
                    },
                )
                .await
            });
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            controller.abort();
            run.await.unwrap().unwrap()
        })
        .await;
    assert!(result.aborted);
    assert_eq!(result.exit_code, None);

    let big = run_shell(
        &bash(),
        "head -c 5000 /dev/zero | tr '\\0' x; echo; echo end",
        ShellOptions {
            cwd: &f.ws(),
            env: &[("PIRC_X".to_owned(), "1".to_owned())],
            timeout_ms: 60_000,
            max_bytes: 1000,
            signal: &AbortSignal::never(),
            on_output: None,
        },
    )
    .await
    .unwrap();
    // The 4x window keeps 4,000 characters, then the cut keeps 1,000 bytes.
    assert!(big.truncated);
    assert!(
        big.output.contains("[… 3000 bytes truncated …]"),
        "{}",
        big.output
    );
    assert!(big.output.ends_with("end\n"));
    let env = run_shell(
        &bash(),
        "echo $PIRC_X",
        ShellOptions {
            cwd: &f.ws(),
            env: &[("PIRC_X".to_owned(), "from-env".to_owned())],
            timeout_ms: 60_000,
            max_bytes: 1000,
            signal: &AbortSignal::never(),
            on_output: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(env.output, "from-env\n");
    assert_eq!(env.exit_code, Some(0));
}

#[tokio::test]
async fn dropping_a_shell_run_kills_its_process_group() {
    let f = Fixture::new();
    let ws = f.ws();
    let pid_file = std::path::Path::new(&ws).join("child.pid");
    let command = format!("sleep 30 & echo $! > '{}'; wait", pid_file.display());
    let (shell, never) = (bash(), AbortSignal::never());
    let run = run_shell(
        &shell,
        &command,
        ShellOptions {
            cwd: &ws,
            env: &[],
            timeout_ms: 60_000,
            max_bytes: 1000,
            signal: &never,
            on_output: None,
        },
    );
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(500), run)
            .await
            .is_err()
    );
    let pid: i32 = std::fs::read_to_string(&pid_file)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    // Gone (a zombie is reaped by its new parent right away).
    let alive = || {
        nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None)
            != Err(nix::errno::Errno::ESRCH)
    };
    for _ in 0..50 {
        if !alive() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    panic!("the background sleep outlived its dropped shell run");
}

#[tokio::test]
async fn reports_a_missing_shell_like_bun() {
    let f = Fixture::new();
    let tool = BashTool::with_shell("/nonexistent/bash");
    assert_eq!(
        tool.execute(args(json!({ "command": "true" })), f.context().ctx)
            .await
            .unwrap_err(),
        "ENOENT: no such file or directory, posix_spawn '/nonexistent/bash'"
    );
}

#[test]
fn decodes_streams_like_text_decoder() {
    let mut decoder = super::bash::StreamDecoder::default();
    assert_eq!(decoder.decode(b"a\xc3"), "a");
    assert_eq!(decoder.decode(b"\xa9b\xff"), "\u{e9}b\u{FFFD}");
}
