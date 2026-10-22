//! Read-only, bounded observations. Descriptor walking refuses links, special
//! files, nested repositories and mount crossings; it never mutates a workspace.
use super::{FileVersion, Scope, digest};
use pirc_policy::PathGuard;
use rustix::fs::{Mode, OFlags, open, openat};
use std::fs::File;
use std::io::{self, Read};
use std::os::unix::fs::MetadataExt;
use std::path::{Component, Path};

pub(super) struct Observation {
    pub version: FileVersion,
    pub bytes: Option<Vec<u8>>,
}

fn excluded(reason: &str) -> Observation {
    Observation {
        version: FileVersion::Excluded {
            reason: reason.into(),
        },
        bytes: None,
    }
}

pub fn relative(scope: &Scope, path: &Path) -> Result<String, String> {
    let path = path
        .strip_prefix(&scope.root)
        .map_err(|_| "path is outside checkpoint workspace")?;
    if path.as_os_str().is_empty()
        || path
            .components()
            .any(|p| !matches!(p, Component::Normal(_)))
    {
        return Err("checkpoint path must name an ordinary relative file".into());
    }
    let text = path.to_str().ok_or("checkpoint path is not UTF-8")?;
    if text.len() > 4096 {
        return Err("checkpoint path is too long".into());
    }
    Ok(text.into())
}

pub(super) fn observe(scope: &Scope, relative: &str, limit: u64) -> Result<Observation, String> {
    let run = || -> io::Result<Observation> {
        let path = Path::new(relative);
        if path
            .components()
            .any(|p| !matches!(p, Component::Normal(_)))
        {
            return Ok(excluded("invalid_path"));
        }
        if path.components().any(|p| {
            matches!(
                p.as_os_str()
                    .to_str()
                    .map(str::to_ascii_lowercase)
                    .as_deref(),
                Some(
                    ".git"
                        | ".pirc"
                        | ".state"
                        | "node_modules"
                        | "target"
                        | "build"
                        | ".dart_tool"
                )
            )
        }) {
            return Ok(excluded("excluded_directory"));
        }
        let absolute = scope.root.join(path);
        let guard = PathGuard::new(&scope.root.to_string_lossy(), &scope.policy, &[]);
        if guard.resolve(&absolute.to_string_lossy(), false).is_err() {
            return Ok(excluded("deny_read"));
        }
        let mut dir = File::from(open(
            &scope.root,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )?);
        let root = dir.metadata()?;
        if (root.dev(), root.ino()) != (scope.device, scope.inode) {
            return Ok(excluded("workspace_identity_changed"));
        }
        let mut parts = path.components().peekable();
        while let Some(part) = parts.next() {
            let last = parts.peek().is_none();
            let flags = OFlags::RDONLY
                | OFlags::NOCTTY
                | OFlags::NOFOLLOW
                | OFlags::NONBLOCK
                | OFlags::CLOEXEC
                | if last {
                    OFlags::empty()
                } else {
                    OFlags::DIRECTORY
                };
            let opened = openat(&dir, part.as_os_str(), flags, Mode::empty());
            let mut file = match opened {
                Ok(fd) => File::from(fd),
                Err(rustix::io::Errno::NOENT) => {
                    return Ok(Observation {
                        version: FileVersion::Absent,
                        bytes: None,
                    });
                }
                Err(rustix::io::Errno::LOOP | rustix::io::Errno::NOTDIR) => {
                    return Ok(excluded("symlink_or_type_collision"));
                }
                Err(error) => return Err(error.into()),
            };
            let meta = file.metadata()?;
            if meta.dev() != scope.device {
                return Ok(excluded("mount_crossing"));
            }
            if !last {
                if rustix::fs::statat(&file, ".git", rustix::fs::AtFlags::SYMLINK_NOFOLLOW).is_ok()
                {
                    return Ok(excluded("nested_repository"));
                }
                dir = file;
                continue;
            }
            if !meta.is_file() || meta.nlink() != 1 {
                return Ok(excluded("special_or_hardlinked_file"));
            }
            if meta.len() > limit {
                return Ok(excluded("file_limit"));
            }
            let mut bytes = Vec::new();
            (&mut file).take(limit + 1).read_to_end(&mut bytes)?;
            let end = file.metadata()?;
            let current_root = std::fs::metadata(&scope.root)?;
            if (current_root.dev(), current_root.ino()) != (scope.device, scope.inode) {
                return Ok(excluded("workspace_identity_changed"));
            }
            let named = rustix::fs::statat(
                &dir,
                part.as_os_str(),
                rustix::fs::AtFlags::SYMLINK_NOFOLLOW,
            )?;
            // stat's device/inode integer widths differ on Darwin and Linux.
            #[allow(clippy::unnecessary_cast)]
            let named_identity = (named.st_dev as u64, named.st_ino as u64);
            if bytes.len() as u64 > limit
                || meta.len() != bytes.len() as u64
                || (meta.dev(), meta.ino()) != named_identity
                || meta.len() != end.len()
                || meta.mtime() != end.mtime()
                || meta.mtime_nsec() != end.mtime_nsec()
                || meta.ctime() != end.ctime()
                || meta.ctime_nsec() != end.ctime_nsec()
            {
                return Ok(excluded("changed_during_read"));
            }
            return Ok(Observation {
                version: FileVersion::File {
                    hash: digest(&bytes),
                    size: bytes.len() as u64,
                    executable: meta.mode() & 0o111 != 0,
                },
                bytes: Some(bytes),
            });
        }
        Ok(excluded("invalid_path"))
    };
    run().map_err(|error| format!("checkpoint observation failed: {error}"))
}
