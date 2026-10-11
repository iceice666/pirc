//! What the agent's parts need of the agent itself, so they can be built
//! apart from it: auto mode takes the write lease and asks the human, the
//! PTC surface lists the session's capabilities.

use std::rc::Rc;

use pirc_policy::PathGuard;

use crate::LocalBoxFuture;
use crate::config::AgentConfig;
use crate::signal::AbortSignal;
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
}
