//! Private state writes through the node, while subprocesses see read-only state.
use base64::Engine;
use pirc_protocol::InferenceConfig;
use serde_json::json;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;
static CONFIG: OnceLock<InferenceConfig> = OnceLock::new();
pub fn config() -> Option<&'static InferenceConfig> {
    CONFIG.get()
}
pub fn configure(config: Option<InferenceConfig>) -> Result<(), String> {
    if let Some(c) = config {
        if c.socket_path.is_empty() || c.token.is_empty() {
            return Err("Invalid persistence transport".into());
        }
        CONFIG
            .set(c)
            .map_err(|_| "Persistence already configured")?;
    }
    Ok(())
}
fn request(op: &str, path: &Path, to: Option<&Path>, data: &[u8]) -> io::Result<()> {
    let config = CONFIG
        .get()
        .ok_or_else(|| io::Error::other("Persistence unavailable"))?;
    let body = serde_json::to_vec(
        &json!({"op":op,"path":path,"to":to,"data":base64::engine::general_purpose::STANDARD.encode(data)}),
    )?;
    let address = pirc_protocol::SocketPath::new(Path::new(&config.socket_path))?;
    let mut stream = UnixStream::connect(&address.path)?;
    drop(address);
    stream.set_read_timeout(Some(Duration::from_secs(15)))?;
    stream.set_write_timeout(Some(Duration::from_secs(15)))?;
    write!(
        stream,
        "POST /persistence HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        config.token,
        body.len()
    )?;
    stream.write_all(&body)?;
    let mut response = Vec::new();
    stream.take(64 * 1024).read_to_end(&mut response)?;
    if !response.starts_with(b"HTTP/1.1 200 ") {
        return Err(io::Error::other("Node persistence request refused"));
    }
    Ok(())
}
pub fn create_dir_all(path: &Path) -> io::Result<()> {
    if CONFIG.get().is_some() {
        if path.is_dir() {
            return Ok(());
        }
        request("mkdir", path, None, &[])
    } else {
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(path)
    }
}
pub fn create_dir(path: &Path) -> io::Result<()> {
    if CONFIG.get().is_some() {
        if path.exists() {
            return Err(io::ErrorKind::AlreadyExists.into());
        }
        request("mkdir_new", path, None, &[])
    } else {
        fs::DirBuilder::new().mode(0o700).create(path)
    }
}
pub fn write(path: &Path, data: &[u8]) -> io::Result<()> {
    write_mode(path, data, "write")
}
pub fn append(path: &Path, data: &[u8]) -> io::Result<()> {
    write_mode(path, data, "append")
}
fn write_mode(path: &Path, data: &[u8], op: &str) -> io::Result<()> {
    if CONFIG.get().is_some() {
        if data.is_empty() {
            return request(op, path, None, data);
        }
        for (i, chunk) in data.chunks(256 * 1024).enumerate() {
            request(if i == 0 { op } else { "append" }, path, None, chunk)?;
        }
        Ok(())
    } else {
        let mut options = OpenOptions::new();
        options.write(true).create(true).mode(0o600);
        if op == "append" {
            options.append(true);
        } else {
            options.truncate(true);
        }
        options.open(path)?.write_all(data)
    }
}
pub fn rename(from: &Path, to: &Path) -> io::Result<()> {
    if CONFIG.get().is_some() {
        request("rename", from, Some(to), &[])
    } else {
        fs::rename(from, to)
    }
}
pub fn remove_file(path: &Path) -> io::Result<()> {
    if CONFIG.get().is_some() {
        request("remove", path, None, &[])
    } else {
        fs::remove_file(path)
    }
}
pub enum Writer {
    Local(File),
    Remote(PathBuf),
}
pub fn create_new(path: &Path) -> io::Result<Writer> {
    if CONFIG.get().is_some() {
        request("create", path, None, &[])?;
        Ok(Writer::Remote(path.to_path_buf()))
    } else {
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)
            .map(Writer::Local)
    }
}
impl Writer {
    pub fn sync_all(&self) -> io::Result<()> {
        match self {
            Self::Local(f) => f.sync_all(),
            Self::Remote(_) => Ok(()),
        }
    }
}
impl Write for Writer {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        match self {
            Self::Local(f) => f.write(bytes),
            Self::Remote(p) => {
                append(p, bytes)?;
                Ok(bytes.len())
            }
        }
    }
    fn flush(&mut self) -> io::Result<()> {
        match self {
            Self::Local(f) => f.flush(),
            Self::Remote(_) => Ok(()),
        }
    }
}
