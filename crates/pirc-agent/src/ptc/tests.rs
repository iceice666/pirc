//! The PTC surface (`agent-ptc.test.ts`: the tool surface, the index and
//! `ptc_docs`; scripts are M5's).

use std::rc::{Rc, Weak};

use serde_json::{Value, json};

use super::*;
use crate::tools::builtin_tools;
use crate::tools::testing::{self, TestHost, args, text_of};

fn host(tools: Vec<Rc<dyn Tool>>) -> (Rc<TestHost>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let config = testing::config(&dir.path().display().to_string(), json!({}));
    (Rc::new(TestHost::new(config, tools, false)), dir)
}

fn docs_tool(host: &Rc<TestHost>) -> Rc<dyn Tool> {
    let weak: Weak<dyn AgentHost> = Rc::downgrade(&(host.clone() as Rc<dyn AgentHost>));
    model_tools(weak).remove(1)
}

async fn docs(tool: &Rc<dyn Tool>, request: Value) -> (Value, bool) {
    let config = testing::config(&std::env::temp_dir().display().to_string(), json!({}));
    let ctx = testing::context(config, crate::signal::AbortSignal::never()).ctx;
    let result = tool.execute(args(request), ctx).await.unwrap();
    (
        serde_json::from_str(&text_of(&result)).unwrap(),
        result.is_error,
    )
}

#[test]
fn indexes_the_capabilities_as_the_ts_agent_did() {
    let (host, _dir) = host(builtin_tools());
    let expected = include_str!("testdata/capability_index.txt");
    assert_eq!(
        capability_index_prompt(host.as_ref()).unwrap(),
        crate::tools::js::trim_end(expected)
    );
    let (empty, _dir) = self::host(Vec::new());
    assert_eq!(capability_index_prompt(empty.as_ref()), None);
}

#[test]
fn offers_the_tools_the_ts_agent_offered() {
    // Recorded from the TS agent (crates/pirc-conformance agent_tool_round).
    let recorded: Vec<Value> =
        serde_json::from_str(include_str!("testdata/model_tools.json")).unwrap();
    let (host, _dir) = host(builtin_tools());
    let mut tools: Vec<Rc<dyn Tool>> = model_tools(Weak::<TestHost>::new());
    tools.extend(host.direct_tool_list());
    let ours: Vec<Value> = tools
        .iter()
        .map(|tool| {
            json!({
                "name": tool.name(),
                "description": tool.description(),
                "parameters": tool.parameters(),
            })
        })
        .collect();
    assert_eq!(ours, recorded);
}

#[test]
fn routes_everything_through_ptc_without_direct_tools() {
    let (host, _dir) = host(builtin_tools());
    let bare = TestHost {
        direct: Vec::new(),
        ..TestHost::new((*host.config()).clone(), builtin_tools(), false)
    };
    let prompt = capability_index_prompt(&bare).unwrap();
    assert!(prompt.contains(
        "Everything you do goes through `ptc` scripts calling these capabilities (`tools.<name>(args)`)."
    ));
}

/// A capability with a long description, for the budget.
struct Named {
    name: &'static str,
    description: String,
    parameters: serde_json::Map<String, Value>,
}

impl Tool for Named {
    fn name(&self) -> &str {
        self.name
    }
    fn description(&self) -> &str {
        &self.description
    }
    fn parameters(&self) -> &serde_json::Map<String, Value> {
        &self.parameters
    }
    fn execute<'a>(
        &'a self,
        _args: serde_json::Map<String, Value>,
        _ctx: crate::tools::ToolContext,
    ) -> crate::LocalBoxFuture<'a, Result<crate::tools::ToolResult, String>> {
        Box::pin(async { Ok(crate::tools::ToolResult::text("ok")) })
    }
}

fn named(name: &'static str, description: &str) -> Rc<dyn Tool> {
    Rc::new(Named {
        name,
        description: description.to_owned(),
        parameters: args(json!({
            "type": "object",
            "properties": { "action": { "type": "string" } },
            "required": ["action"],
        })),
    })
}

