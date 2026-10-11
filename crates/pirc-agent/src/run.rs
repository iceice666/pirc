//! `pirc-node agent --session-dir DIR` (`agent/main.ts`): the `configure`
//! handshake, the agent, then RPC until stdin ends.

use std::io::BufRead;
use std::path::PathBuf;
use std::process::ExitCode;
use std::rc::Rc;

use pirc_protocol::Models;
use serde_json::Value;
use tokio::sync::mpsc;

use crate::agent::{Agent, AgentOptions, NameSource};
use crate::capabilities::Capabilities;
use crate::channels::{NodeChannels, node_channels, process_write_lease};
use crate::config::load_agent_config;
use crate::roles::AgentRole;
use crate::rpc::{RpcUi, Write, serve_rpc, stdout_write};
use crate::session_store::SessionStore;
use crate::ui::{NotifyLevel, Ui};

/// A parsed option (`parseArgs` with `strict: false`): a value, or `true`
/// for a flag given without one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Arg {
    Flag,
    Value(String),
}

/// The options `runAgent` reads. `--mode` and `--continue` are legacy and
/// ignored (sessions always resume from their directory).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Args {
    pub session_dir: Option<Arg>,
    pub model: Option<Arg>,
    pub thinking: Option<Arg>,
    pub name: Option<Arg>,
    pub headless: Option<Arg>,
    pub tools: Option<Arg>,
}

/// String-typed options take the next argument as their value.
const STRING_OPTIONS: [&str; 6] = ["session-dir", "mode", "model", "thinking", "name", "tools"];

/// `parseArgs({ strict: false })` as Bun runs it: `--name=value`, a string
/// option takes the next argument (whatever it is), `--` ends the options,
/// the last occurrence wins, unknown options and positionals are ignored.
pub fn parse_args(args: &[String]) -> Args {
    let mut out = Args::default();
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        index += 1;
        if arg == "--" {
            break;
        }
        let Some(option) = arg.strip_prefix("--") else {
            continue;
        };
        let (name, value) = match option.split_once('=') {
            Some((name, value)) => (name, Arg::Value(value.to_owned())),
            None if STRING_OPTIONS.contains(&option) && index < args.len() => {
                index += 1;
                (option, Arg::Value(args[index - 1].clone()))
            }
            None => (option, Arg::Flag),
        };
        let slot = match name {
            "session-dir" => &mut out.session_dir,
            "model" => &mut out.model,
            "thinking" => &mut out.thinking,
            "name" => &mut out.name,
            "headless" => &mut out.headless,
            "tools" => &mut out.tools,
            _ => continue,
        };
        *slot = Some(value);
    }
    out
}

fn string(arg: &Option<Arg>) -> Option<&str> {
    match arg {
        Some(Arg::Value(value)) => Some(value),
        _ => None,
    }
}

/// The `configure` line: the public catalog with the node's inference
/// transport, the chat policy, project instructions and a role.
pub struct Configure {
    pub models: Models,
    pub capabilities: Capabilities,
    pub instructions: Option<String>,
    pub role: Option<AgentRole>,
}

/// `readConfigure`: the first non-blank line must be the configure message.
pub async fn read_configure(
    lines: &mut mpsc::UnboundedReceiver<String>,
) -> Result<Configure, String> {
    loop {
        let Some(line) = lines.recv().await else {
            return Err("stdin closed before the configure message".to_owned());
        };
        if crate::rpc::blank(&line) {
            continue;
        }
        let message: Value = serde_json::from_str(&line)
            .map_err(|_| "The first stdin line must be a JSON configure message".to_owned())?;
        return parse_configure(&message);
    }
}

pub fn parse_configure(message: &Value) -> Result<Configure, String> {
    if message.get("type").and_then(Value::as_str) != Some("configure") {
        return Err(
            "The first stdin line must be {\"type\":\"configure\",\"models\":…}".to_owned(),
        );
    }
    let models = match message.get("models") {
        None | Some(Value::Null) => Value::Object(Default::default()),
        Some(models) => models.clone(),
    };
    let models = crate::remote::parse_models(&models)?;
    let capabilities =
        Capabilities::from_value(message.get("capabilities").unwrap_or(&Value::Null));
    let instructions = message
        .get("instructions")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let role = message.get("role").and_then(|role| {
        let name = role.get("name")?.as_str()?;
        Some(AgentRole {
            name: name.to_owned(),
            instructions: role
                .get("instructions")
                .and_then(Value::as_str)
                .map(str::to_owned),
            models: role.get("models").and_then(Value::as_array).map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            }),
        })
    });
    Ok(Configure {
        models,
        capabilities,
        instructions,
        role,
    })
}

