//! Unix socket paths longer than `sockaddr_un` holds (the node's inference
//! socket lives under its state directory, which may be deep).
//!
//! Bun bound and connected such paths; `std` refuses them ("path must be
//! shorter than SUN_LEN"). On Linux the socket is reached through
//! `/proc/self/fd/<dir fd>/<name>` instead, a short path to the same
//! directory entry. Elsewhere the long path is used as it is and fails as
//! before.

use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};

/// Bytes `sockaddr_un.sun_path` holds with its terminating NUL: 108 on
/// Linux, 104 on macOS and the BSDs.
const SUN_PATH_BYTES: usize = if cfg!(target_os = "linux") { 108 } else { 104 };

/// A path to bind or connect to that the kernel accepts, and what must stay
/// open while it is used (the directory the short path goes through).
pub struct SocketPath {
    pub path: PathBuf,
    _directory: Option<File>,
}

impl SocketPath {
    /// `path` itself when it fits; on Linux, else, a path through an open
    /// descriptor of its directory.
    pub fn new(path: &Path) -> io::Result<Self> {
        use std::os::unix::ffi::OsStrExt;
        if path.as_os_str().as_bytes().len() < SUN_PATH_BYTES || !cfg!(target_os = "linux") {
            return Ok(Self {
                path: path.to_owned(),
                _directory: None,
            });
        }
        let (Some(parent), Some(name)) = (path.parent(), path.file_name()) else {
            return Ok(Self {
                path: path.to_owned(),
                _directory: None,
            });
        };
        let directory = File::open(parent)?;
        let short = Path::new("/proc/self/fd")
            .join(std::os::fd::AsRawFd::as_raw_fd(&directory).to_string())
            .join(name);
        Ok(Self {
            path: short,
            _directory: Some(directory),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_paths_are_kept() {
        let path = Path::new("/run/pirc/i-abc/socket");
        assert_eq!(SocketPath::new(path).unwrap().path, path);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn long_paths_bind_and_connect_through_the_directory() {
        let root = std::env::temp_dir().join(format!("pirc-socket-{}", std::process::id()));
        let directory = root.join("d".repeat(150));
        std::fs::create_dir_all(&directory).unwrap();
        let socket = directory.join("socket");
        let bound = SocketPath::new(&socket).unwrap();
        assert!(bound.path.starts_with("/proc/self/fd"));
        let listener = std::os::unix::net::UnixListener::bind(&bound.path).unwrap();
        assert!(socket.exists());
        let connect = SocketPath::new(&socket).unwrap();
        let _client = std::os::unix::net::UnixStream::connect(&connect.path).unwrap();
        let _ = listener.accept().unwrap();
        std::fs::remove_dir_all(&root).unwrap();
    }
}
