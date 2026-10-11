//! Child side of the team broker (`features/team/channel.ts`): a reverse
//! RPC over this process's own stdio. Calls go out on stdout as
//! `team_call`; the parent answers on stdin with `team_result` (routed
//! here by `serve_rpc`).

use std::cell::RefCell;
use std::rc::Rc;

use serde_json::{Value, json};

use crate::channels::{ChannelError, PendingRequest, PendingRequests, RequestOptions};
use crate::rpc::Write;
use crate::signal::AbortSignal;

/// `ParentChannel`.
pub struct ParentChannel {
    pending: PendingRequests<Value>,
    write: Write,
}

impl ParentChannel {
    pub fn new(write: Write) -> Self {
        Self {
            pending: PendingRequests::new(),
            write,
        }
    }

    /// `call(operation, args, signal)`: the parent's result, or its error
    /// text. An abort tells the parent with `team_cancel`.
    pub fn call(
        &self,
        operation: &str,
        args: Value,
        signal: Option<&AbortSignal>,
    ) -> PendingRequest<Value> {
        let write = self.write.clone();
        let options = RequestOptions {
            abort_error: || ChannelError::Plain("Aborted".to_owned()),
            cancel: Some(Rc::new(move |id: &str| {
                write(json!({ "type": "team_cancel", "id": id }));
            })),
            timeout: None,
        };
        self.pending.request(signal, options, |id| {
            (self.write)(
                json!({ "type": "team_call", "id": id, "operation": operation,
                "args": args }),
            );
        })
    }

    /// `receive`: a `team_result` line; unknown ids are ignored.
    pub fn receive(&self, message: &Value) {
        let Some(id) = message
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| self.pending.contains(id))
        else {
            return;
        };
        match message.get("error") {
            Some(Value::String(error)) => {
                self.pending.reject(id, ChannelError::Plain(error.clone()));
            }
            _ => {
                let result = message.get("result").cloned().unwrap_or(Value::Null);
                self.pending.resolve(id, result);
            }
        }
    }

    /// `closeAll`.
    pub fn close_all(&self) {
        self.pending
            .close_all(|| ChannelError::Plain("Team channel closed".to_owned()));
    }
}

thread_local! {
    static CHANNEL: RefCell<Option<Rc<ParentChannel>>> = const { RefCell::new(None) };
}

/// `parentChannel()`: this process's channel to its parent, on stdout.
pub fn parent_channel() -> Rc<ParentChannel> {
    CHANNEL.with(|cell| {
        cell.borrow_mut()
            .get_or_insert_with(|| Rc::new(ParentChannel::new(crate::rpc::stdout_write())))
            .clone()
    })
}

/// How a team child runs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChildMode {
    /// A persistent member that messages peers and the parent.
    Team,
    /// A one-shot worker without team tools.
    Subagent,
}

impl ChildMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Team => "team",
            Self::Subagent => "subagent",
        }
    }
}

/// `teamChildMode()` (`PIRC_TEAM_MODE`), for a team child only.
pub fn team_child_mode(env: &dyn Fn(&str) -> Option<String>) -> Option<ChildMode> {
    crate::channels::team_child_name(env)?;
    Some(if env("PIRC_TEAM_MODE").as_deref() == Some("subagent") {
        ChildMode::Subagent
    } else {
        ChildMode::Team
    })
}

/// `teamChildName()` of this process.
pub fn process_child_name() -> Option<String> {
    crate::channels::team_child_name(&|name| std::env::var(name).ok())
}

/// `teamChildMode()` of this process.
pub fn process_child_mode() -> Option<ChildMode> {
    team_child_mode(&|name| std::env::var(name).ok())
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;
    use crate::signal::AbortController;

    fn recorder() -> (Write, Rc<RefCell<Vec<Value>>>) {
        let frames = Rc::new(RefCell::new(Vec::new()));
        let sink = frames.clone();
        (Rc::new(move |value| sink.borrow_mut().push(value)), frames)
    }

    #[tokio::test]
    async fn calls_the_parent_and_takes_its_answers() {
        let (write, frames) = recorder();
        let channel = ParentChannel::new(write);
        let first = channel.call("write_lease", json!({ "path": "/w" }), None);
        let second = channel.call("agent_list", json!({}), None);
        let ids: Vec<Value> = frames.borrow().iter().map(|f| f["id"].clone()).collect();
        assert_eq!(
            frames.borrow()[0],
            json!({ "type": "team_call", "id": ids[0], "operation": "write_lease",
                "args": { "path": "/w" } })
        );
        channel.receive(&json!({ "id": "other", "result": 1 }));
        channel.receive(&json!({ "id": ids[1], "error": "nope" }));
        channel.receive(&json!({ "id": ids[0], "result": { "granted": true } }));
        assert_eq!(first.await, Ok(json!({ "granted": true })));
        assert_eq!(second.await, Err(ChannelError::Plain("nope".to_owned())));
        // A non-string error is no error.
        let third = channel.call("x", json!({}), None);
        let id = frames.borrow()[2]["id"].clone();
        channel.receive(&json!({ "id": id, "error": 3 }));
        assert_eq!(third.await, Ok(Value::Null));
    }

    #[tokio::test]
    async fn aborts_cancel_and_closing_rejects() {
        let (write, frames) = recorder();
        let channel = ParentChannel::new(write);
        let controller = AbortController::new();
        let call = channel.call("agent_wait", json!({}), Some(&controller.signal()));
        controller.abort();
        assert_eq!(call.await, Err(ChannelError::Plain("Aborted".to_owned())));
        let id = frames.borrow()[0]["id"].clone();
        assert_eq!(
            frames.borrow()[1],
            json!({ "type": "team_cancel", "id": id })
        );
        let call = channel.call("agent_wait", json!({}), None);
        channel.close_all();
        assert_eq!(
            call.await,
            Err(ChannelError::Plain("Team channel closed".to_owned()))
        );
    }

    #[test]
    fn reads_the_child_mode() {
        let env = |vars: &'static [(&'static str, &'static str)]| {
            move |name: &str| {
                vars.iter()
                    .find(|(key, _)| *key == name)
                    .map(|(_, value)| (*value).to_owned())
            }
        };
        assert_eq!(team_child_mode(&env(&[])), None);
        assert_eq!(
            team_child_mode(&env(&[("PIRC_TEAM_MODE", "subagent")])),
            None
        );
        assert_eq!(
            team_child_mode(&env(&[("PIRC_TEAM_AGENT", "w")])),
            Some(ChildMode::Team)
        );
        assert_eq!(
            team_child_mode(&env(&[
                ("PIRC_TEAM_AGENT", "w"),
                ("PIRC_TEAM_MODE", "subagent")
            ])),
            Some(ChildMode::Subagent)
        );
    }
}
