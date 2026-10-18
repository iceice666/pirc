//! A chat project's files (docs/guides/chat-projects.md#project-files):
//! files the user keeps for every chat of the project. Owner: **core**.
//!
//! - They are `<workspace>/files/<name>` (directory 0700, files 0600), next
//!   to the project's instructions, written by the node only. The first
//!   upload creates the directory.
//! - A session that starts while the directory exists may read it, never
//!   write it (the sandbox's read-only directories, see
//!   `runner::start`), and its agent is told where it is
//!   (`PIRC_PROJECT_FILES`). The directory is shared, not copied: an
//!   upload, a replacement or a removal reaches running chats at once.
//! - At most [`MAX_FILES`] files; each within the node's upload limit (the
//!   router refuses a larger body). Uploading a name that exists replaces
//!   that file (written beside it and renamed over it).
//! - Names are a single path component: the last `/`-separated part,
//!   trimmed, at most [`MAX_NAME_BYTES`] bytes, not starting with `.` (the
//!   node's temporary files do) and without control characters.

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use rustix::fs::{AtFlags, renameat, unlinkat};
use serde_json::{Value, json};

use crate::error::{ApiError, ApiResult};
use crate::store::Workspace;
use crate::util::{hex, random_bytes};

/// The directory below a chat workspace's own.
pub const FILES_DIR: &str = "files";
/// Files a project may hold.
pub const MAX_FILES: usize = 50;
/// The longest name, in bytes.
pub const MAX_NAME_BYTES: usize = 255;

/// Writes and removals one at a time, so the count holds.
static WRITES: Mutex<()> = Mutex::new(());

/// One file, as the routes list it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProjectFile {
    pub name: String,
    pub byte_size: u64,
    /// Milliseconds since the epoch.
    pub modified_at: i64,
}

impl ProjectFile {
    pub fn json(&self) -> Value {
        json!({
            "name": self.name,
            "byteSize": self.byte_size,
            "modifiedAt": self.modified_at,
        })
    }
}

/// A chat workspace's files directory (`None` for a directory workspace).
pub fn files_dir(workspace: &Workspace) -> Option<PathBuf> {
    workspace
        .kind
        .mode()
        .project_files
        .then(|| Path::new(&workspace.canonical_path).join(FILES_DIR))
}

/// The directory when it exists as a real directory: what a starting
/// session is given.
pub fn existing_files_dir(workspace: &Workspace) -> Option<PathBuf> {
    files_dir(workspace).filter(|dir| {
        std::fs::symlink_metadata(dir).is_ok_and(|metadata| metadata.file_type().is_dir())
    })
}

fn only_chat(workspace: &Workspace) -> ApiResult<PathBuf> {
    files_dir(workspace)
        .ok_or_else(|| ApiError::bad_request("Only chat projects have project files"))
}

fn io_failure(what: &str, path: &Path, error: std::io::Error) -> ApiError {
    crate::log::error(&format!("{what} {}: {error}", path.display()));
    ApiError::internal()
}

/// The stored name for `requested`, or 400 "filename is invalid".
pub fn file_name(requested: &str) -> ApiResult<String> {
    let base = requested
        .split('/')
        .rfind(|part| !part.is_empty())
        .unwrap_or_default();
    let name = crate::chat::js_trim(base);
    if name.is_empty()
        || name.starts_with('.')
        || name.len() > MAX_NAME_BYTES
        || name.chars().any(char::is_control)
    {
        return Err(ApiError::bad_request("filename is invalid"));
    }
    Ok(name.to_owned())
}

/// Whether a directory entry is one of the project's files.
fn listed(name: &str) -> bool {
    !name.starts_with('.')
}

/// The project's files, by name (none when the directory does not exist).
pub fn list(workspace: &Workspace) -> ApiResult<Vec<ProjectFile>> {
    let dir = only_chat(workspace)?;
    match std::fs::symlink_metadata(&dir) {
        Ok(metadata) if metadata.file_type().is_dir() => {}
        // Not one the node made: nothing is listed, and writing refuses it.
        Ok(_) => return Ok(Vec::new()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(io_failure("reading", &dir, error)),
    }
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(io_failure("reading", &dir, error)),
    };
    let mut files = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| io_failure("reading", &dir, error))?;
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        if !listed(&name) {
            continue;
        }
        // Not followed: the node writes regular files only.
        let Ok(metadata) = std::fs::symlink_metadata(entry.path()) else {
            continue;
        };
        if !metadata.file_type().is_file() {
            continue;
        }
        let modified_at = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |since| since.as_millis() as i64);
        files.push(ProjectFile {
            name,
            byte_size: metadata.len(),
            modified_at,
        });
    }
    files.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(files)
}

/// Store `bytes` as `requested` (replacing a file of that name); 409 when
/// the project already holds [`MAX_FILES`] others.
pub fn write(workspace: &Workspace, requested: &str, bytes: &[u8]) -> ApiResult<ProjectFile> {
    let dir_path = only_chat(workspace)?;
    let name = file_name(requested)?;
    let _guard = WRITES.lock().unwrap_or_else(|p| p.into_inner());
    let others = list(workspace)?
        .iter()
        .filter(|file| file.name != name)
        .count();
    if others >= MAX_FILES {
        return Err(ApiError::conflict(format!(
            "A project holds at most {MAX_FILES} files"
        )));
    }
    let root = Path::new(&workspace.canonical_path);
    let dir = crate::private_dir::open_dir(root, &[FILES_DIR])
        .map_err(|error| io_failure("opening", &dir_path, error))?;
    let temp = format!(".upload-{}", hex(&random_bytes::<8>()));
    let written = crate::private_dir::create_new(&dir, &temp)
        .and_then(|mut out| out.write_all(bytes))
        .and_then(|()| renameat(&dir, temp.as_str(), &dir, name.as_str()).map_err(Into::into));
    if let Err(error) = written {
        crate::private_dir::remove(&dir, &temp);
        return Err(io_failure("writing", &dir_path.join(&name), error));
    }
    list(workspace)?
        .into_iter()
        .find(|file| file.name == name)
        .ok_or_else(ApiError::internal)
}

