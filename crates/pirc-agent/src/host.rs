//! What the agent's parts need of the agent itself, so they can be built
//! apart from it: auto mode takes the write lease and asks the human, the
//! PTC surface lists the session's capabilities.

use std::rc::{Rc, Weak};

use pirc_policy::PathGuard;

use pirc_protocol::{Message, Models};

use crate::LocalBoxFuture;
use crate::agent::{Agent, ResolvedModel};
use crate::auto_mode::{ApprovalMode, default_approval_mode};
use crate::config::AgentConfig;
use crate::session_store::SessionEntry;
use crate::signal::AbortSignal;
use crate::stream::StreamFn;
use crate::tools::Tool;
use crate::ui::Ui;

pub trait AgentHost {
    fn config(&self) -> Rc<AgentConfig>;
    fn guard(&self) -> Rc<PathGuard>;
    fn ui(&self) -> Rc<dyn Ui>;
    fn has_ui(&self) -> bool;
    fn session_id(&self) -> String;
    /// `acquireWrite(file, signal)`: the lease for the root containing it.
    fn acquire_write<'a>(
        &'a self,
        file: &'a str,
        signal: &'a AbortSignal,
    ) -> LocalBoxFuture<'a, Result<(), String>>;
    /// Available internal capabilities (`toolList`).
    fn tool_list(&self) -> Vec<Rc<dyn Tool>>;
    /// Core capabilities the model may also call directly (`directToolList`).
    fn direct_tool_list(&self) -> Vec<Rc<dyn Tool>>;
    /// `resolveModel(ref)`: `None` is the session model. (The defaults
    /// here and below are a host without models or a session, which auto
    /// mode's classifier treats as no model available.)
    fn resolve_model(&self, _reference: Option<(String, String)>) -> Result<ResolvedModel, String> {
        Err("No model configured. Add providers to the gateway models.json".to_owned())
    }
    /// `streamFunction(provider)`: the gateway's inference.
    fn stream_function(&self) -> Option<Rc<dyn StreamFn>> {
        None
    }
    /// `store.contextEntries()`: what the model sees, with entry ids.
    fn context_entries(&self) -> Vec<(String, Message)> {
        Vec::new()
    }
    /// `store.branch()`.
    fn branch(&self) -> Vec<SessionEntry> {
        Vec::new()
    }
    /// The session's approval mode: its own choice, else the node's default.
    fn approval_mode(&self) -> ApprovalMode {
        default_approval_mode(&self.config().features)
    }
    /// Entries (ids from [`AgentHost::context_entries`]) the classifier may
    /// read as the user's requests although they are not user messages: a
    /// delegated task the user approved as their own request, during the
    /// run it started.
    fn run_user_requests(&self) -> Vec<String> {
        Vec::new()
    }
    /// The user's own words a delegated task carried, verified in their
    /// chat (never the task text), during the run it started.
    fn run_user_quotes(&self) -> Vec<String> {
        Vec::new()
    }
}

/// Builds a worker's model-facing wrappers (`ptc`, `ptc_docs`).
pub type ModelTools = fn(Weak<dyn AgentHost>, Weak<Agent>) -> Vec<Rc<dyn Tool>>;

/// Who runs the agent (plans/rewrite/02-brain-host.md).
#[derive(Clone, Copy)]
pub enum HostProfile {
    /// A session on a node: the model reaches capabilities through `ptc`
    /// scripts and the direct core capabilities, in a working directory.
    Worker { model_tools: ModelTools },
    /// The gateway's brain: no scripts (it has no sandbox for a guest), every
    /// tool is a direct tool, and there is no working directory. Its PTC
    /// surface is never referenced, so the gateway does not link it.
    Brain,
}

impl HostProfile {
    /// A node's session, with the PTC wrappers.
    pub fn worker() -> Self {
        Self::Worker {
            model_tools: crate::ptc::model_tools,
        }
    }
}

/// The public model catalog of a host that has it at hand (the gateway);
/// without one the agent asks its node (`refreshModels`).
pub trait ModelCatalog {
    /// `None` keeps what the agent has.
    fn models(&self) -> Option<Models>;
}