/// Lines of stdin (`stdinLines`), read on their own thread so a blocked read
/// never holds the runtime up; invalid UTF-8 becomes U+FFFD.
fn stdin_lines() -> mpsc::UnboundedReceiver<String> {
    let (sender, receiver) = mpsc::unbounded_channel();
    std::thread::spawn(move || {
        let mut stdin = std::io::stdin().lock();
        let mut line = Vec::new();
        loop {
            line.clear();
            match stdin.read_until(b'\n', &mut line) {
                Ok(0) | Err(_) => return,
                Ok(_) => {
                    if line.last() == Some(&b'\n') {
                        line.pop();
                    }
                    if sender
                        .send(String::from_utf8_lossy(&line).into_owned())
                        .is_err()
                    {
                        return;
                    }
                }
            }
        }
    });
    receiver
}

/// What ends the agent: success (stdin ended or a signal), or an error
/// that TS would have let escape (printed, exit 1).
async fn main(args: Vec<String>) -> Result<(), String> {
    let args = parse_args(&args);
    // Tool allowlist (restricted kinds). Team members' coordination tools are M5.
    let allowed_tools = string(&args.tools).map(|tools| {
        tools
            .split(',')
            .filter(|tool| !tool.is_empty())
            .map(str::to_owned)
            .collect::<Vec<_>>()
    });
    let session_dir = match &args.session_dir {
        Some(Arg::Value(dir)) => Some(dir.clone()),
        Some(Arg::Flag) => None,
        None => std::env::var("PI_CODING_AGENT_SESSION_DIR").ok(),
    }
    .filter(|dir| !dir.is_empty())
    .ok_or("--session-dir is required")?;
    let cwd = std::env::current_dir()
        .map_err(|error| error.to_string())?
        .to_string_lossy()
        .into_owned();
    let write: Write = stdout_write();
    let ui = RpcUi::new(write.clone());
    let mut lines = stdin_lines();
    let configured = read_configure(&mut lines).await?;
    let config = load_agent_config(&cwd, configured.models, &|name| std::env::var(name).ok())?;
    let warnings = config.warnings.clone();
    let store = SessionStore::open(PathBuf::from(session_dir), &cwd)?;
    let agent = Agent::new(AgentOptions {
        config,
        capabilities: configured.capabilities,
        project_instructions: configured.instructions.filter(|text| !text.is_empty()),
        role: configured.role,
        store,
        emit: write.clone(),
        ui: ui.clone(),
        has_ui: !headless(&args.headless),
        tools: crate::tools::builtin_tools(),
        acquire_write: process_write_lease(),
        allowed_tools,
        stream_override: None,
    });
    agent.refresh_models().await;
    if let Some(model) = string(&args.model)
        && let Some((provider, id)) = model.split_once('/')
    {
        agent.set_model(provider, id)?;
    }
    if let Some(level) = string(&args.thinking) {
        agent.set_thinking(level)?;
    }
    // `!agent.sessionName`: a recorded empty name counts as none.
    if let Some(name) = string(&args.name)
        && agent
            .session_name()
            .is_none_or(|current| current.is_empty())
    {
        agent.set_name(name, NameSource::User)?;
    }
    // E.g. an untrusted project config whose hooks / env / allowedPaths were ignored (H3).
    for warning in &warnings {
        ui.notify(warning, NotifyLevel::Warning);
    }
    agent.init().await;
    let channels = node_channels();
    let mut terminate = signal(tokio::signal::unix::SignalKind::terminate())?;
    let mut interrupt = signal(tokio::signal::unix::SignalKind::interrupt())?;
    let serve = serve_rpc(
        agent.clone(),
        ui.clone(),
        channels.clone(),
        write,
        &mut lines,
    );
    tokio::pin!(serve);
    let signalled = tokio::select! {
        served = &mut serve => {
            crash_on(served);
            false
        }
        _ = terminate.recv() => true,
        _ = interrupt.recv() => true,
    };
    let shutting_down = shutdown(&agent, &ui, &channels);
    tokio::pin!(shutting_down);
    if !signalled {
        shutting_down.await;
        return Ok(());
    }
    // `process.once`: stdin is still served while shutting down (a run may
    // still need its node), and a second signal ends the process.
    let mut serving = true;
    loop {
        tokio::select! {
            () = &mut shutting_down => return Ok(()),
            served = &mut serve, if serving => {
                crash_on(served);
                serving = false;
            }
            _ = terminate.recv() => exit(128 + 15),
            _ = interrupt.recv() => exit(128 + 2),
        }
    }
}

/// An error that escaped the RPC loop crashed the TS agent on the spot:
/// exit without running what is still pending (whose cleanup would write
/// cancel requests the TS agent never sent).
fn crash_on(served: Result<(), String>) {
    if let Err(error) = served {
        eprintln!("error: {error}");
        exit(1);
    }
}

/// `process::exit` runs no destructors, so the shells' process groups are
/// killed first: no command outlives the agent.
fn exit(code: i32) -> ! {
    crate::tools::bash::kill_live_groups();
    std::process::exit(code)
}

