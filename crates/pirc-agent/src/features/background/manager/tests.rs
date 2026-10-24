//! The `TaskManager` cases of `agent-background.test.ts`, and its pure
//! logic.

use super::*;

use std::future::Future;

fn options(command: &str) -> StartOptions<'_> {
    StartOptions {
        command,
        cwd: "/tmp",
        ..StartOptions::default()
    }
}

/// Run on a `LocalSet`, as the agent does (drivers are local tasks).
async fn local<F: Future>(future: F) -> F::Output {
    tokio::task::LocalSet::new().run_until(future).await
}

/// Finished tasks (`id:status`) and matched lines the hooks saw.
#[derive(Default)]
struct Seen {
    finished: RefCell<Vec<String>>,
    lines: RefCell<Vec<String>>,
}

fn manager(seen: &Rc<Seen>) -> TaskManager {
    let finished = seen.clone();
    let lines = seen.clone();
    TaskManager::new(Hooks {
        on_finish: Some(Box::new(move |task| {
            finished
                .finished
                .borrow_mut()
                .push(format!("{}:{}", task.id, task.status.as_str()));
        })),
        on_match: Some(Box::new(move |_task, line| {
            lines.lines.borrow_mut().push(line)
        })),
        ..Hooks::default()
    })
}

#[tokio::test]
async fn captures_output_exit_codes_and_wait_outcomes() {
    local(async {
        let seen = Rc::new(Seen::default());
        let manager = manager(&seen);
        let ok = manager.start(options("echo hello; echo err >&2")).unwrap();
        let bad = manager.start(options("exit 3")).unwrap();
        assert_eq!(ok.status, TaskStatus::Running);
        assert!(ok.pid.is_some());
        let done = manager.wait(&ok.id, None, None).await.unwrap();
        assert_eq!(done.outcome, Outcome::Finished);
        assert_eq!(done.task.status, TaskStatus::Completed);
        assert_eq!(done.task.exit_code, Some(Some(0)));
        assert_eq!(done.task.signal, Some(None));
        let output = manager.output(&ok.id, 200).unwrap();
        assert!(
            output.contains("hello") && output.contains("err"),
            "{output}"
        );
        let failed = manager.wait(&bad.id, None, None).await.unwrap();
        assert_eq!(failed.task.status, TaskStatus::Failed);
        assert_eq!(failed.task.exit_code, Some(Some(3)));
        let slow = manager.start(options("sleep 5")).unwrap();
        let waited = manager.wait(&slow.id, Some(0.1), None).await.unwrap();
        assert_eq!(waited.outcome, Outcome::TimedOut);
        assert_eq!(manager.get(&slow.id).unwrap().status, TaskStatus::Running);
        assert_eq!(seen.finished.borrow().len(), 2);
        // The log holds what was printed.
        let log = std::fs::read_to_string(&ok.log_path).unwrap();
        assert!(log.contains("hello"));
        manager.shutdown().await;
        // No finish callbacks during shutdown.
        assert_eq!(seen.finished.borrow().len(), 2);
    })
    .await;
}

#[tokio::test]
async fn stops_process_groups_and_enforces_timeouts_and_the_active_limit() {
    local(async {
        let manager = TaskManager::new(Hooks::default());
        let started = std::time::Instant::now();
        let tree = manager.start(options("sleep 30 & sleep 30; wait")).unwrap();
        let stopped = manager.stop(&tree.id).await.unwrap();
        assert_eq!(stopped.status, TaskStatus::Stopped);
        assert_eq!(stopped.exit_code, Some(None));
        assert_eq!(stopped.signal, Some(Some("SIGTERM".to_owned())));
        assert!(started.elapsed() < Duration::from_secs(2));
        let timed = manager
            .start(StartOptions {
                timeout: Some(0.2),
                ..options("sleep 30")
            })
            .unwrap();
        let result = manager.wait(&timed.id, None, None).await.unwrap();
        assert_eq!(result.task.status, TaskStatus::TimedOut);
        for _ in 0..8 {
            manager.start(options("sleep 30")).unwrap();
        }
        assert_eq!(
            manager.start(options("true")).unwrap_err(),
            "At most 8 background tasks may be active"
        );
        manager.shutdown().await;
        assert_eq!(manager.active_count(), 0);
        assert_eq!(
            manager.start(options("true")).unwrap_err(),
            "Task manager is shut down"
        );
        // A shell that exits while a child keeps the pipes open still finishes.
        let other = TaskManager::new(Hooks::default());
        let orphan = other.start(options("(sleep 30 &) ; echo done")).unwrap();
        let result = other.wait(&orphan.id, Some(5.0), None).await.unwrap();
        assert_eq!(result.outcome, Outcome::Finished);
        assert_eq!(result.task.status, TaskStatus::Completed);
    })
    .await;
}