#[test]
fn lists_other_capabilities_shortest_first_and_names_what_does_not_fit() {
    let mut tools = builtin_tools();
    tools.push(named("todo", "Track tasks. More text."));
    tools.push(named("agent_list", "List team members."));
    // Each of these is over 1,000 characters: only some fit the budget.
    let long = format!("{}.", "word ".repeat(400));
    for name in [
        "agent_send",
        "agent_stop",
        "board_post",
        "board_read",
        "task_get",
        "task_list",
        "task_create",
        "task_update",
        "agent_inbox",
        "agent_reply",
        "agent_wait",
    ] {
        tools.push(Rc::new(Named {
            name,
            description: "x".to_owned(),
            parameters: args(json!({
                "type": "object",
                "properties": { long.trim(): { "type": "string" } },
            })),
        }));
    }
    let (host, _dir) = host(tools);
    let prompt = capability_index_prompt(host.as_ref()).unwrap();
    assert!(prompt.contains("- planning: todo\n"));
    assert!(prompt.contains("- team: agent_inbox, agent_list,"));
    let others = prompt.split("### Other capabilities").nth(1).unwrap();
    let list = others.find("`tools.agent_list(args: { action: string })` — List team members.");
    let todo = others.find("`tools.todo(args: { action: string })` — Track tasks.");
    assert!(todo.unwrap() < list.unwrap(), "shortest first");
    let last = prompt.lines().last().unwrap();
    assert!(last.starts_with("Look up `"), "{last}");
    assert!(last.ends_with("with `ptc_docs({ names: [...] })` before first use."));
}

#[tokio::test]
async fn documents_capabilities_through_ptc_docs() {
    let (host, _dir) = host(builtin_tools());
    let tool = docs_tool(&host);
    let (index, failed) = docs(&tool, json!({})).await;
    assert!(!failed);
    assert_eq!(
        index["categories"],
        json!([
            { "category": "files", "count": 6, "names": ["edit", "find", "grep", "ls", "read", "write"] },
            { "category": "shell", "count": 1, "names": ["bash"] },
        ])
    );
    assert_eq!(index["truncated"], json!(false));
    assert_eq!(index["nextCursor"], Value::Null);
    assert_eq!(index["contractVersion"], json!(1));
    let version = index["registryVersion"].as_str().unwrap().to_owned();
    assert_eq!(version.len(), 16);

    let (edit, _) = docs(&tool, json!({ "names": ["edit", "edit"] })).await;
    let item = &edit["items"][0];
    assert_eq!(edit["items"].as_array().unwrap().len(), 1);
    assert_eq!(item["name"], "edit");
    assert_eq!(item["uiLabel"], "Edit");
    assert_eq!(item["concurrency"], "exclusive-write");
    assert_eq!(item["approval"], "operation-policy");
    assert_eq!(
        item["inputSchema"]["required"],
        json!(["path", "oldText", "newText"])
    );
    assert_eq!(
        item["resultSchema"]["required"],
        json!(["text", "path", "replacements", "diff"])
    );
    assert_eq!(
        item["examples"],
        json!([
            "const result = await tools.edit({ path: \"…\", oldText: \"…\", newText: \"…\" });"
        ])
    );
    assert_eq!(edit["truncated"], json!(false));
    assert!(edit.get("remaining").is_none());

    let (missing, failed) = docs(&tool, json!({ "names": ["nope"] })).await;
    assert!(failed);
    assert_eq!(
        missing["error"],
        json!({
            "code": "CapabilityUnavailable",
            "message": "Not available in this session: nope. ptc_docs({}) lists what is.",
            "outcome": "not_started",
        })
    );
    let (stale, failed) = docs(
        &tool,
        json!({ "names": ["edit"], "registryVersion": "old" }),
    )
    .await;
    assert!(failed);
    assert_eq!(stale["error"]["code"], "StaleContract");
    assert_eq!(
        stale["error"]["docs"],
        json!({ "names": ["edit"], "registryVersion": version })
    );
    let (same, failed) = docs(&tool, json!({ "registryVersion": version })).await;
    assert!(!failed);
    assert_eq!(same["categories"][1]["names"], json!(["bash"]));
}

