//! Recordings (`browser_record`, the viewer's record button): the
//! session's screencast frames piped at 10 fps into ffmpeg
//! (`PIRC_FFMPEG`), VP9 WebM under `<session root>/.pirc/recordings/`, as
//! `node/browser.ts` does (`startRecording`/`stopRecording`). The manager
//! owns the parts that touch the tab (the seed frame, the screencast, the
//! 30-minute cap, the log); this is the ffmpeg process.
//!
//! The node creates the file itself without following symlinks
//! ([`crate::private_dir`]) and ffmpeg writes it as its fd 3
//! (`/dev/fd/3`), so a symlink in a cloned repository cannot redirect the
//! write (security audit I2).

use std::collections::BTreeMap;
use std::fs::File;
use std::os::fd::OwnedFd;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use command_fds::{CommandFdExt as _, FdMapping};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::process::Command;
use tokio::sync::{oneshot, watch};
use tokio::time::MissedTickBehavior;

use crate::error::ApiError;

/// Frames written per second (`RECORD_FPS`).
pub const RECORD_FPS: u64 = 10;
/// A recording stops by itself after this long (`RECORD_MAX_MS`).
pub const RECORD_MAX: Duration = Duration::from_secs(30 * 60);
/// How long a stop waits for ffmpeg before killing it.
const STOP_TIMEOUT: Duration = Duration::from_secs(30);
/// stderr kept for the failure message (UTF-16 code units).
const STDERR_KEEP: usize = 2000;

/// The output file's descriptor in ffmpeg.
const OUTPUT_FD: i32 = 3;