#[tokio::test]
async fn checks_its_arguments() {
    local(async {
        let manager = TaskManager::new(Hooks::default());
        let command_error =
            "command must be a nonempty string of at most 16000 characters without NUL characters";
        assert_eq!(manager.start(options("  ")).unwrap_err(), command_error);
        assert_eq!(manager.start(options("a\0b")).unwrap_err(), command_error);
        assert_eq!(
            manager.start(options(&"x".repeat(16001))).unwrap_err(),
            command_error
        );
        for cwd in ["tmp", "/nonexistent-dir", "/etc/hostname"] {
            assert_eq!(
                manager
                    .start(StartOptions {
                        cwd,
                        ..options("true")
                    })
                    .unwrap_err(),
                "cwd must be an existing absolute directory"
            );
        }
        for timeout in [0.0, -1.0, f64::INFINITY, 2_147_484.0] {
            assert_eq!(
                manager
                    .start(StartOptions {
                        timeout: Some(timeout),
                        ..options("true")
                    })
                    .unwrap_err(),
                "timeout must be positive seconds, at most 2147483.647"
            );
        }
        assert_eq!(
            manager.get("nope").unwrap_err(),
            "Unknown background task: nope"
        );
        assert_eq!(
            manager.stop("nope").await.unwrap_err(),
            "Unknown background task: nope"
        );
        let task = manager.start(options("echo x")).unwrap();
        for wait in [0.0, 86401.0, f64::NAN] {
            assert_eq!(
                manager.wait(&task.id, Some(wait), None).await.unwrap_err(),
                "wait timeout must be positive seconds, at most 86400"
            );
        }
        assert_eq!(
            manager.output(&task.id, 0).unwrap_err(),
            "lines must be a positive safe integer"
        );
        assert_eq!(
            manager.write(&task.id, "").unwrap_err(),
            "input must be 1–65536 characters"
        );
        let aborted = crate::signal::AbortController::new();
        aborted.abort();
        let result = manager
            .wait(&task.id, None, Some(&aborted.signal()))
            .await
            .unwrap();
        assert_eq!(result.outcome, Outcome::Aborted);
        manager.wait(&task.id, None, None).await.unwrap();
        assert_eq!(
            manager.monitor(&task.id, Some("x")).unwrap_err(),
            format!("Task {} has finished", task.id)
        );
        // Stopping a finished task changes nothing.
        let stopped = manager.stop(&task.id).await.unwrap();
        assert_eq!(stopped.status, TaskStatus::Completed);
        manager.shutdown().await;
    })
    .await;
}

#[tokio::test]
async fn runs_a_task_on_a_terminal_that_accepts_input() {
    local(async {
        let manager = TaskManager::new(Hooks::default());
        let task = manager
            .start(StartOptions {
                tty: true,
                ..options(
                    "read -p \"name? \" n; echo \"hi $n\"; [ -t 0 ] && echo tty-ok; echo \"$TERM $(stty size)\"",
                )
            })
            .unwrap();
        assert!(task.tty);
        tokio::time::sleep(Duration::from_millis(200)).await;
        manager.write(&task.id, "bob\n").unwrap();
        let result = manager.wait(&task.id, Some(5.0), None).await.unwrap();
        assert_eq!(result.task.status, TaskStatus::Completed);
        let output = manager.output(&task.id, 200).unwrap();
        assert!(output.contains("hi bob"), "{output}");
        assert!(output.contains("tty-ok"), "{output}");
        assert!(output.contains("xterm-256color 50 200"), "{output}");
        assert_eq!(
            manager.write(&task.id, "x").unwrap_err(),
            format!("Task {} is not running", task.id)
        );
        let piped = manager.start(options("sleep 5")).unwrap();
        assert_eq!(
            manager.write(&piped.id, "x").unwrap_err(),
            format!("Task {} has no terminal; start it with tty: true", piped.id)
        );
        // Ctrl-C reaches the terminal's foreground process.
        let interrupted = manager
            .start(StartOptions {
                tty: true,
                ..options("sleep 30")
            })
            .unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
        manager.write(&interrupted.id, "\u{3}").unwrap();
        let result = manager
            .wait(&interrupted.id, Some(5.0), None)
            .await
            .unwrap();
        assert_eq!(result.outcome, Outcome::Finished);
        assert_eq!(result.task.signal, Some(Some("SIGINT".to_owned())));
        manager.shutdown().await;
    })
    .await;
}

