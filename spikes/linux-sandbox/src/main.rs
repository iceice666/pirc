//! M1 spike C (plans/rust-rewrite.md): the parts of srt's Linux sandbox pirc
//! uses, from Rust and without Node.
//!
//! - A session policy (`sandbox-policy.ts`: deny-read with re-allowed
//!   paths inside, write roots, deny-write inside them) becomes bubblewrap
//!   arguments, in srt's order (`linux-sandbox-utils.js`).
//! - The sandbox has its own network namespace. Its only way out is an HTTP
//!   proxy on a Unix socket in the host's namespace, which allows listed
//!   domains; the allowlist can grow while commands run (what srt's
//!   `--control-fd` does for human-approved domains).
//! - Inside, this same executable (`inner`) bridges `127.0.0.1:3128` to
//!   that socket, replacing srt's socat, then runs the command.
//!
//! pirc runs srt with `allowAllUnixSockets` on Linux (node/sandbox.ts), so
//! srt's seccomp helper is not used and not part of this spike.
//!
//! `bwrap` must be on PATH. `cargo run --release -- selftest` runs the checks.

use std::collections::BTreeSet;
use std::fs;
use std::io::{self, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// Where the in-sandbox bridge listens, as in srt.
const INNER_PROXY_PORT: u16 = 3128;

/// A session's filesystem rules, already resolved to absolute paths.
struct Policy {
    deny_read: Vec<PathBuf>,
    /// Readable again inside a denied directory.
    allow_read: Vec<PathBuf>,
    allow_write: Vec<PathBuf>,
    /// Read-only again inside a write root.
    deny_write: Vec<PathBuf>,
}

fn inside(path: &Path, root: &Path) -> bool {
    path.starts_with(root)
}

/// bubblewrap arguments for `policy`, in srt's order: the root read-only,
/// write roots, read denials (shallowest first) with their exceptions bound
/// back, write denials, then devices, namespaces and /proc.
fn bwrap_args(policy: &Policy, proxy_socket: &Path) -> Vec<String> {
    let mut args: Vec<String> = ["--new-session", "--die-with-parent", "--unshare-net"]
        .map(String::from)
        .to_vec();
    let mut push = |items: &[&str]| args.extend(items.iter().map(|s| s.to_string()));
    push(&["--ro-bind", "/", "/"]);
    let existing = |paths: &[PathBuf]| -> Vec<String> {
        paths
            .iter()
            .filter(|p| p.exists())
            .map(|p| p.display().to_string())
            .collect()
    };
    for path in existing(&policy.allow_write) {
        push(&["--bind", &path, &path]);
    }
    let mut deny_read: Vec<&PathBuf> = policy.deny_read.iter().filter(|p| p.exists()).collect();
    deny_read.sort_by_key(|p| p.components().count());
    for denied in deny_read {
        let shown = denied.display().to_string();
        if denied.is_dir() {
            push(&["--tmpfs", &shown]);
            // What a tmpfs buried: allowed reads (read-only) and write roots inside it.
            for allowed in policy.allow_read.iter().filter(|a| inside(a, denied) && a.exists()) {
                let a = allowed.display().to_string();
                let writable = policy.allow_write.iter().any(|w| inside(allowed, w));
                push(&[if writable { "--bind" } else { "--ro-bind" }, &a, &a]);
            }
            for writable in policy.allow_write.iter().filter(|w| inside(w, denied) && w.exists()) {
                let w = writable.display().to_string();
                push(&["--bind", &w, &w]);
            }
        } else {
            push(&["--ro-bind", "/dev/null", &shown]);
        }
    }
    for path in existing(&policy.deny_write) {
        push(&["--ro-bind", &path, &path]);
    }
    let socket = proxy_socket.display().to_string();
    push(&["--bind", &socket, &socket]);
    let proxy = format!("http://127.0.0.1:{INNER_PROXY_PORT}");
    for name in ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"] {
        push(&["--setenv", name, &proxy]);
    }
    // --cap-drop ALL as srt does: without its seccomp helper (pirc's case),
    // this is what keeps a command running as uid 0 from unmounting a deny.
    push(&["--dev", "/dev", "--unshare-pid", "--unshare-user", "--cap-drop", "ALL"]);
    push(&["--proc", "/proc"]);
    args
}