/// `!values.headless`: a flag or a non-empty value.
fn headless(arg: &Option<Arg>) -> bool {
    match arg {
        Some(Arg::Flag) => true,
        Some(Arg::Value(value)) => !value.is_empty(),
        None => false,
    }
}

fn signal(kind: tokio::signal::unix::SignalKind) -> Result<tokio::signal::unix::Signal, String> {
    tokio::signal::unix::signal(kind).map_err(|error| error.to_string())
}

async fn shutdown(agent: &Rc<Agent>, ui: &RpcUi, channels: &NodeChannels) {
    ui.cancel_all();
    channels.close_all();
    agent.shutdown().await;
}

/// Run one session agent; `args` follow `agent`.
pub fn run_agent(args: Vec<String>) -> ExitCode {
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("error: {error}");
            return ExitCode::FAILURE;
        }
    };
    let local = tokio::task::LocalSet::new();
    let outcome = runtime.block_on(local.run_until(main(args)));
    // Like `process.exit`: nothing still running is waited for.
    {
        let _context = runtime.enter();
        drop(local);
    }
    runtime.shutdown_background();
    match outcome {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("error: {error}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn args(list: &[&str]) -> Args {
        parse_args(&list.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>())
    }

    fn value(text: &str) -> Option<Arg> {
        Some(Arg::Value(text.to_owned()))
    }

    #[test]
    fn parses_arguments_as_bun_parse_args_does() {
        // Cases checked against Bun's `parseArgs({ strict: false })`.
        let parsed = args(&["--session-dir", "/x", "--model"]);
        assert_eq!(parsed.session_dir, value("/x"));
        assert_eq!(parsed.model, Some(Arg::Flag));
        assert_eq!(
            args(&["--model", "--thinking", "high"]).model,
            value("--thinking")
        );
        assert_eq!(args(&["--model", "--thinking", "high"]).thinking, None);
        let parsed = args(&[
            "--model=a/b",
            "--headless=yes",
            "pos",
            "--foo",
            "--session-dir",
            "a",
            "--session-dir",
            "b",
        ]);
        assert_eq!(parsed.model, value("a/b"));
        assert_eq!(parsed.headless, value("yes"));
        assert_eq!(parsed.session_dir, value("b"));
        assert_eq!(args(&["-m", "x", "--", "--model", "q"]), Args::default());
        let parsed = args(&["--headless", "false", "--continue", "--mode", "rpc"]);
        assert_eq!(parsed.headless, Some(Arg::Flag));
        assert!(headless(&parsed.headless));
        let parsed = args(&["--tools", "", "--name", "-x"]);
        assert_eq!(parsed.tools, value(""));
        assert_eq!(parsed.name, value("-x"));
        assert_eq!(args(&["--session-dir="]).session_dir, value(""));
        assert!(!headless(&args(&["--headless="]).headless));
        assert!(!headless(&args(&["--no-headless"]).headless));
    }

    #[test]
    fn reads_the_configure_message() {
        let configure = parse_configure(&json!({ "type": "configure",
            "capabilities": { "web_search": false }, "instructions": "Be brief",
            "role": { "name": "reviewer", "instructions": 3, "models": ["a/*", 1, "b/c"] } }))
        .unwrap();
        assert!(configure.models.providers.is_empty());
        assert!(!configure.capabilities.allows("web_search"));
        assert_eq!(configure.instructions.as_deref(), Some("Be brief"));
        assert_eq!(
            configure.role,
            Some(AgentRole {
                name: "reviewer".to_owned(),
                instructions: None,
                models: Some(vec!["a/*".to_owned(), "b/c".to_owned()]),
            })
        );
        let configure =
            parse_configure(&json!({ "type": "configure", "models": null, "role": { "name": 1 } }))
                .unwrap();
        assert!(configure.role.is_none());
        for message in [json!(null), json!({ "type": "prompt" }), json!([1])] {
            assert_eq!(
                parse_configure(&message).err().as_deref(),
                Some("The first stdin line must be {\"type\":\"configure\",\"models\":…}")
            );
        }
        let invalid = json!({ "type": "configure", "models": { "providers": { "p": {
            "api": "openai-completions", "baseUrl": "https://x", "models": [] } } } });
        assert_eq!(
            parse_configure(&invalid).err().as_deref(),
            Some("providers.p.models: Array must contain at least 1 element(s)")
        );
    }

    #[tokio::test]
    async fn configure_errors() {
        let (sender, mut lines) = mpsc::unbounded_channel();
        for line in ["", "  ", "{not json"] {
            sender.send(line.to_owned()).unwrap();
        }
        assert_eq!(
            read_configure(&mut lines).await.err().as_deref(),
            Some("The first stdin line must be a JSON configure message")
        );
        drop(sender);
        assert_eq!(
            read_configure(&mut lines).await.err().as_deref(),
            Some("stdin closed before the configure message")
        );
    }
}
