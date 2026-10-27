//! `runOnHost`: an approved command outside the sandbox, `/bin/bash -c` in
//! its own session with the node's environment without its secrets,
//! output capped (head and tail kept, in UTF-16 units as TS counted them).
//!
//! The session (`setsid`, as TS's `detached` spawn made) leaves the command
//! without a controlling terminal: when the node runs in one, the command
//! cannot open `/dev/tty` to read the human's keystrokes, prompt there
//! (a `sudo` password prompt would hang until the timeout) or inject input
//! into it (`TIOCSTI`). Its leader also leads a process group of the same
//! id, which a timeout or an abort signals as a whole.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use nix::sys::signal::{Signal, killpg};
use nix::unistd::Pid;
use pirc_config::Env;
use pirc_config::env_allowlist::without_secrets;
use pirc_config::text::{utf16_head, utf16_len, utf16_tail as tail16};
use process_wrap::tokio::{CommandWrap, ProcessSession};
use serde_json::{Value, json};
use tokio::io::AsyncReadExt;
use tokio::sync::watch;

/// Output kept from an unsandboxed command (head and tail).
const HOST_EXEC_OUTPUT_BYTES: usize = 1_000_000;

/// `text` split after at most `units` UTF-16 units (a pair is never split).
fn split16(text: &str, units: usize) -> (&str, &str) {
    text.split_at(utf16_head(text, units).len())
}

#[derive(Default)]
struct Collector {
    head: String,
    tail: String,
    total: usize,
}

impl Collector {
    fn collect(&mut self, chunk: &[u8]) {
        let half = HOST_EXEC_OUTPUT_BYTES / 2;
        let text = String::from_utf8_lossy(chunk);
        self.total += chunk.len();
        let head_len = utf16_len(&self.head);
        if head_len < half {
            let (first, rest) = split16(&text, half - head_len);
            self.head.push_str(first);
            self.tail.push_str(rest);
        } else {
            self.tail.push_str(&text);
        }
        if utf16_len(&self.tail) > half {
            self.tail = tail16(&self.tail, half).to_owned();
        }
    }
}

fn signal_group(pid: Option<u32>, signal: Signal) {
    if let Some(pid) = pid.and_then(|pid| i32::try_from(pid).ok()) {
        let _ = killpg(Pid::from_raw(pid), signal);
    }
}

pub(crate) fn command(env: &Env, command: &str, cwd: &Path) -> CommandWrap {
    let mut spawned = tokio::process::Command::new(pirc_agent::tools::bash::default_shell());
    spawned
        .arg("-c")
        .arg(command)
        .current_dir(cwd)
        .env_clear()
        .envs(without_secrets(env, &[]))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut spawned = CommandWrap::from(spawned);
    spawned.wrap(ProcessSession);
    spawned
}
fn result(collector: Collector, exit_code: Option<i32>, timed_out: bool, aborted: bool) -> Value {
    let Collector { head, tail, total } = collector;
    let truncated = total > head.len() + tail.len();
    let output = if truncated {
        format!("{head}\n\n[… output truncated …]\n\n{tail}")
    } else {
        format!("{head}{tail}")
    };
    json!({"output":output,"exitCode":if timed_out||aborted{None}else{exit_code},
        "timedOut":timed_out,"aborted":aborted,"truncated":truncated})
}
pub(crate) fn spawn_error(error: &std::io::Error) -> Value {
    result(
        Collector {
            head: format!("{error}\n"),
            ..Default::default()
        },
        None,
        false,
        false,
    )
}
pub(crate) struct Observed {
    pub result: Value,
    pub complete: bool,
}

