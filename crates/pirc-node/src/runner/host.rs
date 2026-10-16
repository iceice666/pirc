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
use pirc_agent::messages::js::utf16_len;
use pirc_config::Env;
use pirc_config::env_allowlist::without_secrets;
use process_wrap::tokio::{CommandWrap, ProcessSession};
use serde_json::{Value, json};
use tokio::io::AsyncReadExt;
use tokio::sync::watch;

/// Output kept from an unsandboxed command (head and tail).
const HOST_EXEC_OUTPUT_BYTES: usize = 1_000_000;

/// `text` split after `units` UTF-16 units (a pair is never split).
fn split16(text: &str, units: usize) -> (&str, &str) {
    let mut used = 0;
    for (index, c) in text.char_indices() {
        if used + c.len_utf16() > units {
            return text.split_at(index);
        }
        used += c.len_utf16();
    }
    (text, "")
}

/// `text.slice(-units)`.
fn tail16(text: &str, units: usize) -> &str {
    let total = utf16_len(text);
    if total <= units {
        return text;
    }
    split16(text, total - units).1
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

/// Run `command` in `cwd`; `abort` turning true stops it. The result
/// object the agent gets: `{output, exitCode, timedOut, aborted, truncated}`.
pub async fn run_on_host(
    env: &Env,
    command: &str,
    cwd: &Path,
    timeout: Duration,
    mut abort: watch::Receiver<bool>,
) -> Value {
    let mut collector = Collector::default();
    let mut spawned = tokio::process::Command::new(pirc_agent::tools::bash::default_shell());
    spawned
        .arg("-c")
        .arg(command)
        .current_dir(cwd)
        .env_clear()
        .envs(without_secrets(env, &[]))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut spawned = CommandWrap::from(spawned);
    spawned.wrap(ProcessSession);
    let (mut timed_out, mut aborted) = (false, false);
    // Withdrawn before it started (between the human's yes and here): never
    // spawned. TS could not get here aborted (one thread).
    let withdrawn = *abort.borrow_and_update() || abort.has_changed().is_err();
    let started = if withdrawn {
        aborted = true;
        None
    } else {
        // `ProcessSession` would wait for the whole group: wait on bash
        // itself, as the pipes' end already covers what it left running.
        Some(spawned.spawn().map(|child| child.into_inner()))
    };
    let exit_code = match started {
        None => None,
        Some(Err(error)) => {
            collector.head.push_str(&format!("{error}\n"));
            None
        }
        Some(Ok(mut child)) => {
            let pid = child.id();
            let mut stdout = child.stdout().take();
            let mut stderr = child.stderr().take();
            let deadline = tokio::time::sleep(timeout);
            tokio::pin!(deadline);
            let mut stopping: Option<std::pin::Pin<Box<tokio::time::Sleep>>> = None;
            let (mut out_buf, mut err_buf) = (vec![0; 64 * 1024], vec![0; 64 * 1024]);
            let mut status = None;
            // As Node's `close`: the process has exited and both pipes ended.
            while status.is_none() || stdout.is_some() || stderr.is_some() {
                let mut stop = false;
                tokio::select! {
                    read = async { stdout.as_mut().unwrap().read(&mut out_buf).await },
                        if stdout.is_some() => match read {
                        Ok(0) | Err(_) => stdout = None,
                        Ok(read) => collector.collect(&out_buf[..read]),
                    },
                    read = async { stderr.as_mut().unwrap().read(&mut err_buf).await },
                        if stderr.is_some() => match read {
                        Ok(0) | Err(_) => stderr = None,
                        Ok(read) => collector.collect(&err_buf[..read]),
                    },
                    waited = child.wait(), if status.is_none() => {
                        status = Some(waited.ok().and_then(|status| status.code()));
                    }
                    () = &mut deadline, if !timed_out && !aborted => {
                        timed_out = true;
                        stop = true;
                    }
                    changed = abort.changed(), if !timed_out && !aborted => {
                        if changed.is_err() || *abort.borrow() {
                            aborted = true;
                            stop = true;
                        }
                    }
                    () = async { stopping.as_mut().unwrap().await }, if stopping.is_some() => {
                        stopping = None;
                        signal_group(pid, Signal::SIGKILL);
                    }
                }
                if stop {
                    signal_group(pid, Signal::SIGTERM);
                    stopping = Some(Box::pin(tokio::time::sleep(Duration::from_secs(1))));
                }
            }
            status.flatten()
        }
    };
    let Collector { head, tail, total } = collector;
    let truncated = total > head.len() + tail.len();
    let output = if truncated {
        format!("{head}\n\n[… output truncated …]\n\n{tail}")
    } else {
        format!("{head}{tail}")
    };
    json!({
        "output": output,
        "exitCode": if timed_out || aborted { None } else { exit_code },
        "timedOut": timed_out,
        "aborted": aborted,
        "truncated": truncated,
    })
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
            loop {
                tokio::select! {
                    _ = child.wait() => break,
                    read = master.read(&mut buffer) => match read {
                        Ok(n @ 1..) => output.extend_from_slice(&buffer[..n]),
                        _ => {
                            let _ = child.wait().await;
                            break;
                        }
                    },
                }
            }
        };
        tokio::time::timeout(Duration::from_secs(60), run)
            .await
            .expect("the probe did not finish");
        let output = String::from_utf8_lossy(&output).replace('\r', "");
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
