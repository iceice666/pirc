//! The sources' credentials, `$PIRC_STATE_DIR/sources/secrets.json`: app
//! passwords, Moodle tokens, ICS addresses (which are secrets themselves).
//! The directory is the owner's only (0700), the file 0600, written whole
//! through a temporary file and a rename. Nothing here is ever returned by
//! the API or shown to the brain.

use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::Value;

pub struct Secrets {
    path: PathBuf,
    values: Mutex<BTreeMap<String, Value>>,
}

impl Secrets {
    /// Read the file under `state_dir` (none yet: empty).
    pub fn open(state_dir: &Path) -> Result<Self, String> {
        let path = state_dir.join("sources").join("secrets.json");
        let values = match fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|error| format!("{}: {error}", path.display()))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => BTreeMap::new(),
            Err(error) => return Err(format!("{}: {error}", path.display())),
        };
        Ok(Self {
            path,
            values: Mutex::new(values),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, BTreeMap<String, Value>> {
        self.values
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn get(&self, id: &str) -> Option<Value> {
        self.lock().get(id).cloned()
    }

    pub fn put(&self, id: &str, secret: Value) -> Result<(), String> {
        let mut values = self.lock();
        let before = values.insert(id.to_owned(), secret);
        if let Err(error) = write(&self.path, &values) {
            match before {
                Some(before) => values.insert(id.to_owned(), before),
                None => values.remove(id),
            };
            return Err(error);
        }
        Ok(())
    }

    pub fn remove(&self, id: &str) -> Result<(), String> {
        let mut values = self.lock();
        if values.remove(id).is_none() {
            return Ok(());
        }
        write(&self.path, &values)
    }
}

fn write(path: &Path, values: &BTreeMap<String, Value>) -> Result<(), String> {
    let describe = |error: std::io::Error| format!("{}: {error}", path.display());
    let dir = path.parent().unwrap_or(Path::new("."));
    fs::create_dir_all(dir).map_err(describe)?;
    fs::set_permissions(dir, fs::Permissions::from_mode(0o700)).map_err(describe)?;
    let temporary = dir.join(format!(".secrets.{}.tmp", std::process::id()));
    let bytes = serde_json::to_vec_pretty(values).map_err(|error| error.to_string())?;
    let written = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        fs::rename(&temporary, path)
    })();
    if let Err(error) = written {
        let _ = fs::remove_file(&temporary);
        return Err(describe(error));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn kept_private_and_across_opens() {
        let dir = tempfile::tempdir().unwrap();
        let secrets = Secrets::open(dir.path()).unwrap();
        assert_eq!(secrets.get("email:a"), None);
        secrets
            .put("email:a", json!({ "password": "app-pass" }))
            .unwrap();
        secrets.put("moodle:b", json!({ "token": "t" })).unwrap();
        secrets.remove("moodle:b").unwrap();
        let file = dir.path().join("sources/secrets.json");
        let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&file), 0o600);
        assert_eq!(mode(&dir.path().join("sources")), 0o700);
        let again = Secrets::open(dir.path()).unwrap();
        assert_eq!(
            again.get("email:a"),
            Some(json!({ "password": "app-pass" }))
        );
        assert_eq!(again.get("moodle:b"), None);
    }
}