/// Remove the file `requested`; 404 "File not found" when there is none.
pub fn remove(workspace: &Workspace, requested: &str) -> ApiResult<()> {
    let dir_path = only_chat(workspace)?;
    let name = file_name(requested)?;
    let _guard = WRITES.lock().unwrap_or_else(|p| p.into_inner());
    let path = dir_path.join(&name);
    match std::fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.file_type().is_file() => {}
        Ok(_) => return Err(ApiError::not_found("File not found")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(ApiError::not_found("File not found"));
        }
        Err(error) => return Err(io_failure("reading", &path, error)),
    }
    let root = Path::new(&workspace.canonical_path);
    let dir = crate::private_dir::open_dir(root, &[FILES_DIR])
        .map_err(|error| io_failure("opening", &dir_path, error))?;
    unlinkat(&dir, name.as_str(), AtFlags::empty())
        .map_err(|error| io_failure("removing", &path, error.into()))
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt as _;

    use serde_json::Map;

    use super::*;
    use crate::store::WorkspaceKind;

    fn workspace(dir: &Path, kind: WorkspaceKind) -> Workspace {
        Workspace {
            id: "p".into(),
            host_id: "n".into(),
            display_name: "P".into(),
            canonical_path: dir.to_string_lossy().into_owned(),
            defaults: Map::new(),
            kind,
        }
    }

    #[test]
    fn names_are_one_plain_component() {
        assert_eq!(file_name("notes.md").unwrap(), "notes.md");
        assert_eq!(file_name("a/b/ plan.pdf ").unwrap(), "plan.pdf");
        assert_eq!(file_name("../x.txt").unwrap(), "x.txt");
        for bad in ["", "  ", ".env", "..", "a/..", "/", "a\nb", "a\0b"] {
            assert_eq!(file_name(bad).unwrap_err().status, 400, "{bad:?}");
        }
        assert!(file_name(&"x".repeat(MAX_NAME_BYTES)).is_ok());
        assert!(file_name(&"x".repeat(MAX_NAME_BYTES + 1)).is_err());
    }

    #[test]
    fn upload_replace_list_and_remove() {
        let dir = tempfile::tempdir().unwrap();
        let project = workspace(dir.path(), WorkspaceKind::Chat);
        assert_eq!(list(&project).unwrap(), Vec::new());
        assert_eq!(existing_files_dir(&project), None);

        let file = write(&project, "b.txt", b"hello").unwrap();
        assert_eq!((file.name.as_str(), file.byte_size), ("b.txt", 5));
        write(&project, "a.md", b"# A").unwrap();
        let files_dir = dir.path().join(FILES_DIR);
        assert_eq!(existing_files_dir(&project), Some(files_dir.clone()));
        assert_eq!(
            std::fs::metadata(&files_dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(files_dir.join("b.txt"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        // A leftover temporary file and a directory are not listed.
        std::fs::write(files_dir.join(".upload-x"), "partial").unwrap();
        std::fs::create_dir(files_dir.join("sub")).unwrap();
        let names: Vec<_> = list(&project)
            .unwrap()
            .into_iter()
            .map(|f| f.name)
            .collect();
        assert_eq!(names, ["a.md", "b.txt"]);

        write(&project, "b.txt", b"hi").unwrap();
        assert_eq!(std::fs::read(files_dir.join("b.txt")).unwrap(), b"hi");
        assert_eq!(list(&project).unwrap().len(), 2);

        remove(&project, "b.txt").unwrap();
        assert_eq!(remove(&project, "b.txt").unwrap_err().status, 404);
        assert_eq!(remove(&project, "sub").unwrap_err().status, 404);
        assert_eq!(list(&project).unwrap().len(), 1);
    }

    #[test]
    fn a_full_project_still_replaces() {
        let dir = tempfile::tempdir().unwrap();
        let project = workspace(dir.path(), WorkspaceKind::Chat);
        for index in 0..MAX_FILES {
            write(&project, &format!("f{index}"), b"x").unwrap();
        }
        let error = write(&project, "one-more", b"x").unwrap_err();
        assert_eq!(
            (error.status, error.message.as_str()),
            (409, "A project holds at most 50 files")
        );
        write(&project, "f0", b"new").unwrap();
    }

    #[test]
    fn symlinks_are_neither_listed_nor_written_through() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let project = workspace(dir.path(), WorkspaceKind::Chat);
        std::os::unix::fs::symlink(outside.path(), dir.path().join(FILES_DIR)).unwrap();
        assert_eq!(existing_files_dir(&project), None);
        assert_eq!(write(&project, "a", b"x").unwrap_err().status, 500);
        assert!(std::fs::read_dir(outside.path()).unwrap().next().is_none());
    }

    #[test]
    fn directory_workspaces_have_none() {
        let dir = tempfile::tempdir().unwrap();
        let directory = workspace(dir.path(), WorkspaceKind::Directory);
        assert_eq!(files_dir(&directory), None);
        assert_eq!(list(&directory).unwrap_err().status, 400);
        assert_eq!(write(&directory, "a", b"x").unwrap_err().status, 400);
    }
}