/// Run `command` under bwrap with `policy`; returns its exit status code.
fn run_sandboxed(policy: &Policy, proxy_socket: &Path, command: &str) -> io::Result<i32> {
    let exe = std::env::current_exe()?;
    let status = Command::new("bwrap")
        .args(bwrap_args(policy, proxy_socket))
        .arg("--")
        .arg(&exe)
        .args(["inner", &proxy_socket.display().to_string(), "/bin/sh", "-c", command])
        .status()?;
    Ok(status.code().unwrap_or(128))
}

// ---- inside the sandbox ------------------------------------------------------

/// `inner <socket> <command…>`: bridge 127.0.0.1:3128 to the proxy socket,
/// then run the command and exit with its status.
fn inner(socket: PathBuf, command: &[String]) -> ExitCode {
    let listener = match TcpListener::bind(("127.0.0.1", INNER_PROXY_PORT)) {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("bridge: {error}");
            return ExitCode::from(125);
        }
    };
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let socket = socket.clone();
            thread::spawn(move || {
                if let Ok(upstream) = UnixStream::connect(&socket) {
                    pipe_unix(stream, upstream);
                }
            });
        }
    });
    let status = Command::new(&command[0]).args(&command[1..]).status();
    ExitCode::from(status.ok().and_then(|s| s.code()).unwrap_or(127) as u8)
}

fn pipe_unix(tcp: TcpStream, unix: UnixStream) {
    let (mut tcp_read, mut unix_write) = (tcp.try_clone().unwrap(), unix.try_clone().unwrap());
    let forward = thread::spawn(move || {
        let _ = io::copy(&mut tcp_read, &mut unix_write);
        let _ = unix_write.shutdown(Shutdown::Write);
    });
    let (mut unix_read, mut tcp_write) = (unix, tcp);
    let _ = io::copy(&mut unix_read, &mut tcp_write);
    let _ = tcp_write.shutdown(Shutdown::Write);
    let _ = forward.join();
}

/// `http-get [--proxy] <http://host:port/path>`: 0 on 200, 1 on another
/// status, 2 when no connection could be made.
fn http_get(url: &str, proxy: bool) -> ExitCode {
    let Some(rest) = url.strip_prefix("http://") else {
        return ExitCode::from(2);
    };
    let (authority, path) = rest.split_once('/').map_or((rest, "/".to_owned()), |(a, p)| {
        (a, format!("/{p}"))
    });
    let (target, line) = if proxy {
        (format!("127.0.0.1:{INNER_PROXY_PORT}"), format!("GET {url} HTTP/1.1"))
    } else {
        (authority.to_owned(), format!("GET {path} HTTP/1.1"))
    };
    let mut stream = match TcpStream::connect_timeout(
        &target.parse().expect("ip:port"),
        Duration::from_secs(3),
    ) {
        Ok(stream) => stream,
        Err(error) => {
            println!("connect {target}: {error}");
            return ExitCode::from(2);
        }
    };
    let _ = write!(stream, "{line}\r\nHost: {authority}\r\nConnection: close\r\n\r\n");
    let mut response = String::new();
    let _ = stream.read_to_string(&mut response);
    let status = response.lines().next().unwrap_or_default().to_owned();
    println!("{status}");
    ExitCode::from(if status.contains(" 200 ") { 0 } else { 1 })
}

/// `http-connect <host:port>`: whether the proxy tunnels to it (HTTPS path).
fn http_connect(authority: &str) -> ExitCode {
    let Ok(mut stream) = TcpStream::connect(("127.0.0.1", INNER_PROXY_PORT)) else {
        return ExitCode::from(2);
    };
    let _ = write!(stream, "CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n\r\n");
    let mut buffer = [0u8; 256];
    let read = stream.read(&mut buffer).unwrap_or(0);
    let status = String::from_utf8_lossy(&buffer[..read]);
    println!("{}", status.lines().next().unwrap_or_default());
    ExitCode::from(if status.contains(" 200 ") { 0 } else { 1 })
}

// ---- the host side: the filtering proxy -------------------------------------

type Allowlist = Arc<Mutex<BTreeSet<String>>>;

