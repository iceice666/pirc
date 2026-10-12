//! Helpers shared by the crate's unit tests.

use std::io::Write as _;
use std::path::Path;
use std::process::{Command, Stdio};

/// Creates the executable `path` (which must not exist yet) holding
/// `contents`, for a test to exec.
///
/// The file is written and made executable by a short-lived `sh`, never by
/// this process: a write fd open here would be inherited by a child that
/// another test thread forks meanwhile, and exec'ing the script while that
/// child still holds it fails with ETXTBSY, "Text file busy"
/// (rust-lang/rust#114554). For the same reason a script that may have
/// run is never rewritten: give each version a fresh name.
pub(crate) fn executable(path: &Path, contents: &str) {
    assert!(!path.exists(), "{} already exists", path.display());
    let mut child = Command::new("/bin/sh")
        .args(["-c", r#"cat > "$1" && chmod 755 "$1""#, "sh"])
        .arg(path)
        .stdin(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    stdin.write_all(contents.as_bytes()).unwrap();
    drop(stdin);
    let status = child.wait().unwrap();
    assert!(status.success(), "writing {}: {status}", path.display());
}
