//! Descriptor-based reads for daemon-private files. Callers must separately
//! protect/validate parent directories; this rejects unsafe final components.
use rustix::fs::{Mode, OFlags};
use std::{fs::File, io, os::unix::fs::MetadataExt, path::Path};

/// Open an owner-private regular file without following its final symlink or
/// blocking on a FIFO. Validate the descriptor actually opened, before reading.
/// Multiple hard links are allowed for atomic no-clobber publication/recovery.
pub fn open_private_regular(path: &Path) -> io::Result<File> {
    let file = File::from(rustix::fs::open(
        path,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
        Mode::empty(),
    )?);
    let metadata = file.metadata()?;
    if !metadata.is_file()
        || metadata.mode() & 0o077 != 0
        || metadata.uid() != rustix::process::getuid().as_raw()
    {
        return Err(io::Error::other("unsafe private file"));
    }
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs::{self, OpenOptions},
        io::{Read, Write},
        os::unix::fs::{OpenOptionsExt, PermissionsExt, symlink},
    };
    #[test]
    fn reads_private_files_and_rejects_links_special_files_and_public_modes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("private");
        OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&path)
            .unwrap()
            .write_all(b"private data")
            .unwrap();
        let mut value = String::new();
        open_private_regular(&path)
            .unwrap()
            .read_to_string(&mut value)
            .unwrap();
        assert_eq!(value, "private data");
        fs::hard_link(&path, dir.path().join("publication")).unwrap();
        assert!(open_private_regular(&path).is_ok());
        let link = dir.path().join("link");
        symlink(&path, &link).unwrap();
        assert!(open_private_regular(&link).is_err());
        assert!(open_private_regular(dir.path()).is_err());
        let fifo = dir.path().join("fifo");
        assert!(
            std::process::Command::new("mkfifo")
                .arg(&fifo)
                .status()
                .unwrap()
                .success()
        );
        assert!(open_private_regular(&fifo).is_err());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(open_private_regular(&path).is_err());
    }
}