fn allowed(list: &Allowlist, host: &str) -> bool {
    list.lock().unwrap().iter().any(|entry| {
        entry == host
            || entry
                .strip_prefix("*.")
                .is_some_and(|suffix| host.ends_with(&format!(".{suffix}")))
    })
}

fn serve_proxy(listener: UnixListener, list: Allowlist) {
    for stream in listener.incoming().flatten() {
        let list = list.clone();
        thread::spawn(move || {
            let _ = proxy_one(stream, &list);
        });
    }
}

fn proxy_one(mut client: UnixStream, list: &Allowlist) -> io::Result<()> {
    // The request head, byte by byte so nothing after it is consumed.
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if client.read(&mut byte)? == 0 || head.len() > 65536 {
            return Ok(());
        }
        head.push(byte[0]);
    }
    let head = String::from_utf8_lossy(&head).into_owned();
    let mut lines = head.split("\r\n");
    let request = lines.next().unwrap_or_default();
    let mut parts = request.split(' ');
    let (method, target, version) = (
        parts.next().unwrap_or_default(),
        parts.next().unwrap_or_default(),
        parts.next().unwrap_or("HTTP/1.1"),
    );
    let (authority, origin_form) = if method == "CONNECT" {
        (target.to_owned(), None)
    } else if let Some(rest) = target.strip_prefix("http://") {
        let (authority, path) = rest.split_once('/').map_or((rest, "/".to_owned()), |(a, p)| {
            (a, format!("/{p}"))
        });
        (authority.to_owned(), Some(path))
    } else {
        return deny(&mut client, "400 Bad Request");
    };
    let host = authority.rsplit_once(':').map_or(authority.as_str(), |(h, _)| h);
    if !allowed(list, host) {
        return deny(&mut client, "403 Forbidden");
    }
    let port_given = authority.contains(':');
    let address = if port_given { authority.clone() } else { format!("{authority}:80") };
    let mut upstream = match TcpStream::connect(&address) {
        Ok(stream) => stream,
        Err(_) => return deny(&mut client, "502 Bad Gateway"),
    };
    match origin_form {
        None => client.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")?,
        Some(path) => {
            let mut forwarded = format!("{method} {path} {version}\r\n");
            for line in lines.filter(|l| !l.is_empty() && !l.to_ascii_lowercase().starts_with("proxy-")) {
                forwarded.push_str(line);
                forwarded.push_str("\r\n");
            }
            forwarded.push_str("\r\n");
            upstream.write_all(forwarded.as_bytes())?;
        }
    }
    let (mut client_read, mut upstream_write) = (client.try_clone()?, upstream.try_clone()?);
    let forward = thread::spawn(move || {
        let _ = io::copy(&mut client_read, &mut upstream_write);
        let _ = upstream_write.shutdown(Shutdown::Write);
    });
    let _ = io::copy(&mut upstream, &mut client);
    let _ = client.shutdown(Shutdown::Write);
    let _ = forward.join();
    Ok(())
}

