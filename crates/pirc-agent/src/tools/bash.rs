//! `bash` and the shell runner (`agent/tools/bash.ts`).

use std::process::Stdio;
use std::time::Duration;

use nix::sys::signal::{Signal, kill};
use nix::unistd::Pid;
use pirc_policy::truncate_output;
use serde_json::{Map, Value, json};
use tokio::io::AsyncReadExt;
use tokio::time::{Instant, sleep, sleep_until};

use super::js::{self, fs_error};
use super::result_schema::{bool_, fields, int, nullable, str_};
use super::{ToolContext, ToolResult, ToolSpec, optional_number, require_string, spec_tool, typed};
use crate::signal::AbortSignal;

/// Typed result of a shell command (`SHELL_RESULT`; `bash`, `unsandboxed_bash`).
pub fn shell_result_schema() -> Value {
    fields(
        vec![
            (
                "output",
                str_(Some("Combined stdout and stderr, cut to the output limit")),
            ),
            (
                "exitCode",
                nullable(int(Some("null when timed out or aborted"))),
            ),
            ("timedOut", bool_(None)),
            ("aborted", bool_(None)),
            ("truncated", bool_(Some("Output was cut"))),
        ],
        &[],
    )
}

/// `killGroup`: kill a detached child's whole process group, then the child
/// itself.
pub fn kill_group(pid: Option<u32>, signal: Signal) {
    let Some(pid) = pid
        .and_then(|pid| i32::try_from(pid).ok())
        .filter(|pid| *pid > 0)
    else {
        return;
    };
    if kill(Pid::from_raw(-pid), signal).is_err() {
        let _ = kill(Pid::from_raw(pid), signal);
    }
}

/// Process groups of shells still running, for [`kill_live_groups`].
static LIVE_GROUPS: std::sync::Mutex<Vec<i32>> = std::sync::Mutex::new(Vec::new());

/// Kills the shell's process group when [`run_shell`] ends, including when
/// it is dropped before it finishes (a cancelled or panicking caller), so
/// no command outlives its run. TS has no such path: its promise always
/// runs to the end. Only the group is signalled: the shell leads it, so
/// its pid is never signalled on its own after being reaped (and reused).
/// Background tasks hold one too.
pub(crate) struct GroupGuard(Option<i32>);

impl GroupGuard {
    pub(crate) fn new(pid: Option<u32>) -> Self {
        let pgid = pid
            .and_then(|pid| i32::try_from(pid).ok())
            .filter(|pid| *pid > 0);
        if let Some(pgid) = pgid {
            LIVE_GROUPS
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(pgid);
        }
        Self(pgid)
    }
}

impl Drop for GroupGuard {
    fn drop(&mut self) {
        if let Some(pgid) = self.0.take() {
            LIVE_GROUPS
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .retain(|live| *live != pgid);
            let _ = kill(Pid::from_raw(-pgid), Signal::SIGKILL);
        }
    }
}

/// Kills the process groups of every shell still running: for exits that
/// skip destructors (`process::exit`).
pub fn kill_live_groups() {
    for pgid in LIVE_GROUPS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .drain(..)
    {
        let _ = kill(Pid::from_raw(-pgid), Signal::SIGKILL);
    }
}

/// `ShellResult`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShellResult {
    pub output: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub aborted: bool,
    pub truncated: bool,
}

/// `runShell`'s options.
pub struct ShellOptions<'a> {
    pub cwd: &'a str,
    pub env: &'a [(String, String)],
    pub timeout_ms: u64,
    pub max_bytes: usize,
    pub signal: &'a AbortSignal,
    pub on_output: Option<&'a dyn Fn(&str)>,
}

/// `TextDecoder` with `{stream: true}`: holds an incomplete sequence back,
/// replaces invalid bytes with U+FFFD.
#[derive(Default)]
pub(crate) struct StreamDecoder {
    pending: Vec<u8>,
}

