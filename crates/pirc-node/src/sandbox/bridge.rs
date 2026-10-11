//! `pirc-node sandbox-bridge`: runs inside the native sandbox, bridges
//! `127.0.0.1:3128` to the node's proxy socket, then runs the agent with
//! the remaining arguments (spike C's `inner`, replacing srt's socat
//! relays). Owner: **sandbox**. Internal: not in the help text.
//!
//! `sandbox-bridge <proxy socket> -- <command> [args...]`. The command
//! inherits stdin, stdout and stderr untouched (the agent's JSONL RPC); the
//! bridge exits with its status (128 + n for a signal). Plain threads: the
//! bridge carries a handful of connections and must not start a runtime
//! the agent does not need.

use std::io;
use std::net::{Shutdown, TcpListener, TcpStream};
use std::os::unix::net::UnixStream;
use std::os::unix::process::ExitStatusExt;
use std::path::PathBuf;
use std::process::{Command, ExitCode};
use std::thread;

use super::linux::BRIDGE_PORT;

/// The subcommand's arguments after its name.
pub fn run(args: Vec<String>) -> ExitCode {
    let mut args = args.into_iter();
    let (Some(socket), Some(separator)) = (args.next(), args.next()) else {
        return usage();
    };
    let command: Vec<String> = args.collect();
    if separator != "--" || command.is_empty() {
        return usage();
    }
    let socket = PathBuf::from(socket);
    // srt's socat listened on IPv4; `localhost` may resolve to ::1 first,
    // so that is served too when the namespace has it.
    let listener = match TcpListener::bind(("127.0.0.1", BRIDGE_PORT)) {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!(
                "pirc-node sandbox-bridge: cannot listen on 127.0.0.1:{BRIDGE_PORT}: {error}"
            );
            return ExitCode::from(125);
        }
    };
    let listeners = std::iter::once(listener).chain(TcpListener::bind(("::1", BRIDGE_PORT)).ok());
    for listener in listeners {
        let socket = socket.clone();
        thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let socket = socket.clone();
                thread::spawn(move || {
                    if let Ok(upstream) = UnixStream::connect(&socket) {
                        relay(stream, upstream);
                    }
                });
            }
        });
    }
    match Command::new(&command[0]).args(&command[1..]).status() {
        Ok(status) => {
            let code = status
                .code()
                .or_else(|| status.signal().map(|signal| 128 + signal))
                .unwrap_or(1);
            ExitCode::from(u8::try_from(code & 0xff).unwrap_or(1))
        }
        Err(error) => {
            eprintln!("pirc-node sandbox-bridge: {}: {error}", command[0]);
            ExitCode::from(127)
        }
    }
}

fn usage() -> ExitCode {
    eprintln!("usage: pirc-node sandbox-bridge <proxy socket> -- <command> [args...]");
    ExitCode::from(2)
}

/// Copy both ways until each side has finished writing.
fn relay(tcp: TcpStream, unix: UnixStream) {
    let (Ok(mut tcp_read), Ok(mut unix_write)) = (tcp.try_clone(), unix.try_clone()) else {
        return;
    };
    let forward = thread::spawn(move || {
        let _ = io::copy(&mut tcp_read, &mut unix_write);
        let _ = unix_write.shutdown(Shutdown::Write);
    });
    let (mut unix_read, mut tcp_write) = (unix, tcp);
    let _ = io::copy(&mut unix_read, &mut tcp_write);
    let _ = tcp_write.shutdown(Shutdown::Write);
    let _ = forward.join();
}