fn deny(client: &mut UnixStream, status: &str) -> io::Result<()> {
    write!(
        client,
        "HTTP/1.1 {status}\r\nX-Proxy-Error: blocked-by-allowlist\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    )
}

// ---- self test ---------------------------------------------------------------

fn serve_ok(listener: TcpListener) {
    for mut stream in listener.incoming().flatten() {
        let mut buffer = [0u8; 4096];
        let _ = stream.read(&mut buffer);
        let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
    }
}

fn selftest() -> ExitCode {
    let root = std::env::current_dir().unwrap().join("target/selftest");
    let _ = fs::remove_dir_all(&root);
    let (home, workspace, state, outside) = (
        root.join("home"),
        root.join("workspace"),
        root.join("state"),
        root.join("outside"),
    );
    let session = state.join("sessions/s1");
    for dir in [home.join(".ssh"), workspace.join(".git/hooks"), workspace.join(".pirc"), session.clone(), outside.clone()] {
        fs::create_dir_all(dir).unwrap();
    }
    fs::write(home.join(".ssh/id_rsa"), "secret").unwrap();
    fs::write(home.join(".bashrc"), "# rc").unwrap();
    fs::write(state.join("secret"), "node secret").unwrap();
    fs::write(workspace.join("README"), "hello").unwrap();
    fs::write(workspace.join(".git/config"), "[core]").unwrap();

    let policy = Policy {
        deny_read: vec![home.join(".ssh"), state.clone()],
        allow_read: vec![workspace.clone(), session.clone()],
        allow_write: vec![workspace.clone(), session.clone(), PathBuf::from("/tmp")],
        deny_write: vec![
            workspace.join(".git/hooks"),
            workspace.join(".git/config"),
            workspace.join(".pirc"),
            home.join(".bashrc"),
        ],
    };

    let web = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = web.local_addr().unwrap().port();
    thread::spawn(move || serve_ok(web));
    let socket = root.join("proxy.sock");
    let list: Allowlist = Arc::new(Mutex::new(BTreeSet::from(["localhost".to_owned()])));
    let proxy = UnixListener::bind(&socket).unwrap();
    let proxy_list = list.clone();
    thread::spawn(move || serve_proxy(proxy, proxy_list));

    let exe = std::env::current_exe().unwrap().display().to_string();
    let (w, h, s, o) = (
        workspace.display(),
        home.display(),
        state.display(),
        outside.display(),
    );
    let host_pid = std::process::id();
    let cases: Vec<(&str, String, bool)> = vec![
        ("probe", "exit 0".into(), true),
        ("read the workspace", format!("cat {w}/README"), true),
        ("write the workspace", format!("echo x > {w}/new.txt"), true),
        ("write outside the write roots", format!("echo x > {o}/x"), false),
        ("write the home directory", format!("echo x > {h}/new"), false),
        ("read ~/.ssh", format!("cat {h}/.ssh/id_rsa"), false),
        ("read the node's private state", format!("cat {s}/secret"), false),
        (
            "read and write the session dir inside it",
            format!("echo x > {s}/sessions/s1/f && cat {s}/sessions/s1/f"),
            true,
        ),
        ("write .git/hooks", format!("echo x > {w}/.git/hooks/pre-commit"), false),
        ("write .git/config", format!("echo x >> {w}/.git/config"), false),
        ("write .pirc", format!("touch {w}/.pirc/x"), false),
        ("write ~/.bashrc", format!("echo x >> {h}/.bashrc"), false),
        ("write /tmp", "echo x > /tmp/pirc-spike-$$ && rm /tmp/pirc-spike-$$".into(), true),
        ("see a host process", format!("kill -0 {host_pid}"), false),
        (
            "unmount a denial (non-root: refused even without --cap-drop)",
            format!("umount {h}/.ssh"),
            false,
        ),
        ("direct network", format!("{exe} http-get http://127.0.0.1:{port}/"), false),
        ("allowed domain via the proxy", format!("{exe} http-get --proxy http://localhost:{port}/"), true),
        ("CONNECT to an allowed domain", format!("{exe} http-connect localhost:{port}"), true),
        ("domain not allowed", format!("{exe} http-get --proxy http://127.0.0.1:{port}/"), false),
    ];
    let mut failures = 0;
    let mut check = |name: &str, command: &str, expect: bool| {
        let started = Instant::now();
        let code = run_sandboxed(&policy, &socket, command).expect("bwrap");
        let ok = (code == 0) == expect;
        if !ok {
            failures += 1;
        }
        println!(
            "{} {name:<44} exit {code:<3} {:>5} ms",
            if ok { "PASS" } else { "FAIL" },
            started.elapsed().as_millis()
        );
    };
    for (name, command, expect) in &cases {
        check(name, command, *expect);
    }
    // A human approves the domain while the session runs.
    list.lock().unwrap().insert("127.0.0.1".to_owned());
    check(
        "the same domain after approval",
        &format!("{exe} http-get --proxy http://127.0.0.1:{port}/"),
        true,
    );
    if failures == 0 {
        ExitCode::SUCCESS
    } else {
        println!("{failures} failed");
        ExitCode::FAILURE
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("selftest") => selftest(),
        Some("inner") if args.len() > 2 => inner(PathBuf::from(&args[1]), &args[2..]),
        Some("http-get") if args.get(1).map(String::as_str) == Some("--proxy") => {
            http_get(&args[2], true)
        }
        Some("http-get") => http_get(&args[1], false),
        Some("http-connect") => http_connect(&args[1]),
        _ => {
            eprintln!("usage: linux-sandbox selftest");
            ExitCode::from(2)
        }
    }
}
