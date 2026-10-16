//! Whether bubblewrap ran a read-only command (the Git panel's git), from
//! its `--json-status-fd` records. Not srt's: srt never told its own
//! failures from the command's.
//!
//! bubblewrap writes `{"child-pid": ...}` once it has cloned the sandbox,
//! and `{"exit-code": N}` only when the command it started has exited. Its
//! own failures (a mount, a path gone since the plan, `execvp`) exit 1, as
//! git's "no" does, but leave no `exit-code` record (bubblewrap 0.12).

use std::io::{PipeReader, Read as _};
use std::sync::Mutex;

use command_fds::{CommandFdExt as _, FdMapping};

use crate::sandbox::WrapperStatus;

/// The status descriptor in bubblewrap (`--json-status-fd 3`): the read-only
/// command has stdio only, and the long-profile shell uses fd 9.
pub const STATUS_FD: i32 = 3;

/// The read end of the status pipe of the command last prepared.
#[derive(Default)]
pub struct JsonStatus {
    reader: Mutex<Option<PipeReader>>,
}

impl WrapperStatus for JsonStatus {
    /// The status pipe, and the read-only sandbox's seccomp filter in the
    /// same mapping (`command-fds` keeps mappings of separate calls from
    /// colliding only within each call).
    fn prepare_command(&self, command: &mut tokio::process::Command) -> std::io::Result<()> {
        let (reader, writer) = std::io::pipe()?;
        let mut mappings = vec![FdMapping {
            parent_fd: writer.into(),
            child_fd: STATUS_FD,
        }];
        mappings.extend(super::seccomp::mapping()?);
        command
            .fd_mappings(mappings)
            .map_err(std::io::Error::other)?;
        *self.reader.lock().unwrap_or_else(|p| p.into_inner()) = Some(reader);
        Ok(())
    }

    /// The command ran when a record has its `exit-code`. bubblewrap killed
    /// by a signal (128 and up) is not a failure of the sandbox.
    fn failure(&self, code: i32, stderr: &str) -> Option<String> {
        if code >= 128 {
            return None;
        }
        let reader = self
            .reader
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take()?;
        if ran(&records(reader)) {
            return None;
        }
        let last = stderr.trim().lines().last().unwrap_or_default().trim();
        Some(if last.is_empty() {
            format!("bubblewrap exited with {code} before running the command")
        } else {
            last.to_owned()
        })
    }
}

/// What bubblewrap wrote, without waiting: it has exited, and nothing
/// inside holds the descriptor (bubblewrap does not pass it on), but a
/// read must never hang the panel.
fn records(reader: PipeReader) -> String {
    let mut bytes = Vec::new();
    let nonblocking = nix::fcntl::fcntl(
        &reader,
        nix::fcntl::FcntlArg::F_SETFL(nix::fcntl::OFlag::O_NONBLOCK),
    );
    if nonblocking.is_ok() {
        // Up to EOF or `WouldBlock`; what was read stays in `bytes`.
        let _ = (&reader).take(64 * 1024).read_to_end(&mut bytes);
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

/// Whether one of the newline-separated records is the command's exit.
fn ran(records: &str) -> bool {
    records.lines().any(|line| {
        serde_json::from_str::<serde_json::Value>(line)
            .is_ok_and(|record| record.get("exit-code").is_some())
    })
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use pirc_policy::session::SessionPolicy;

    use super::*;
    use crate::sandbox::Prepared;

    #[test]
    fn exit_code_records_mean_the_command_ran() {
        assert!(ran(
            "{ \"child-pid\": 7, \"mnt-namespace\": 1 }\n{ \"exit-code\": 1 }\n"
        ));
        assert!(!ran("{ \"child-pid\": 7, \"mnt-namespace\": 1 }\n"));
        assert!(!ran(""));
    }

    /// A stand-in for bubblewrap writing to the status descriptor.
    async fn run(script: &str) -> (i32, Option<String>) {
        let prepared = Prepared::new(
            PathBuf::from("/bin/sh"),
            vec!["-c".into(), script.into()],
            Vec::new(),
            SessionPolicy::default(),
            Vec::new(),
            None,
            || {},
        )
        .with_wrapper_status(Box::new(JsonStatus::default()));
        let output = prepared
            .command()
            .unwrap()
            .stdin(std::process::Stdio::null())
            .output()
            .await
            .unwrap();
        let code = output.status.code().unwrap();
        let stderr = String::from_utf8_lossy(&output.stderr);
        (code, prepared.wrapper_failure(code, &stderr))
    }

    #[tokio::test]
    async fn tells_bubblewraps_failure_from_the_commands_exit() {
        let ran = r#"echo '{ "child-pid": 7 }' >&3; echo '{ "exit-code": 1 }' >&3; exit 1"#;
        assert_eq!(run(ran).await, (1, None));
        let failed = r#"echo '{ "child-pid": 7 }' >&3; echo 'bwrap: execvp git: No such file or directory' >&2; exit 1"#;
        assert_eq!(
            run(failed).await,
            (
                1,
                Some("bwrap: execvp git: No such file or directory".to_owned())
            )
        );
        assert_eq!(
            run("exit 1").await,
            (
                1,
                Some("bubblewrap exited with 1 before running the command".to_owned())
            )
        );
        assert_eq!(run("exit 137").await, (137, None), "killed");
    }
}
