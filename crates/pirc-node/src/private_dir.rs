//! Node-side writes into a session's `.pirc/<dir>` (uploads copied for the
//! agent, browser recordings). The node writes there from outside the
//! sandbox, so a symlink a cloned repository tracks at `.pirc/uploads` or
//! `.pirc/recordings`, or at a file in them, must not redirect the write
//! (security audit I2). Every component below the session root is opened
//! without following symlinks, and files are created exclusively.

use std::fs::File;
use std::io;
use std::os::fd::OwnedFd;
use std::path::Path;

use rustix::fs::{AtFlags, CWD, Mode, OFlags, mkdirat, openat, unlinkat};
use rustix::io::Errno;

/// `root/<parts…>`, each part created (mode 0700) when missing and opened
/// as a directory without following a symlink. `root` itself is created
/// when missing and may be a symlink: it is the node's own path.
pub fn open_dir(root: &Path, parts: &[&str]) -> io::Result<OwnedFd> {
    std::fs::create_dir_all(root)?;
    let mut dir = openat(
        CWD,
        root,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
        Mode::empty(),
    )?;
    for part in parts {
        if part.is_empty() || *part == "." || *part == ".." || part.contains('/') {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid directory name",
            ));
        }
        match mkdirat(&dir, *part, Mode::RWXU) {
            Ok(()) | Err(Errno::EXIST) => {}
            Err(error) => return Err(error.into()),
        }
        dir = openat(
            &dir,
            *part,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|error| refused(error, part))?;
    }
    Ok(dir)
}

/// A new file `name` in `dir` (mode 0600, write-only). Any existing entry,
/// a symlink included, is `AlreadyExists`.
pub fn create_new(dir: &OwnedFd, name: &str) -> io::Result<File> {
    let fd = openat(
        dir,
        name,
        OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::RUSR | Mode::WUSR,
    )?;
    Ok(File::from(fd))
}

/// Remove `name` from `dir` (a partial file), ignoring errors.
pub fn remove(dir: &OwnedFd, name: &str) {
    let _ = unlinkat(dir, name, AtFlags::empty());
}

/// A symlink where a directory is expected is `ELOOP` (Linux) or `ENOTDIR`
/// (`O_DIRECTORY` checked first); both name the refused component.
fn refused(error: Errno, part: &str) -> io::Error {
    if error == Errno::LOOP || error == Errno::NOTDIR {
        io::Error::other(format!("{part} is not a directory (a symlink?)"))
    } else {
        error.into()
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write as _;
    use std::os::unix::fs::{PermissionsExt as _, symlink};

    use super::*;

    #[test]
    fn creates_private_directories_and_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("session");
        let uploads = open_dir(&root, &[".pirc", "uploads"]).unwrap();
        let mode = std::fs::metadata(root.join(".pirc/uploads"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o700);
        let mut file = create_new(&uploads, "a.txt").unwrap();
        file.write_all(b"hi").unwrap();
        let path = root.join(".pirc/uploads/a.txt");
        assert_eq!(std::fs::read(&path).unwrap(), b"hi");
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        // Existing: not overwritten.
        let error = create_new(&uploads, "a.txt").unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        // Opened again, the directory is reused.
        let again = open_dir(&root, &[".pirc", "uploads"]).unwrap();
        remove(&again, "a.txt");
        assert!(!path.exists());
    }

    #[test]
    fn refuses_symlinks_below_the_root() {
        let dir = tempfile::tempdir().unwrap();
        let outside = dir.path().join("outside");
        std::fs::create_dir(&outside).unwrap();

        // A symlinked `.pirc`, and a symlinked `.pirc/recordings`.
        let a = dir.path().join("a");
        std::fs::create_dir(&a).unwrap();
        symlink(&outside, a.join(".pirc")).unwrap();
        assert!(open_dir(&a, &[".pirc", "recordings"]).is_err());
        let b = dir.path().join("b");
        std::fs::create_dir_all(b.join(".pirc")).unwrap();
        symlink(&outside, b.join(".pirc/recordings")).unwrap();
        assert!(open_dir(&b, &[".pirc", "recordings"]).is_err());
        assert!(!outside.join("recordings").exists());

        // A symlinked file, even to a missing target.
        let c = dir.path().join("c");
        let recordings = open_dir(&c, &[".pirc", "recordings"]).unwrap();
        symlink(outside.join("x.webm"), c.join(".pirc/recordings/x.webm")).unwrap();
        let error = create_new(&recordings, "x.webm").unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert!(!outside.join("x.webm").exists());

        assert!(open_dir(&c, &[".."]).is_err());
        assert!(open_dir(&c, &["a/b"]).is_err());
    }
}