#[tokio::test]
async fn reports_output_lines_that_match_the_monitor_pattern() {
    local(async {
        let seen = Rc::new(Seen::default());
        let manager = manager(&seen);
        assert!(
            manager
                .start(StartOptions {
                    notify_on: Some("("),
                    ..options("true")
                })
                .unwrap_err()
                .starts_with("Invalid notify_on pattern: Invalid regular expression")
        );
        let task = manager
            .start(StartOptions {
                notify_on: Some("ERROR"),
                ..options(
                    "echo ok; echo \"ERROR one\"; printf \"\\033[31mERROR two\\033[0m\\n\"; printf \"ERROR tail\"",
                )
            })
            .unwrap();
        assert_eq!(task.notify_on.as_deref(), Some("ERROR"));
        assert_eq!(task.matches, Some(0));
        manager.wait(&task.id, Some(5.0), None).await.unwrap();
        assert_eq!(
            *seen.lines.borrow(),
            ["ERROR one", "ERROR two", "ERROR tail"]
        );
        assert_eq!(manager.get(&task.id).unwrap().matches, Some(3));
        let other = manager.start(options("sleep 0.2; echo late-match")).unwrap();
        manager.monitor(&other.id, Some("late")).unwrap();
        manager.wait(&other.id, Some(5.0), None).await.unwrap();
        assert_eq!(seen.lines.borrow().last().unwrap(), "late-match");
        // A chatty monitor switches itself off.
        let chatty = manager
            .start(StartOptions {
                notify_on: Some("hit"),
                ..options("for i in $(seq 1 250); do echo \"hit $i\"; done")
            })
            .unwrap();
        let done = manager.wait(&chatty.id, Some(5.0), None).await.unwrap();
        assert_eq!(done.task.matches, Some(MATCH_LIMIT));
        assert_eq!(done.task.notify_on, None);
        assert_eq!(seen.lines.borrow().last().unwrap(), "hit 200");
        // Cleared, nothing is reported.
        let cleared = manager
            .start(StartOptions {
                notify_on: Some("x"),
                ..options("sleep 0.2; echo x")
            })
            .unwrap();
        let count = seen.lines.borrow().len();
        assert_eq!(manager.monitor(&cleared.id, None).unwrap().notify_on, None);
        manager.wait(&cleared.id, Some(5.0), None).await.unwrap();
        assert_eq!(seen.lines.borrow().len(), count);
        manager.shutdown().await;
    })
    .await;
}

#[test]
fn compiles_monitors_as_javascript_regexes() {
    assert_eq!(compile_monitor("a/b").unwrap().1, "a\\/b");
    assert_eq!(compile_monitor("[/]").unwrap().1, "[/]");
    assert_eq!(compile_monitor("a\nb").unwrap().1, "a\\nb");
    assert_eq!(
        compile_monitor("").unwrap_err(),
        "notify_on must be a regular expression of 1–500 characters"
    );
    assert!(compile_monitor(&"a".repeat(501)).is_err());
    assert_eq!(
        compile_monitor("(").unwrap_err(),
        "Invalid notify_on pattern: Invalid regular expression: missing )"
    );
}

#[test]
fn splits_lines_as_the_typescript_regex_does() {
    assert_eq!(
        split_lines("a\r\nb\rc\n\rd\r"),
        ["a", "b", "c", "", "d", ""]
    );
    assert_eq!(split_lines(""), [""]);
}

