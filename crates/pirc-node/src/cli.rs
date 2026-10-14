//! `pirc-node`'s command line (`entry/common.ts`, `entry/node-runtime.ts`):
//! one executable for both node roles (plans/rust-rewrite.md, M6
//! decisions). M9 re-specifies it as conformance tests.

use pirc_protocol::NodeRole;

use crate::sandbox::BRIDGE_SUBCOMMAND;

/// The help text; internal subcommands are not listed.
pub const USAGE: &str = "Usage: pirc-node [chat] [--help | --version]

Starts the coding node with no arguments, or the chat node with `chat`.
";

/// What the arguments ask for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Command {
    /// No subcommand: the coding node; `chat`: the chat node.
    Run(NodeRole),
    Version,
    Help,
    /// Internal: a session agent, with its arguments.
    Agent(Vec<String>),
    /// Internal: one `ptc` script's QuickJS process.
    PtcGuest,
    /// Internal: the native sandbox's in-sandbox bridge, with its arguments.
    SandboxBridge(Vec<String>),
    /// Print "Unknown command: <it>" and the usage on stderr, exit 2.
    Unknown(String),
}

/// The command `args` (without the program name) ask for.
pub fn parse(args: Vec<String>) -> Command {
    // Only the agent and bridge accept an argument tail. Never silently
    // ignore typos after public help/version commands or ptc-guest.
    let public_len = if args.first().is_some_and(|arg| arg == "chat") {
        2
    } else {
        1
    };
    if args.len() > public_len
        && !args
            .first()
            .is_some_and(|arg| arg == "agent" || arg == BRIDGE_SUBCOMMAND)
    {
        return Command::Unknown(args[public_len].clone());
    }
    let mut args = args.into_iter();
    let Some(command) = args.next() else {
        return Command::Run(NodeRole::Node);
    };
    match command.as_str() {
        // `pirc-chat --help` / `--version` worked as the top level's.
        "chat" => match args.next().as_deref() {
            None => Command::Run(NodeRole::Chat),
            Some("version" | "--version") => Command::Version,
            Some("help" | "--help" | "-h") => Command::Help,
            Some(extra) => Command::Unknown(extra.to_owned()),
        },
        "version" | "--version" => Command::Version,
        "help" | "--help" | "-h" => Command::Help,
        "agent" => Command::Agent(args.collect()),
        "ptc-guest" => Command::PtcGuest,
        name if name == BRIDGE_SUBCOMMAND => Command::SandboxBridge(args.collect()),
        _ => Command::Unknown(command),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_str(args: &[&str]) -> Command {
        parse(args.iter().map(|arg| (*arg).to_owned()).collect())
    }

    #[test]
    fn subcommands() {
        assert_eq!(parse_str(&[]), Command::Run(NodeRole::Node));
        assert_eq!(parse_str(&["chat"]), Command::Run(NodeRole::Chat));
        assert_eq!(parse_str(&["chat", "x"]), Command::Unknown("x".into()));
        assert_eq!(parse_str(&["--version"]), Command::Version);
        for version in ["version", "--version"] {
            assert_eq!(parse_str(&["chat", version]), Command::Version);
        }
        for help in ["help", "--help", "-h"] {
            assert_eq!(parse_str(&["chat", help]), Command::Help);
        }
        assert_eq!(parse_str(&["version", "x"]), Command::Unknown("x".into()));
        assert_eq!(
            parse_str(&["chat", "--help", "x"]),
            Command::Unknown("x".into())
        );
        assert_eq!(parse_str(&["ptc-guest", "x"]), Command::Unknown("x".into()));
        for help in ["help", "--help", "-h"] {
            assert_eq!(parse_str(&[help]), Command::Help);
        }
        assert_eq!(
            parse_str(&["agent", "--mode", "rpc"]),
            Command::Agent(vec!["--mode".into(), "rpc".into()])
        );
        assert_eq!(parse_str(&["ptc-guest"]), Command::PtcGuest);
        assert_eq!(
            parse_str(&["sandbox-bridge", "a"]),
            Command::SandboxBridge(vec!["a".into()])
        );
        for unknown in [
            "node",
            "gateway",
            "srt",
            "ptc-worker",
            "oauth-worker",
            "--chat",
        ] {
            assert_eq!(parse_str(&[unknown]), Command::Unknown(unknown.into()));
        }
        assert!(!USAGE.contains("ptc-guest") && !USAGE.contains("agent"));
    }
}