impl StreamDecoder {
    pub(crate) fn decode(&mut self, chunk: &[u8]) -> String {
        self.pending.extend_from_slice(chunk);
        let mut out = String::new();
        let mut rest: &[u8] = &self.pending;
        loop {
            match std::str::from_utf8(rest) {
                Ok(text) => {
                    out.push_str(text);
                    rest = &[];
                    break;
                }
                Err(error) => {
                    let (valid, after) = rest.split_at(error.valid_up_to());
                    out.push_str(std::str::from_utf8(valid).expect("valid UTF-8"));
                    match error.error_len() {
                        Some(len) => {
                            out.push('\u{FFFD}');
                            rest = &after[len..];
                        }
                        None => {
                            rest = after;
                            break;
                        }
                    }
                }
            }
        }
        self.pending = rest.to_vec();
        out
    }

    /// The end of the stream (`decode()` without `stream`): an incomplete
    /// sequence held back becomes U+FFFD.
    pub(crate) fn finish(&mut self) -> String {
        if std::mem::take(&mut self.pending).is_empty() {
            String::new()
        } else {
            "\u{FFFD}".to_owned()
        }
    }
}

/// `runShell`: `<shell> -c command` in its own process group, with timeout,
/// abort and output cap. `Err` is the spawn failure.
pub async fn run_shell(
    shell: &str,
    command: &str,
    options: ShellOptions<'_>,
) -> Result<ShellResult, String> {
    let mut child = tokio::process::Command::new(shell)
        .arg("-c")
        .arg(command)
        .current_dir(options.cwd)
        .envs(options.env.iter().map(|(k, v)| (k, v)))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| fs_error(&error, "posix_spawn", Some(shell)))?;
    let pid = child.id();
    // The shell exited (or the caller dropped us); orphaned descendants must
    // not linger.
    let _group = GroupGuard::new(pid);
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let mut output = String::new();
    let mut units = 0usize;
    let mut captured = 0usize;
    let cap = options.max_bytes * 4;
    let mut timed_out = false;
    let mut aborted = false;
    let mut kill_at: Option<Instant> = None;
    // An already aborted signal fires no listener (`addEventListener`).
    let mut listening = !options.signal.aborted();
    let timer = sleep(Duration::from_millis(options.timeout_ms.max(1)));
    tokio::pin!(timer);
    let mut timer_armed = true;
    let mut decoders = (StreamDecoder::default(), StreamDecoder::default());
    let mut out_buffer = vec![0u8; 65_536];
    let mut err_buffer = vec![0u8; 65_536];
    let mut status: Option<i32> = None;
    let stop = |kill_at: &mut Option<Instant>| {
        kill_group(pid, Signal::SIGTERM);
        *kill_at = Some(Instant::now() + Duration::from_secs(1));
    };
    while stdout.is_some() || stderr.is_some() || status.is_none() {
        let mut chunk: Option<(bool, usize)> = None;
        tokio::select! {
            read = async { stdout.as_mut().expect("stdout").read(&mut out_buffer).await }, if stdout.is_some() => {
                match read {
                    Ok(0) | Err(_) => stdout = None,
                    Ok(n) => chunk = Some((true, n)),
                }
            }
            read = async { stderr.as_mut().expect("stderr").read(&mut err_buffer).await }, if stderr.is_some() => {
                match read {
                    Ok(0) | Err(_) => stderr = None,
                    Ok(n) => chunk = Some((false, n)),
                }
            }
            // The shell's status counts once both pipes are drained, like
            // `await child.exited` after the pumps.
            exit = child.wait(), if status.is_none() && stdout.is_none() && stderr.is_none() => {
                status = Some(match exit {
                    Ok(exit) => exit_code(exit),
                    Err(_) => -1,
                });
            }
            () = &mut timer, if timer_armed => {
                timer_armed = false;
                timed_out = true;
                stop(&mut kill_at);
            }
            () = options.signal.cancelled(), if listening => {
                listening = false;
                aborted = true;
                stop(&mut kill_at);
            }
            () = async { sleep_until(kill_at.expect("a kill deadline")).await }, if kill_at.is_some() => {
                kill_at = None;
                kill_group(pid, Signal::SIGKILL);
            }
        }
        if let Some((is_stdout, n)) = chunk {
            let (bytes, decoder) = if is_stdout {
                (&out_buffer[..n], &mut decoders.0)
            } else {
                (&err_buffer[..n], &mut decoders.1)
            };
            let piece = decoder.decode(bytes);
            units += js::len16(&piece);
            output.push_str(&piece);
            captured += n;
            // Keep a bounded head+tail window; the final cut trims to max_bytes.
            if units > cap {
                output = format!(
                    "{}{}",
                    js::head16(&output, cap / 2),
                    js::tail16(&output, cap / 2)
                );
                units = js::len16(&output);
            }
            if let Some(on_output) = options.on_output {
                on_output(&output);
            }
        }
    }
    let (text, cut) = truncate_output(&output, options.max_bytes);
    Ok(ShellResult {
        output: text,
        exit_code: if timed_out || aborted { None } else { status },
        timed_out,
        aborted,
        truncated: cut || captured > output.len(),
    })
}