/// This task owns the child through cancellation. Do not reap the session leader
/// while its pipes remain open or a group signal is pending: its unreaped PID
/// pins the numeric group identity. After the last signal, bound pipe/reap waits
/// and report uncertainty instead of hanging on an escaped pipe holder forever.
pub(crate) async fn observe(
    mut child: Box<dyn process_wrap::tokio::ChildWrapper>,
    timeout: Duration,
    mut source: watch::Receiver<bool>,
    mut cancel: watch::Receiver<bool>,
) -> Observed {
    let mut collector = Collector::default();
    let pid = child.id();
    let mut stdout = child.stdout().take();
    let mut stderr = child.stderr().take();
    let deadline = tokio::time::sleep(timeout);
    tokio::pin!(deadline);
    let mut stopping: Option<std::pin::Pin<Box<tokio::time::Sleep>>> = None;
    let mut drain: Option<std::pin::Pin<Box<tokio::time::Sleep>>> = None;
    let (mut timed_out, mut aborted, mut wait_ok, mut io_ok) = (false, false, false, true);
    let mut status = None;
    let (mut out_buf, mut err_buf) = (vec![0; 64 * 1024], vec![0; 64 * 1024]);
    if *source.borrow_and_update()
        || source.has_changed().is_err()
        || *cancel.borrow_and_update()
        || cancel.has_changed().is_err()
    {
        aborted = true;
        signal_group(pid, Signal::SIGTERM);
        stopping = Some(Box::pin(tokio::time::sleep(Duration::from_secs(1))));
    }
    while status.is_none() || stdout.is_some() || stderr.is_some() {
        let mut stop = false;
        tokio::select! {
            biased;
            changed = cancel.changed(), if !timed_out && !aborted => {
                if changed.is_err() || *cancel.borrow() { aborted = true; stop = true; }
            }
            changed = source.changed(), if !timed_out && !aborted => {
                if changed.is_err() || *source.borrow() { aborted = true; stop = true; }
            }
            () = &mut deadline, if !timed_out && !aborted => { timed_out = true; stop = true; }
            () = async { stopping.as_mut().unwrap().await }, if stopping.is_some() => {
                // No child.wait was polled during the grace interval.
                signal_group(pid, Signal::SIGKILL);
                stopping = None;
                drain = Some(Box::pin(tokio::time::sleep(Duration::from_secs(2))));
            }
            () = async { drain.as_mut().unwrap().await }, if drain.is_some() => {
                io_ok = false;
                break;
            }
            read = async { stdout.as_mut().unwrap().read(&mut out_buf).await },
                if stdout.is_some() => match read {
                Ok(0) => stdout = None,
                Ok(n) => collector.collect(&out_buf[..n]),
                Err(_) => { io_ok = false; stdout = None; }
            },
            read = async { stderr.as_mut().unwrap().read(&mut err_buf).await },
                if stderr.is_some() => match read {
                Ok(0) => stderr = None,
                Ok(n) => collector.collect(&err_buf[..n]),
                Err(_) => { io_ok = false; stderr = None; }
            },
            waited = child.wait(),
                if status.is_none() && stopping.is_none()
                    && (drain.is_some() || (stdout.is_none() && stderr.is_none())) => {
                wait_ok = waited.is_ok();
                status = Some(waited.ok().and_then(|s| s.code()));
            }
        }
        if stop {
            signal_group(pid, Signal::SIGTERM);
            stopping = Some(Box::pin(tokio::time::sleep(Duration::from_secs(1))));
        }
    }
    Observed {
        result: result(collector, status.flatten(), timed_out, aborted),
        complete: wait_ok && io_ok && stdout.is_none() && stderr.is_none(),
    }
}