fn state(pattern: Option<&str>) -> State {
    State {
        info: TaskInfo {
            id: "t".to_owned(),
            command: "c".to_owned(),
            cwd: "/".to_owned(),
            status: TaskStatus::Running,
            pid: None,
            exit_code: None,
            signal: None,
            log_path: "/x.log".to_owned(),
            tty: false,
            notify_on: pattern.map(str::to_owned),
            matches: pattern.map(|_| 0),
            started_at: String::new(),
            ended_at: None,
            error: None,
        },
        input: Vec::new(),
        terminal_open: false,
        file: None,
        monitor: pattern.map(|pattern| Monitor {
            pattern: Rc::new(JsRegex::new(pattern, "").unwrap()),
            decoder: StreamDecoder::default(),
            partial: String::new(),
        }),
        tail: Vec::new(),
        bytes: 0,
        tail_truncated: false,
        log_truncated: false,
        timeout_at: None,
        kill_at: None,
        close_at: None,
        reason: None,
        finished: false,
        waiting: 0,
        on_done: Vec::new(),
    }
}

fn lines(found: Vec<(TaskInfo, String)>) -> Vec<String> {
    found.into_iter().map(|(_, line)| line).collect()
}

#[test]
fn scans_lines_across_chunks() {
    let mut state = state(Some("ok"));
    // A line and a UTF-8 sequence cut between reads.
    assert!(scan(&mut state, b"o", false).is_empty());
    assert_eq!(lines(scan(&mut state, b"k 1\nok \xc3", false)), ["ok 1"]);
    assert_eq!(lines(scan(&mut state, b"\xa9\r\n", false)), ["ok é"]);
    // Escape sequences go; blank lines are skipped.
    assert_eq!(
        lines(scan(
            &mut state,
            b"\x1b[1mo\x1b[0mk\n \n\x1b]0;t\x07ok\n",
            false
        )),
        ["ok", "ok"]
    );
    // An unfinished line counts at the end; a dangling sequence is U+FFFD.
    assert_eq!(
        lines(scan(&mut state, b"ok \xe2\x82", false)),
        Vec::<String>::new()
    );
    assert_eq!(lines(scan(&mut state, b"", true)), ["ok \u{FFFD}"]);
    assert_eq!(state.info.matches, Some(5));
    // A line past the limit is reported in pieces.
    let mut long = self::state(Some("x"));
    let text = "x".repeat(LINE_LIMIT + 10);
    let found = lines(scan(&mut long, text.as_bytes(), false));
    assert_eq!(found, ["x".repeat(LINE_LIMIT)]);
    assert!(scan(&mut self::state(None), b"ok\n", false).is_empty());
}

#[test]
fn keeps_a_bounded_tail_and_cuts_the_log() {
    let record = Record {
        state: RefCell::new(state(None)),
        done: Notify::new(),
        wake: Notify::new(),
    };
    let dir = tempfile::tempdir().unwrap();
    record.state.borrow_mut().file = Some(File::create(dir.path().join("log")).unwrap());
    let chunk = vec![b'a'; TAIL_LIMIT - 2];
    append(&record, &chunk);
    append(&record, b"b\nc\n");
    {
        let state = record.state.borrow();
        assert_eq!(state.tail.len(), TAIL_LIMIT);
        assert!(state.tail_truncated);
        assert!(state.tail.ends_with(b"b\nc\n"));
    }
    for _ in 0..10 {
        append(&record, &chunk);
    }
    let state = record.state.borrow();
    assert!(state.log_truncated);
    assert_eq!(state.bytes, LOG_LIMIT);
    assert_eq!(
        std::fs::metadata(dir.path().join("log")).unwrap().len() as usize,
        LOG_LIMIT
    );
}

#[tokio::test]
async fn reports_what_the_output_cut() {
    local(async {
        let manager = TaskManager::new(Hooks::default());
        let task = manager
            .start(options(
                "head -c 1100000 /dev/zero | tr '\\0' 'x'; printf '\\nlast\\n'",
            ))
            .unwrap();
        manager.wait(&task.id, Some(10.0), None).await.unwrap();
        assert_eq!(
            manager.output(&task.id, 1).unwrap(),
            "[Output truncated: showing the retained 1 MiB tail.]\nlast"
        );
        assert_eq!(manager.output(&task.id, 2).unwrap().lines().count(), 3);
    })
    .await;
}
