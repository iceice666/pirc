//! `sandbox` (`agent/features/sandbox.ts`, docs/deploy/sandbox-and-browser.md): tools
//! for an agent inside its node's OS sandbox. `sandbox_allow_domains` asks
//! for more network access, `unsandboxed_bash` runs one command outside the
//! sandbox. The node asks the human for both; nothing here can grant
//! anything by itself.

use std::rc::Rc;

use pirc_policy::truncate_output;
use serde_json::{Map, Value, json};

use crate::LocalBoxFuture;
use crate::agent::Agent;
use crate::channels::{ChannelError, process_sandbox_requester};
use crate::feature::{BeforeStart, Feature, PromptAddition};
use crate::tools::bash::shell_result_schema;
use crate::tools::result_schema::{arr, bool_, fields, str_};
use crate::tools::{Tool, ToolContext, ToolResult, ToolSpec, js, spec_tool, typed};

/// The tools that run shell commands, as far as this agent has them (chats
/// leave some out).
const SHELL_TOOLS: [&str; 2] = ["bash", "background_task"];

/// `sandboxFeature()`.
pub fn feature() -> Rc<dyn Feature> {
    Rc::new(SandboxFeature)
}

/// `sandboxPrompt(shells)`.
fn sandbox_prompt(shells: &[&str]) -> String {
    let shells = if shells.is_empty() {
        String::new()
    } else {
        format!(" ({})", shells.join(", "))
    };
    format!(
        "## Sandbox

Your shell commands{shells} run in an OS sandbox on this node:
- Reads work anywhere except credential stores (~/.ssh, cloud and git credentials, keychains, browser profiles) and pirc's own state.
- Writes work only in the workspace, temporary directories and build caches. Git hooks and .git/config are read-only.
- Network reaches only allowlisted hosts (common code hosts and package registries). A blocked host fails with \"CONNECT tunnel failed, response 403\" or a proxy error.

When the sandbox blocks something the task needs:
- A host: call `sandbox_allow_domains` with the host and why. The user approves it for this session.
- Anything else (a nix build, git over SSH, changing the system): call `unsandboxed_bash`, which runs one command outside the sandbox after the user approves it. Use it only for what the sandbox blocks, never to get around a refusal."
    )
}

/// `active`: inside the node's sandbox, with a way to it (the node, or a
/// team child's parent).
fn active(agent: &Agent) -> bool {
    agent.config().sandboxed && process_sandbox_requester().is_some()
}

struct SandboxFeature;

impl Feature for SandboxFeature {
    fn name(&self) -> &'static str {
        "sandbox"
    }

    fn tools(&self, agent: &Rc<Agent>) -> Vec<Rc<dyn Tool>> {
        if !active(agent) {
            return Vec::new();
        }
        vec![
            Rc::new(AllowDomainsTool::new()),
            Rc::new(UnsandboxedBashTool::new()),
        ]
    }

    fn before_agent_start<'a>(
        &'a self,
        agent: &'a Rc<Agent>,
    ) -> LocalBoxFuture<'a, Result<Option<BeforeStart>, String>> {
        Box::pin(async move {
            if !active(agent) {
                return Ok(None);
            }
            let names: Vec<String> = agent
                .available_tools()
                .iter()
                .map(|tool| tool.name().to_owned())
                .collect();
            let shells: Vec<&str> = SHELL_TOOLS
                .into_iter()
                .filter(|name| names.iter().any(|have| have == name))
                .collect();
            Ok(Some(BeforeStart {
                system_prompt: Some(PromptAddition::Text(sandbox_prompt(&shells))),
                messages: Vec::new(),
            }))
        })
    }
}

/// `unavailable()`.
fn unavailable() -> String {
    "This agent is not running inside a node sandbox".to_owned()
}

/// `{key: args[key]}` unless absent.
fn copy(out: &mut Map<String, Value>, args: &Map<String, Value>, key: &str) {
    if let Some(value) = args.get(key) {
        out.insert(key.to_owned(), value.clone());
    }
}