/// Low-level fixture entry point. Production must use the Node's durable,
/// authority-checked supervisor rather than creating untracked host commands.
#[cfg(test)]
async fn run_on_host(
    env: &Env,
    command_text: &str,
    cwd: &Path,
    timeout: Duration,
    mut abort: watch::Receiver<bool>,
) -> Value {
    if *abort.borrow_and_update() || abort.has_changed().is_err() {
        return result(Collector::default(), None, false, true);
    }
    let mut command = command(env, command_text, cwd);
    let child = match command.spawn() {
        Ok(child) => child.into_inner(),
        Err(error) => return spawn_error(&error),
    };
    let (_cancel, wait) = watch::channel(false);
    observe(child, timeout, abort, wait).await.result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env() -> Env {
        Env::new(
            [("PATH", "/usr/bin:/bin"), ("PIRC_NODE_TOKEN", "secret")],
            "/",
        )
    }

    /// TS runs `/bin/bash` too; hosts without it (NixOS) cannot run these.
    fn no_bash() -> bool {
        !Path::new("/bin/bash").exists()
    }

    #[tokio::test]
    async fn runs_without_the_node_secrets() {
        let (_tx, abort) = watch::channel(false);
        if no_bash() {
            // The spawn error is the output.
            let result = run_on_host(
                &env(),
                "true",
                Path::new("/"),
                Duration::from_secs(1),
                abort,
            )
            .await;
            assert_eq!(result["exitCode"], Value::Null);
            assert!(result["output"].as_str().unwrap().ends_with('\n'));
            return;
        }
        let result = run_on_host(
            &env(),
            "echo out; echo err >&2; echo \"[$PIRC_NODE_TOKEN]\"; exit 3",
            Path::new("/"),
            Duration::from_secs(10),
            abort,
        )
        .await;
        let output = result["output"].as_str().unwrap();
        assert!(output.contains("out") && output.contains("err") && output.contains("[]"));
        assert_eq!(result["exitCode"], 3);
        assert_eq!(result["truncated"], false);
    }

    #[tokio::test]
    async fn times_out_aborts_and_truncates() {
        if no_bash() {
            return;
        }
        let (_tx, abort) = watch::channel(false);
        let result = run_on_host(
            &env(),
            "sleep 30",
            Path::new("/"),
            Duration::from_millis(50),
            abort,
        )
        .await;
        assert_eq!(result["timedOut"], true);
        assert_eq!(result["exitCode"], Value::Null);

        let (tx, abort) = watch::channel(false);
        let running = tokio::spawn(async move {
            run_on_host(
                &env(),
                "sleep 30",
                Path::new("/"),
                Duration::from_secs(30),
                abort,
            )
            .await
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        tx.send_replace(true);
        let result = running.await.unwrap();
        assert_eq!(result["aborted"], true);

        let (_tx, abort) = watch::channel(false);
        let result = run_on_host(
            &env(),
            "head -c 1200000 /dev/zero | tr '\\0' x",
            Path::new("/"),
            Duration::from_secs(10),
            abort,
        )
        .await;
        assert_eq!(result["truncated"], true);
        let output = result["output"].as_str().unwrap();
        assert_eq!(
            output.len(),
            1_000_000 + "\n\n[… output truncated …]\n\n".len()
        );
        assert_eq!(result["exitCode"], 0);
    }

    // A request withdrawn between the human's yes and the spawn runs nothing.
    #[tokio::test]
    async fn never_spawns_a_withdrawn_command() {
        let marker = std::env::temp_dir().join(format!("pirc-withdrawn-{}", std::process::id()));
        let command = format!("touch {}", marker.display());
        let (tx, abort) = watch::channel(false);
        tx.send_replace(true);
        let result = run_on_host(
            &env(),
            &command,
            Path::new("/"),
            Duration::from_secs(10),
            abort,
        )
        .await;
        assert_eq!(result["aborted"], true);
        assert_eq!(result["exitCode"], Value::Null);
        assert_eq!(result["output"], "");
        // A closed channel (its sender gone) is a withdrawal too.
        let abort = watch::channel(false).1;
        let result = run_on_host(
            &env(),
            &command,
            Path::new("/"),
            Duration::from_secs(10),
            abort,
        )
        .await;
        assert_eq!(result["aborted"], true);
        assert!(!marker.exists());
    }

    #[tokio::test]
    async fn escaped_pipe_holder_is_unconfirmed_and_wait_is_bounded() {
        let dir = tempfile::tempdir().unwrap();
        let done = dir.path().join("done");
        let exe = std::env::current_exe().unwrap();
        let mut command = command(
            &env(),
            &format!(
                "exec '{}' --exact runner::host::tests::escaped_pipe_probe --ignored --nocapture",
                exe.display()
            ),
            Path::new("/"),
        );
        command.command_mut().env("PIRC_HOST_PIPE_DONE", &done);
        let child = command.spawn().unwrap().into_inner();
        let (_source, source) = watch::channel(false);
        let (_cancel, cancel) = watch::channel(false);
        let result = tokio::time::timeout(
            Duration::from_secs(5),
            observe(child, Duration::from_millis(500), source, cancel),
        )
        .await
        .unwrap();
        assert!(!result.complete);
        assert_eq!(result.result["timedOut"], true);
        tokio::time::timeout(Duration::from_secs(10), async {
            while !done.exists() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("the owned escaped helper must finish");
    }
    #[test]
    #[ignore = "owned subprocess for escaped_pipe_holder_is_unconfirmed_and_wait_is_bounded"]
    fn escaped_pipe_probe() {
        use std::os::unix::process::CommandExt;
        let done = std::env::var("PIRC_HOST_PIPE_DONE").unwrap();
        if std::env::var_os("PIRC_HOST_PIPE_CHILD").is_some() {
            std::thread::sleep(Duration::from_secs(6));
            std::fs::write(done, "done").unwrap();
            return;
        }
        // Deliberately leave this command's process group while inheriting its
        // output. No PID-based cleanup: this one-shot helper exits on its own.
        let mut child = std::process::Command::new(std::env::current_exe().unwrap());
        child
            .args([
                "--exact",
                "runner::host::tests::escaped_pipe_probe",
                "--ignored",
                "--nocapture",
            ])
            .env("PIRC_HOST_PIPE_CHILD", "1")
            .process_group(0);
        let _ = child.spawn().unwrap().wait();
    }

    /// Whether `pid` still exists (a zombie counts until it is reaped).
    fn alive(pid: i32) -> bool {
        nix::sys::signal::kill(Pid::from_raw(pid), None).is_ok()
    }

    /// Run on a PTY that is the node's controlling terminal (this test
    /// binary playing the node, in a session of its own), a host command
    /// cannot open that terminal: it runs in a session without one.
    #[tokio::test]
    async fn a_host_command_cannot_reach_the_nodes_terminal() {
        if no_bash() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("node");
        let exe = std::env::current_exe().unwrap();
        crate::test_support::executable(
            &script,
            &format!(
                "#!/bin/sh\nexec '{}' --exact runner::host::tests::probe_from_a_terminal \
                 --ignored --nocapture --test-threads=1\n",
                exe.display()
            ),
        );
        let (master, slave) = crate::terminals::pty::open(24, 80).unwrap();
        let mut env = std::collections::BTreeMap::new();
        env.insert("PATH".to_owned(), "/usr/bin:/bin".to_owned());
        let mut child =
            crate::terminals::pty::spawn(slave, script.to_str().unwrap(), dir.path(), &env)
                .unwrap();
        // Read until it exits: a session leader closing its terminal waits
        // for the output to be read (macOS).
        let mut output = Vec::new();
        let mut buffer = [0; 4096];
        let run = async {
            // Exit notification can arrive before the final PTY bytes are
            // read. Drain to EOF (EIO on Linux) before reaping the child so
            // the host's isolation result cannot be lost to that race.
            loop {
                match master.read(&mut buffer).await {
                    Ok(0) => break,
                    Ok(n) => output.extend_from_slice(&buffer[..n]),
                    Err(error) if error.raw_os_error() == Some(nix::libc::EIO) => break,
                    Err(error) => panic!("could not read the probe PTY: {error}"),
                }
            }
            child.wait().await
        };
        let status = tokio::time::timeout(Duration::from_secs(60), run)
            .await
            .expect("the probe did not finish")
            .expect("could not reap the probe");
        let output = String::from_utf8_lossy(&output).replace('\r', "");
        assert!(status.success(), "probe exited with {status}: {output}");
        assert!(output.contains("PROBE node: tty"), "{output}");
        assert!(output.contains("PROBE host: no-tty"), "{output}");
        assert!(!output.contains("PROBE host: tty"), "{output}");
    }

    /// The node's half of [`a_host_command_cannot_reach_the_nodes_terminal`].
    #[tokio::test]
    #[ignore = "run on a PTY by a_host_command_cannot_reach_the_nodes_terminal"]
    async fn probe_from_a_terminal() {
        // The setup is real: the "node" itself has the terminal.
        let node = std::fs::File::open("/dev/tty").is_ok();
        println!("PROBE node: {}", if node { "tty" } else { "no-tty" });
        let (_tx, abort) = watch::channel(false);
        let result = run_on_host(
            &env(),
            "if (exec 3</dev/tty) 2>/dev/null; then echo tty; else echo no-tty; fi",
            Path::new("/"),
            Duration::from_secs(10),
            abort,
        )
        .await;
        println!("PROBE host: {}", result["output"].as_str().unwrap().trim());
    }

    /// An abort ends what the command started in the background too.
    #[tokio::test]
    async fn an_aborted_command_leaves_nothing_running() {
        if no_bash() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let pid_file = dir.path().join("pid");
        let command = format!("sleep 60 & echo $! > '{}'; sleep 60", pid_file.display());
        let (tx, abort) = watch::channel(false);
        let running = tokio::spawn(async move {
            run_on_host(
                &env(),
                &command,
                Path::new("/"),
                Duration::from_secs(60),
                abort,
            )
            .await
        });
        let pid = loop {
            if let Some(pid) = std::fs::read_to_string(&pid_file)
                .ok()
                .and_then(|text| text.trim().parse::<i32>().ok())
            {
                break pid;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        };
        assert!(alive(pid));
        tx.send_replace(true);
        let result = tokio::time::timeout(Duration::from_secs(10), running)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result["aborted"], true);
        // Reparented on its parent's death, it is reaped soon after.
        let gone = async {
            while alive(pid) {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        };
        tokio::time::timeout(Duration::from_secs(5), gone)
            .await
            .expect("the background process outlived the abort");
    }

    #[test]
    fn utf16_splits() {
        assert_eq!(split16("a😀b", 1), ("a", "😀b"));
        assert_eq!(split16("a😀b", 2), ("a", "😀b"));
        assert_eq!(split16("a😀b", 3), ("a😀", "b"));
        assert_eq!(tail16("a😀b", 3), "😀b");
        assert_eq!(tail16("ab", 5), "ab");
    }
}
