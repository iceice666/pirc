//! The agent (`agent/agent.ts`): queues, the run loop, model calls with
//! retries, tool execution through the policy chain, and the API the RPC
//! layer drives.
//!
//! M4 layout: the API the other modules call; the parent ports the loop.

use std::rc::Rc;

use pirc_protocol::{Message, UserBlock};
use serde_json::Value;

use crate::capabilities::Capabilities;
use crate::config::AgentConfig;
use crate::roles::AgentRole;
use crate::rpc::Write;
use crate::session_store::SessionStore;
use crate::stream::StreamFn;
use crate::tools::{AcquireWrite, Tool};
use crate::ui::Ui;

/// `AgentOptions`.
pub struct AgentOptions {
    pub config: AgentConfig,
    pub capabilities: Capabilities,
    /// A chat project's instructions from the node.
    pub project_instructions: Option<String>,
    /// A role from the configure line.
    pub role: Option<AgentRole>,
    pub store: SessionStore,
    /// Events and side-channel requests (stdout).
    pub emit: Write,
    pub ui: Rc<dyn Ui>,
    pub has_ui: bool,
    pub tools: Vec<Rc<dyn Tool>>,
    /// The write-lease transport (`processWriteLease`); `None` grants all.
    pub acquire_write: Option<AcquireWrite>,
    /// Only these capabilities (a restricted kind).
    pub allowed_tools: Option<Vec<String>>,
    /// Test seam: the model.
    pub stream_override: Option<Rc<dyn StreamFn>>,
}

/// Which queue `send_now` takes from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Queue {
    Steering,
    FollowUp,
}

/// Who named the session.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NameSource {
    User,
    Auto,
}

/// A message from outside the conversation (`deliver`).
#[derive(Clone, Debug, PartialEq)]
pub struct Delivery {
    pub custom_type: String,
    pub content: String,
    pub display: bool,
    pub details: Option<Value>,
}

/// `Agent`.
pub struct Agent {
    _private: (),
}

impl Agent {
    pub fn new(options: AgentOptions) -> Rc<Self> {
        let _ = options;
        todo!("M4 loop: Agent::new")
    }

    /// Notify the user (`ui.notify`), e.g. the config's warnings.
    pub fn notify_warning(&self, message: &str) {
        let _ = message;
        todo!("M4 loop: notify_warning")
    }

    /// `refreshModels`: the node's current public catalog.
    pub async fn refresh_models(&self) {
        todo!("M4 loop: refreshModels")
    }

    /// `init`: the `sessionStart` hooks.
    pub async fn init(self: &Rc<Self>) {
        todo!("M4 loop: init")
    }

    pub fn is_running(&self) -> bool {
        todo!("M4 loop: isRunning")
    }

    pub fn session_name(&self) -> Option<String> {
        todo!("M4 loop: sessionName")
    }

    pub fn set_model(&self, provider: &str, id: &str) -> Result<(), String> {
        let _ = (provider, id);
        todo!("M4 loop: setModel")
    }

    pub fn set_thinking(&self, level: &str) -> Result<(), String> {
        let _ = level;
        todo!("M4 loop: setThinking")
    }

    pub fn set_name(&self, name: &str, source: NameSource) {
        let _ = (name, source);
        todo!("M4 loop: setName")
    }

    pub fn set_role(&self, name: &str) -> Result<(), String> {
        let _ = name;
        todo!("M4 loop: setRole")
    }

    /// `prompt`: start a run; `Err` while one is active.
    pub fn prompt(self: &Rc<Self>, text: String, images: Vec<UserBlock>) -> Result<(), String> {
        let _ = (text, images);
        todo!("M4 loop: prompt")
    }

    pub fn steer(self: &Rc<Self>, text: String, images: Vec<UserBlock>) {
        let _ = (text, images);
        todo!("M4 loop: steer")
    }

    pub fn follow_up(self: &Rc<Self>, text: String, images: Vec<UserBlock>) {
        let _ = (text, images);
        todo!("M4 loop: followUp")
    }

    pub fn send_now(self: &Rc<Self>, queue: Queue, index: usize, text: &str) -> Result<(), String> {
        let _ = (queue, index, text);
        todo!("M4 loop: sendNow")
    }

    /// `clearQueue`: `{steering, followUp}` texts.
    pub fn clear_queue(&self) -> Value {
        todo!("M4 loop: clearQueue")
    }

    pub fn deliver(self: &Rc<Self>, delivery: Delivery, trigger_turn: bool, follow_up: bool) {
        let _ = (delivery, trigger_turn, follow_up);
        todo!("M4 loop: deliver")
    }

    pub fn abort(&self) {
        todo!("M4 loop: abort")
    }

    /// Resolves once no run is active.
    pub async fn idle(&self) {
        todo!("M4 loop: idle")
    }

    /// `state()` (`get_state`).
    pub fn state(&self) -> Value {
        todo!("M4 loop: state")
    }

    pub fn all_messages(&self) -> Vec<Message> {
        todo!("M4 loop: allMessages")
    }

    pub fn available_models(&self) -> Vec<Value> {
        todo!("M4 loop: availableModels")
    }

    pub fn command_list(&self) -> Vec<Value> {
        todo!("M4 loop: commandList")
    }

    /// The latest context snapshot (`lastContext`).
    pub fn last_context(&self) -> Option<Value> {
        todo!("M4 loop: lastContext")
    }

    pub fn panel_state(&self) -> Value {
        todo!("M4 loop: panelState")
    }

    /// Manual compaction (`compact`), only while idle.
    pub async fn compact(self: &Rc<Self>, instructions: Option<String>) -> Result<Value, String> {
        let _ = instructions;
        todo!("M4 loop: compact")
    }

    pub async fn shutdown(&self) {
        todo!("M4 loop: shutdown")
    }
}