#[tokio::test]
async fn pages_categories_with_signed_cursors() {
    let mut tools = builtin_tools();
    let names: Vec<&'static str> = (0..25)
        .map(|i| &*Box::leak(format!("agent_x{i:02}").into_boxed_str()))
        .collect();
    for name in &names {
        tools.push(named(name, "A team capability. Details."));
    }
    let (host, _dir) = host(tools);
    let tool = docs_tool(&host);
    let (first, _) = docs(&tool, json!({ "category": "other" })).await;
    assert_eq!(first["items"].as_array().unwrap().len(), 20);
    assert_eq!(
        first["items"][0],
        json!({
            "name": "agent_x00",
            "uiLabel": "Agent x00",
            "summary": "A team capability.",
            "effects": ["write"],
            "approval": "operation-policy",
        })
    );
    assert_eq!(first["truncated"], json!(true));
    let cursor = first["nextCursor"].as_str().unwrap().to_owned();
    let (second, _) = docs(&tool, json!({ "category": "other", "cursor": cursor })).await;
    assert_eq!(second["items"].as_array().unwrap().len(), 5);
    assert_eq!(second["items"][0]["name"], "agent_x20");
    assert_eq!(second["nextCursor"], Value::Null);

    let (forged, _) = docs(
        &tool,
        json!({ "category": "other", "cursor": format!("{cursor}x") }),
    )
    .await;
    assert_eq!(forged["error"]["message"], "Invalid cursor");
    let (other, _) = docs(&tool, json!({ "category": "files", "cursor": cursor })).await;
    assert_eq!(
        other["error"]["message"],
        "The cursor belongs to a different query"
    );
    // A cursor from another registry (another agent process) is not valid.
    let other_tool = docs_tool(&host);
    let (foreign, _) = docs(
        &other_tool,
        json!({ "category": "other", "cursor": cursor }),
    )
    .await;
    assert_eq!(foreign["error"]["message"], "Invalid cursor");
    let (none, _) = docs(&tool, json!({ "category": "web" })).await;
    assert_eq!(
        none["error"]["message"],
        "No available capabilities in category web. ptc_docs({}) lists the categories."
    );
}

#[tokio::test]
async fn refuses_malformed_requests() {
    let (host, _dir) = host(builtin_tools());
    let tool = docs_tool(&host);
    for (request, message) in [
        (json!({ "nope": 1 }), "Unknown argument: nope"),
        (
            json!({ "names": ["read"], "category": "files" }),
            "names cannot be combined with category or cursor",
        ),
        (
            json!({ "cursor": "x" }),
            "cursor needs the category it was issued for",
        ),
        (
            json!({ "registryVersion": 1 }),
            "registryVersion must be a string",
        ),
        (
            json!({ "category": "files", "cursor": 1 }),
            "cursor must be a string",
        ),
        (
            json!({ "category": "Files" }),
            "category must be a category name from the index",
        ),
        (json!({ "names": [] }), "names must be 1–8 capability names"),
        (
            json!({ "names": ["Read"] }),
            "names must be 1–8 capability names",
        ),
        (
            json!({ "names": null }),
            "names must be 1–8 capability names",
        ),
    ] {
        let (result, failed) = docs(&tool, request.clone()).await;
        assert!(failed, "{request}");
        assert_eq!(result["error"]["code"], "InvalidArguments", "{request}");
        assert_eq!(result["error"]["message"], message, "{request}");
    }
}

#[tokio::test]
async fn ptc_reports_that_scripts_come_later() {
    let tool = PtcTool::new();
    let config = testing::config(&std::env::temp_dir().display().to_string(), json!({}));
    let ctx = testing::context(config, crate::signal::AbortSignal::never()).ctx;
    let result = tool
        .execute(args(json!({ "code": "return 1;" })), ctx)
        .await
        .unwrap();
    assert!(result.is_error);
    assert_eq!(text_of(&result), PTC_UNAVAILABLE);
}

#[test]
fn summarizes_capabilities_for_the_context_panel() {
    let mut tools = builtin_tools();
    tools.push(named("ptc", "wrapper"));
    tools.push(named("Bad", "invalid name"));
    let registry = CapabilityRegistry::new("s".to_owned());
    let summaries = registry.summaries(&tools);
    let names: Vec<&str> = summaries
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        ["edit", "find", "grep", "ls", "read", "write", "bash"]
    );
    assert_eq!(
        summaries[6],
        json!({ "name": "bash", "category": "shell", "uiLabel": "Bash", "effects": ["process", "write"], "approval": "operation-policy" })
    );
}

#[test]
fn every_builtin_result_holds_to_its_contract() {
    // Every capability documents a typed result with `text` required.
    for tool in builtin_tools() {
        let schema = registry::result_schema_of(tool.as_ref());
        let branches = match schema.get("oneOf") {
            Some(Value::Array(branches)) => branches.clone(),
            _ => vec![schema.clone()],
        };
        for branch in branches {
            assert_eq!(branch["required"][0], "text", "{}", tool.name());
            assert!(branch["properties"].as_object().unwrap().len() > 2);
        }
    }
    assert!(registry::is_write_call("bash", &args(json!({}))));
    assert!(!registry::is_write_call("read", &args(json!({}))));
    assert!(!registry::is_write_call(
        "todo",
        &args(json!({ "action": "list" }))
    ));
    assert!(registry::is_write_call(
        "todo",
        &args(json!({ "action": "add" }))
    ));
    assert!(registry::is_write_call("mystery", &args(json!({}))));
}