/// ffmpeg's arguments (`browser.ts`, in its order), writing WebM to its
/// fd 3; the format is named, as the path has no extension.
pub fn ffmpeg_args() -> Vec<String> {
    [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "image2pipe",
        "-framerate",
        "10",
        "-c:v",
        "mjpeg",
        "-i",
        "-",
        "-vf",
        "scale=trunc(iw/2)*2:trunc(ih/2)*2",
        "-c:v",
        "libvpx-vp9",
        "-deadline",
        "realtime",
        "-cpu-used",
        "8",
        "-b:v",
        "0",
        "-crf",
        "38",
        "-pix_fmt",
        "yuv420p",
        "-f",
        "webm",
        "-y",
        "/dev/fd/3",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect()
}

/// The latest screencast JPEG of the tab, if any (read every tick).
pub type FrameSource = Arc<dyn Fn() -> Option<Arc<Vec<u8>>> + Send + Sync>;
/// Whether this recording is still the tab's (`tab.recording === recording`).
pub type StillCurrent = Arc<dyn Fn() -> bool + Send + Sync>;

/// A running ffmpeg fed with the tab's frames.
pub struct Recording {
    /// The file ffmpeg writes (its size is read from here, not the path).
    output: Arc<File>,
    /// `.pirc/recordings/<name>.webm`, relative to the session root.
    pub relative: String,
    /// `Date.now()` at the start.
    pub started_at: i64,
    failed: Arc<Mutex<Option<String>>>,
    /// The exit code once ffmpeg is gone (`None` inside: killed by a signal
    /// or never started).
    exited: watch::Receiver<Option<Option<i32>>>,
    /// Ends the writer: no more frames, then stdin closes (`stdin.end()`).
    end: Option<oneshot::Sender<()>>,
    kill: Option<oneshot::Sender<()>>,
}

/// Why a recording failed (shared with its [`Recording`]).
#[derive(Clone)]
pub struct Failure(Arc<Mutex<Option<String>>>);

impl Failure {
    pub fn get(&self) -> Option<String> {
        lock(&self.0).clone()
    }
}

/// How a stop ended (`code` of `stopRecording`).
pub enum Exit {
    Code(Option<i32>),
    Timeout,
}

/// A stopped recording, before its result is read.
pub struct Stopped {
    output: Arc<File>,
    pub relative: String,
    pub started_at: i64,
    pub exit: Exit,
    pub failed: Option<String>,
}

impl Recording {
    /// Spawn `ffmpeg` (environment `env`, `withoutSecrets`) writing `output`,
    /// and write `frames()` into it every 100 ms. A write still in progress
    /// (ffmpeg not keeping up) skips the ticks until it is done, as
    /// `stdin.write` returning false did until `drain`. A spawn failure is
    /// [`Recording::failed`] (`ffmpeg not found (<ffmpeg>); set PIRC_FFMPEG`
    /// for a missing one; other errors carry Rust's text, not Node's).
    pub fn start(
        ffmpeg: &str,
        env: &BTreeMap<String, String>,
        output: File,
        relative: String,
        frames: FrameSource,
        still_current: StillCurrent,
    ) -> Self {
        let failed = Arc::new(Mutex::new(None::<String>));
        let (exited_tx, exited) = watch::channel(None);
        let (end, end_rx) = oneshot::channel::<()>();
        let (kill, kill_rx) = oneshot::channel::<()>();
        let output = Arc::new(output);
        let mut command = Command::new(ffmpeg);
        let mapped = match output.try_clone() {
            Ok(file) => command
                .fd_mappings(vec![FdMapping {
                    parent_fd: OwnedFd::from(file),
                    child_fd: OUTPUT_FD,
                }])
                .map(|_| ())
                .map_err(std::io::Error::other),
            Err(error) => Err(error),
        };
        command
            .args(ffmpeg_args())
            .env_clear()
            .envs(env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let recording = Self {
            output,
            relative,
            started_at: crate::util::now_ms(),
            failed: failed.clone(),
            exited,
            end: Some(end),
            kill: Some(kill),
        };
        if let Err(error) = mapped {
            *lock(&failed) = Some(error.to_string());
            exited_tx.send_replace(Some(None));
            return recording;
        }
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                *lock(&failed) = Some(if error.kind() == std::io::ErrorKind::NotFound {
                    format!("ffmpeg not found ({ffmpeg}); set PIRC_FFMPEG")
                } else {
                    error.to_string()
                });
                exited_tx.send_replace(Some(None));
                return recording;
            }
        };
        let stderr_text = Arc::new(Mutex::new(String::new()));
        let stderr_task = child.stderr.take().map(|mut stderr| {
            let text = stderr_text.clone();
            tokio::spawn(async move {
                let mut buffer = vec![0u8; 4096];
                while let Ok(n @ 1..) = stderr.read(&mut buffer).await {
                    let mut text = lock(&text);
                    text.push_str(&String::from_utf8_lossy(&buffer[..n]));
                    keep_tail(&mut text, STDERR_KEEP);
                }
            })
        });
        if let Some(mut stdout) = child.stdout.take() {
            tokio::spawn(async move {
                let mut buffer = vec![0u8; 4096];
                while let Ok(1..) = stdout.read(&mut buffer).await {}
            });
        }
        if let Some(mut stdin) = child.stdin.take() {
            let failed = failed.clone();
            tokio::spawn(async move {
                // Screencast frames only arrive when the page changes: repeat
                // the latest at a fixed rate so the video plays in real time.
                let period = Duration::from_millis(1000 / RECORD_FPS);
                let mut ticks =
                    tokio::time::interval_at(tokio::time::Instant::now() + period, period);
                ticks.set_missed_tick_behavior(MissedTickBehavior::Skip);
                let mut end_rx = end_rx;
                let mut broken = false;
                loop {
                    tokio::select! {
                        _ = &mut end_rx => break,
                        _ = ticks.tick() => {
                            if broken || lock(&failed).is_some() {
                                continue;
                            }
                            let Some(frame) = frames() else { continue };
                            // Write errors are ignored (`stdin.on('error')`).
                            broken = stdin.write_all(&frame).await.is_err();
                        }
                    }
                }
                let _ = stdin.shutdown().await;
            });
        }
        tokio::spawn(async move {
            // Only an explicit kill (a stop that timed out) kills ffmpeg: a
            // dropped `Recording` drops the sender, which disables this
            // branch, and ffmpeg ends with its input.
            let status = tokio::select! {
                status = child.wait() => status,
                Ok(()) = kill_rx => {
                    let _ = child.start_kill();
                    child.wait().await
                }
            };
            // The failure message is ffmpeg's stderr: read it to the end.
            if let Some(task) = stderr_task {
                let _ = tokio::time::timeout(Duration::from_secs(1), task).await;
            }
            let code = status.ok().and_then(|status| status.code());
            let stderr = lock(&stderr_text).clone();
            {
                let mut failed = lock(&failed);
                if failed.is_none() && !stderr.is_empty() && still_current() {
                    *failed = Some(stderr);
                }
            }
            exited_tx.send_replace(Some(code));
        });
        recording
    }

    /// Why the recording failed, once it has.
    pub fn failed(&self) -> Option<String> {
        lock(&self.failed).clone()
    }

    /// [`Recording::failed`], readable after the recording moved on.
    pub fn failure(&self) -> Failure {
        Failure(self.failed.clone())
    }

    /// `stopRecording` after the tab let go of it: stdin ends now; the
    /// returned future waits for ffmpeg (30 s, then SIGKILL).
    pub fn stop(mut self) -> impl Future<Output = Stopped> + Send + 'static {
        if let Some(end) = self.end.take() {
            let _ = end.send(());
        }
        async move {
            let mut exited = self.exited.clone();
            let exit =
                match tokio::time::timeout(STOP_TIMEOUT, exited.wait_for(Option::is_some)).await {
                    Ok(Ok(code)) => Exit::Code((*code).flatten()),
                    Ok(Err(_)) => Exit::Code(None),
                    Err(_) => {
                        if let Some(kill) = self.kill.take() {
                            let _ = kill.send(());
                        }
                        Exit::Timeout
                    }
                };
            Stopped {
                failed: self.failed(),
                output: self.output.clone(),
                relative: self.relative.clone(),
                started_at: self.started_at,
                exit,
            }
        }
    }
}

