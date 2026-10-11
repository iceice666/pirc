//! User hooks (`agent/hooks.ts`): shell commands with a JSON payload on
//! stdin, answering through their exit code and stdout.

use std::rc::Rc;

use serde_json::{Map, Value};

use crate::config::HooksConfig;

/// `HookName`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HookName {
    SessionStart,
    BeforePrompt,
    BeforeTool,
    AfterTool,
    AgentSettled,
}

/// `HookResult` with its command.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HookResult {
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    pub command: String,
}

/// `HookRunner`.
pub struct HookRunner {
    hooks: HooksConfig,
}

impl HookRunner {
    /// `base`: fields every payload carries (`sessionId`, `cwd`); `warn`
    /// reports failures to the user.
    pub fn new(
        hooks: HooksConfig,
        cwd: String,
        env: Vec<(String, String)>,
        base: Map<String, Value>,
        warn: Rc<dyn Fn(&str)>,
    ) -> Self {
        let _ = (cwd, env, base, warn);
        let _ = hooks;
        todo!("M4 tools: HookRunner::new")
    }

    pub fn has(&self, name: HookName) -> bool {
        let _ = (name, &self.hooks);
        todo!("M4 tools: HookRunner::has")
    }

    /// `run`: every matching hook in order; failures warn, never fail.
    pub async fn run(
        &self,
        name: HookName,
        data: Map<String, Value>,
        subject: Option<&str>,
    ) -> Vec<HookResult> {
        let _ = (name, data, subject);
        todo!("M4 tools: HookRunner::run")
    }

    /// `collect`: stdout of successful hooks, joined by blank lines.
    pub async fn collect(&self, name: HookName, data: Map<String, Value>) -> String {
        let _ = (name, data);
        todo!("M4 tools: HookRunner::collect")
    }

    /// `beforeTool`: `Err(reason)` blocks the call; `Ok(args)` are the
    /// (possibly rewritten) arguments.
    pub async fn before_tool(
        &self,
        tool: &str,
        args: Map<String, Value>,
    ) -> Result<Map<String, Value>, String> {
        let _ = (tool, args);
        todo!("M4 tools: HookRunner::before_tool")
    }
}