/// A list of strings from the node's answer (`[]` otherwise).
fn strings(value: &Value) -> Vec<Value> {
    value.as_array().cloned().unwrap_or_default()
}

fn joined(items: &[Value]) -> String {
    items
        .iter()
        .map(|item| match item {
            Value::Null => String::new(),
            other => js::string_of(other),
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// `sandbox_allow_domains`.
struct AllowDomainsTool {
    spec: ToolSpec,
}

impl AllowDomainsTool {
    fn new() -> Self {
        Self {
            spec: ToolSpec::new(
                "sandbox_allow_domains",
                json!({
                    "type": "object",
                    "properties": {
                        "domains": {
                            "type": "array",
                            "items": { "type": "string" },
                            "description": "Hosts, e.g. [\"api.example.com\", \"*.example.org\"]; add \":port\" to limit a port",
                        },
                        "reason": { "type": "string",
                            "description": "Why the task needs them, shown to the user" },
                    },
                    "required": ["domains", "reason"],
                    "additionalProperties": false,
                }),
                // Nothing allowed fails the operation; a ptc script gets
                // ApprovalDenied, carrying these fields as `data`.
                Some(fields(
                    vec![
                        (
                            "granted",
                            arr(str_(None), Some("Hosts this session may now reach")),
                        ),
                        ("denied", arr(str_(None), None)),
                        (
                            "unrestricted",
                            bool_(Some("This agent is not sandboxed at all")),
                        ),
                    ],
                    &[],
                )),
            ),
        }
    }

    async fn run(&self, args: Map<String, Value>, ctx: ToolContext) -> Result<ToolResult, String> {
        let requester = process_sandbox_requester().ok_or_else(unavailable)?;
        let mut request = Map::new();
        copy(&mut request, &args, "domains");
        copy(&mut request, &args, "reason");
        // The node asks the human; a ptc script's budget pauses meanwhile.
        let wait = (ctx.human_wait)();
        let result = requester
            .request(
                "network",
                request,
                Some(&ctx.signal),
                Some(&ctx.tool_call_id),
            )
            .await;
        drop(wait);
        let result = result.map_err(|error| error.message().to_owned())?;
        if js::truthy(result.get("unrestricted")) {
            return Ok(typed(
                "This agent is not sandboxed; its network is not restricted.",
                json!({ "granted": [], "denied": [], "unrestricted": true }),
                None,
                false,
            ));
        }
        let granted = match result.get("granted") {
            None | Some(Value::Null) => Vec::new(),
            Some(value) => strings(value),
        };
        let denied = match result.get("denied") {
            None | Some(Value::Null) if granted.is_empty() => {
                args.get("domains").map(strings).unwrap_or_default()
            }
            None | Some(Value::Null) => Vec::new(),
            Some(value) => strings(value),
        };
        let data = json!({ "granted": granted, "denied": denied, "unrestricted": false });
        if granted.is_empty() {
            return Ok(typed(
                format!(
                    "The user did not allow {}. Do not try to reach them another way.",
                    joined(&denied)
                ),
                data,
                Some(result),
                true,
            ));
        }
        Ok(typed(
            format!("Allowed for this session: {}.", joined(&granted)),
            data,
            Some(result),
            false,
        ))
    }
}

spec_tool!(AllowDomainsTool, ptc: false);

/// `unsandboxed_bash`.
struct UnsandboxedBashTool {
    spec: ToolSpec,
}

impl UnsandboxedBashTool {
    fn new() -> Self {
        Self {
            spec: ToolSpec::new(
                "unsandboxed_bash",
                json!({
                    "type": "object",
                    "properties": {
                        "command": { "type": "string" },
                        "reason": {
                            "type": "string",
                            "description": "What the sandbox blocks and why the task needs it, shown to the user",
                        },
                        "cwd": {
                            "type": "string",
                            "description": "Directory inside the workspace (default: its root)",
                        },
                        "timeout": { "type": "number",
                            "description": "Timeout in seconds (default 120)" },
                    },
                    "required": ["command", "reason"],
                    "additionalProperties": false,
                }),
                Some(shell_result_schema()),
            ),
        }
    }

    async fn run(&self, args: Map<String, Value>, ctx: ToolContext) -> Result<ToolResult, String> {
        let requester = process_sandbox_requester().ok_or_else(unavailable)?;
        // It may write anywhere; hold the workspace's write lease like bash does.
        (ctx.acquire_write)(ctx.cwd.clone()).await?;
        let mut request = Map::new();
        copy(&mut request, &args, "command");
        copy(&mut request, &args, "reason");
        if let Some(Value::String(cwd)) = args.get("cwd") {
            request.insert("cwd".to_owned(), json!(cwd));
        }
        if let Some(timeout) = args.get("timeout").and_then(Value::as_f64) {
            let ms = timeout * 1000.0;
            let ms = if ms.fract() == 0.0 && ms.abs() < 9e15 {
                json!(ms as i64)
            } else {
                json!(ms)
            };
            request.insert("timeoutMs".to_owned(), ms);
        }
        // The whole request counts as waiting for the human: the node asks
        // first, and the command it then runs is bounded by its own timeout.
        let wait = (ctx.human_wait)();
        let result = requester
            .request("exec", request, Some(&ctx.signal), Some(&ctx.tool_call_id))
            .await;
        drop(wait);
        let result = match result {
            Ok(result) => result,
            Err(ChannelError::Coded { code, .. }) if code == "denied" => {
                return Ok(ToolResult {
                    details: Some(json!({ "denied": true })),
                    ..ToolResult::error(
                        "The user did not approve running this outside the sandbox. Do not try to get around it; ask them how to proceed.",
                    )
                });
            }
            Err(error) => return Err(error.message().to_owned()),
        };
        let raw = match result.get("output") {
            None | Some(Value::Null) => String::new(),
            Some(value) => js::string_of(value),
        };
        let max = usize::try_from(ctx.config.limits.tool_output_bytes).unwrap_or(usize::MAX);
        let (output, cut) = truncate_output(&raw, max);
        let exit_code = result.get("exitCode");
        let status = if js::truthy(result.get("timedOut")) {
            "[timed out]".to_owned()
        } else if js::truthy(result.get("aborted")) {
            "[aborted]".to_owned()
        } else {
            format!(
                "[exit {}]",
                exit_code.map_or_else(|| "undefined".to_owned(), js::string_of)
            )
        };
        let newline = if output.ends_with('\n') || output.is_empty() {
            ""
        } else {
            "\n"
        };
        let body = format!("{output}{newline}{status} (outside the sandbox)");
        let truncated = cut || result.get("truncated") == Some(&Value::Bool(true));
        let mut details = Map::new();
        if let Some(code) = exit_code {
            details.insert("exitCode".to_owned(), code.clone());
        }
        details.insert("truncated".to_owned(), json!(truncated));
        let is_error = !exit_code.is_some_and(|code| code.as_f64() == Some(0.0));
        Ok(typed(
            body,
            json!({
                "output": output,
                "exitCode": exit_code.filter(|code| code.is_number()).cloned().unwrap_or(Value::Null),
                "timedOut": result.get("timedOut") == Some(&Value::Bool(true)),
                "aborted": result.get("aborted") == Some(&Value::Bool(true)),
                "truncated": truncated,
            }),
            Some(Value::Object(details)),
            is_error,
        ))
    }
}

spec_tool!(UnsandboxedBashTool, ptc: false);

#[cfg(test)]
pub(crate) fn registered_tool_names() -> Vec<String> {
    vec![
        AllowDomainsTool::new().name().to_owned(),
        UnsandboxedBashTool::new().name().to_owned(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_the_shell_tools_it_has() {
        assert!(
            sandbox_prompt(&["bash"]).contains("Your shell commands (bash) run in an OS sandbox")
        );
        assert!(
            sandbox_prompt(&["bash", "background_task"])
                .contains("Your shell commands (bash, background_task) run in an OS sandbox")
        );
        assert!(sandbox_prompt(&[]).contains("Your shell commands run in an OS sandbox"));
    }
}