impl Drop for Recording {
    /// A recording dropped without [`Recording::stop`] (a failed start)
    /// stops writing; ffmpeg ends with its input and is not killed.
    fn drop(&mut self) {
        if let Some(end) = self.end.take() {
            let _ = end.send(());
        }
    }
}

impl Stopped {
    /// `{recording: false, path, bytes, durationMs}`, or 500 `browser_error`
    /// "Recording failed: <stderr | ffmpeg exited with <code>>". A missing
    /// file answers 500 `browser_error` with the I/O error (Rust's text;
    /// TS forwarded Node's `statSync` error the same way).
    pub fn result(&self) -> Result<Value, ApiError> {
        let code_ok = matches!(self.exit, Exit::Code(Some(0)));
        if !code_ok || self.failed.is_some() {
            let reason = self.failed.clone().unwrap_or_else(|| {
                format!(
                    "ffmpeg exited with {}",
                    match self.exit {
                        Exit::Timeout => "timeout".to_owned(),
                        Exit::Code(Some(code)) => code.to_string(),
                        Exit::Code(None) => "null".to_owned(),
                    }
                )
            });
            return Err(ApiError::new(
                500,
                "browser_error",
                format!("Recording failed: {reason}"),
            ));
        }
        let bytes = self
            .output
            .metadata()
            .map_err(|error| ApiError::new(500, "browser_error", error.to_string()))?
            .len();
        Ok(json!({
            "recording": false,
            "path": self.relative,
            "bytes": bytes,
            "durationMs": crate::util::now_ms() - self.started_at,
        }))
    }
}