/// Bun's `exited`: the code, or 128 + the signal that ended the process.
fn exit_code(status: std::process::ExitStatus) -> i32 {
    use std::os::unix::process::ExitStatusExt;
    status
        .code()
        .unwrap_or_else(|| 128 + status.signal().unwrap_or(0))
}

pub struct BashTool {
    spec: ToolSpec,
    shell: String,
}

impl Default for BashTool {
    fn default() -> Self {
        Self::new()
    }
}

impl BashTool {
    pub fn new() -> Self {
        Self::with_shell("/bin/bash")
    }

    /// The tool running another bash (tests on systems without `/bin/bash`).
    pub fn with_shell(shell: &str) -> Self {
        Self {
            spec: ToolSpec::new(
                "bash",
                json!({
                    "type": "object",
                    "properties": {
                        "command": { "type": "string" },
                        "timeout": { "type": "number", "description": "Timeout in seconds" },
                    },
                    "required": ["command"],
                    "additionalProperties": false,
                }),
                // A non-zero exit fails the operation; the error carries these
                // fields as `data`.
                Some(shell_result_schema()),
            ),
            shell: shell.to_owned(),
        }
    }

    async fn run(&self, args: Map<String, Value>, ctx: ToolContext) -> Result<ToolResult, String> {
        let command = require_string(&args, "command")?;
        let seconds = optional_number(&args, "timeout")?;
        let timeout_ms = match seconds {
            Some(seconds) if seconds != 0.0 => (seconds * 1000.0).clamp(1.0, 3_600_000.0) as u64,
            _ => ctx.config.limits.bash_timeout_ms,
        };
        let update = ctx.update.clone();
        let on_output = move |output: &str| update(ToolResult::text(output));
        let result = run_shell(
            &self.shell,
            command,
            ShellOptions {
                cwd: &ctx.cwd,
                env: &ctx.env,
                timeout_ms,
                max_bytes: ctx.config.limits.tool_output_bytes as usize,
                signal: &ctx.signal,
                on_output: Some(&on_output),
            },
        )
        .await?;
        let status = if result.timed_out {
            "[timed out]".to_owned()
        } else if result.aborted {
            "[aborted]".to_owned()
        } else {
            format!(
                "[exit {}]",
                result
                    .exit_code
                    .map_or_else(|| "null".to_owned(), |code| code.to_string())
            )
        };
        let separator = if result.output.ends_with('\n') || result.output.is_empty() {
            ""
        } else {
            "\n"
        };
        let body = format!("{}{separator}{status}", result.output);
        Ok(typed(
            body,
            json!({
                "output": result.output,
                "exitCode": result.exit_code,
                "timedOut": result.timed_out,
                "aborted": result.aborted,
                "truncated": result.truncated,
            }),
            Some(json!({ "exitCode": result.exit_code, "truncated": result.truncated })),
            result.exit_code != Some(0),
        ))
    }
}

spec_tool!(BashTool, ptc: true);