/// `(text + chunk).slice(-max)` in UTF-16 code units.
fn keep_tail(text: &mut String, max: usize) {
    let mut units = 0;
    for (index, c) in text.char_indices().rev() {
        units += c.len_utf16();
        if units > max {
            let cut = index + c.len_utf8();
            text.drain(..cut);
            return;
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[cfg(test)]
pub(crate) mod test_support {
    /// A stand-in ffmpeg: a shell script that copies stdin to the output
    /// file (its last argument) or fails with a message. Each call gets a
    /// fresh name (see [`crate::test_support::executable`]).
    pub(crate) fn fake_ffmpeg(dir: &std::path::Path, body: &str) -> String {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let path = dir.join(format!("ffmpeg-{n}"));
        crate::test_support::executable(&path, &format!("#!/bin/sh\n{body}\n"));
        path.display().to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::fake_ffmpeg;
    use super::*;

    #[test]
    fn keeps_the_end_of_stderr() {
        let mut text = "ab😀cd".to_owned();
        keep_tail(&mut text, 4);
        assert_eq!(text, "😀cd");
        keep_tail(&mut text, 3);
        assert_eq!(text, "cd");
        keep_tail(&mut text, 10);
        assert_eq!(text, "cd");
    }

    #[test]
    fn passes_ffmpeg_its_arguments() {
        assert_eq!(
            ffmpeg_args().join(" "),
            "-hide_banner -loglevel error -f image2pipe -framerate 10 -c:v mjpeg -i - \
             -vf scale=trunc(iw/2)*2:trunc(ih/2)*2 -c:v libvpx-vp9 -deadline realtime \
             -cpu-used 8 -b:v 0 -crf 38 -pix_fmt yuv420p -f webm -y /dev/fd/3"
        );
    }

    fn create(path: &std::path::Path) -> File {
        File::create(path).unwrap()
    }

    fn no_frames() -> FrameSource {
        Arc::new(|| None)
    }

    #[tokio::test]
    async fn reports_a_missing_ffmpeg() {
        let dir = tempfile::tempdir().unwrap();
        let recording = Recording::start(
            "/nonexistent/ffmpeg",
            &BTreeMap::new(),
            create(&dir.path().join("a.webm")),
            ".pirc/recordings/a.webm".into(),
            no_frames(),
            Arc::new(|| true),
        );
        assert_eq!(
            recording.failed().as_deref(),
            Some("ffmpeg not found (/nonexistent/ffmpeg); set PIRC_FFMPEG")
        );
        let stopped = recording.stop().await;
        assert_eq!(
            stopped.result().unwrap_err().message,
            "Recording failed: ffmpeg not found (/nonexistent/ffmpeg); set PIRC_FFMPEG"
        );
    }

    fn sh_env() -> BTreeMap<String, String> {
        std::env::var("PATH")
            .map(|path| BTreeMap::from([("PATH".to_owned(), path)]))
            .unwrap_or_default()
    }

    #[tokio::test]
    async fn writes_the_latest_frame_at_ten_per_second() {
        let dir = tempfile::tempdir().unwrap();
        let ffmpeg = fake_ffmpeg(dir.path(), r#"for last; do :; done; cat > "$last""#);
        let file = dir.path().join("a.webm");
        let frame = Arc::new(b"JPEG".to_vec());
        let recording = Recording::start(
            &ffmpeg,
            &sh_env(),
            create(&file),
            ".pirc/recordings/a.webm".into(),
            Arc::new(move || Some(frame.clone())),
            Arc::new(|| true),
        );
        tokio::time::sleep(Duration::from_millis(550)).await;
        let stopped = recording.stop().await;
        let result = stopped.result().unwrap();
        assert_eq!(result["recording"], false);
        assert_eq!(result["path"], ".pirc/recordings/a.webm");
        let bytes = result["bytes"].as_u64().unwrap();
        assert_eq!(bytes % 4, 0);
        assert!((12..=28).contains(&bytes), "{bytes}");
        assert!(result["durationMs"].as_i64().unwrap() >= 500);
    }

    #[tokio::test]
    async fn a_dropped_recording_ends_ffmpeg_with_its_input() {
        let dir = tempfile::tempdir().unwrap();
        let ffmpeg = fake_ffmpeg(
            dir.path(),
            r#"for last; do :; done; cat > "$last"; echo end >> "$last""#,
        );
        let file = dir.path().join("a.webm");
        let frame = Arc::new(b"JPEG".to_vec());
        let recording = Recording::start(
            &ffmpeg,
            &sh_env(),
            create(&file),
            "r".into(),
            Arc::new(move || Some(frame.clone())),
            Arc::new(|| true),
        );
        tokio::time::sleep(Duration::from_millis(250)).await;
        let mut exited = recording.exited.clone();
        drop(recording);
        let code = *tokio::time::timeout(Duration::from_secs(10), exited.wait_for(Option::is_some))
            .await
            .unwrap()
            .unwrap();
        let code = code.flatten();
        // Killed, it would have no exit code and no "end".
        assert_eq!(code, Some(0));
        let written = std::fs::read_to_string(&file).unwrap();
        assert!(
            written.starts_with("JPEG") && written.ends_with("end\n"),
            "{written}"
        );
    }

    #[tokio::test]
    async fn fails_with_ffmpeg_stderr_or_its_exit_code() {
        let dir = tempfile::tempdir().unwrap();
        let ffmpeg = fake_ffmpeg(dir.path(), "echo 'bad input' >&2; exit 1");
        let recording = Recording::start(
            &ffmpeg,
            &sh_env(),
            create(&dir.path().join("a.webm")),
            "r".into(),
            no_frames(),
            Arc::new(|| true),
        );
        for _ in 0..100 {
            if recording.failed().is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert_eq!(recording.failed().as_deref(), Some("bad input\n"));
        let error = recording.stop().await.result().unwrap_err();
        assert_eq!((error.status, &*error.code), (500, "browser_error"));
        assert_eq!(error.message, "Recording failed: bad input\n");

        // Stopped first: stderr is not the failure, the exit code is.
        let ffmpeg = fake_ffmpeg(dir.path(), "cat >/dev/null; echo late >&2; exit 3");
        let recording = Recording::start(
            &ffmpeg,
            &sh_env(),
            create(&dir.path().join("b.webm")),
            "r".into(),
            no_frames(),
            Arc::new(|| false),
        );
        let error = recording.stop().await.result().unwrap_err();
        assert_eq!(error.message, "Recording failed: ffmpeg exited with 3");
    }
}
