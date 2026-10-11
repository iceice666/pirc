//! One agent process per session (`node/runner.ts`: `PiRunner`,
//! `RunnerManager`, `runOnHost`). Owner: **runner**.
//!
//! The public API below (the manager, [`Runner`], [`CommandPayload`],
//! [`Delivery`]) is what core's routes and the panels call; the layout fixes
//! it, the bodies are the runner worker's. Everything else (process spawn,
//! stdout handling, side channels, run bookkeeping, host exec) is private to
//! this module and may be split into files under `runner/` freely.
//!
//! What to reproduce (see the scout notes and `runner.ts`):
//!
//! - Start (`ensure`): `require_session_available`; reuse a live runner; one
//!   start in flight per session; runner state `starting`;
//!   `node.sandbox.prepare(...)` (503 `runner_unavailable` when the sandbox
//!   is unavailable); spawn `prepared.command()` with the agent flags
//!   (`--mode rpc --session-dir <private path>`, `--continue` with a
//!   `pi_session_id`), `cwd = chat::session_root`, its own process group,
//!   the environment `without_secrets(node.env)` plus the node's variables
//!   (`PI_CODING_AGENT_SESSION_DIR`, `PIRC_WRITE_BROKER=1`, `PIRC_GATEWAY=1`,
//!   `PIRC_WORKSPACE_KIND`, `PIRC_PROJECT_TRUST` or `PIRC_PROJECT_INSTRUCTIONS`,
//!   `PIRC_WORKSPACE_MEMORY_DIR`, `PIRC_BROWSER=1|0` from
//!   `node.browser.enabled()`, `PIRC_SANDBOX=srt`, `PIRC_SANDBOX_POLICY`)
//!   and `prepared.env`; epoch from `increment_epoch`, older epochs'
//!   interactions stale; the `configure` line first, `runner_ready`, sandbox
//!   warnings as notifications, `set_session_name` for user names,
//!   `get_state` for the agent's session id.
//! - stdout through [`framing::JsonlParser`]; a framing error publishes
//!   `runner_error` and kills the process group; stderr chunks as
//!   `runner_stderr` (first 8192 UTF-16 units).
//! - The agent's lines in `handleValue` order: responses to pending
//!   requests, `extension_ui_request` (interactions; node dialogs never come
//!   from the agent), `write_lease_request` ([`crate::write_broker`]),
//!   `gateway_request` (`recap.collect` locally via [`crate::recap`], else
//!   [`crate::agent_gateway`]; 8 in flight), `browser_request` and
//!   `browser_cancel` ([`crate::browser`]; 4 in flight), `sandbox_request`
//!   (`network` approvals widening `prepared.approve_domains`, `exec` on the
//!   host after the human's yes; 4 in flight) and `sandbox_cancel`,
//!   `session_name_changed`, then everything else through the
//!   [`reducer`], run bookkeeping and a `pi_event`.
//! - Exit: kill the group, fail pending requests, cancel side requests,
//!   `prepared.cleanup()`, dispatched commands `outcome_unknown`, the open
//!   run `interrupted`, runner state `failed`, `runner_exit`; no restart.
//! - Every run or lease change is followed by `node.activity.notify_one()`.
//!
//! Golden cases: `rpc-framing.test.ts` (framing), `events-reducer.test.ts`
//! (reducer), and the runner parts of `app.integration.test.ts`,
//! `gateway-agent.integration.test.ts`, `sandbox.integration.test.ts`.

pub mod framing;
pub mod reducer;

use std::sync::Arc;

use serde::Deserialize;
use serde_json::{Map, Value};

use crate::error::ApiResult;
use crate::services::WeakNode;
pub use reducer::ReducedState;

/// What a client asks a session's agent to do (`CommandPayload` in
/// `types.ts`, `commandPayload` in `node/app.ts`). Core's commands route
/// parses and validates it (lengths, counts) and stores its JSON as the
/// command's payload; the runner turns it into RPC commands.
#[derive(Clone, Debug, PartialEq, Deserialize, serde::Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum CommandPayload {
    Prompt {
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        upload_ids: Option<Vec<String>>,
    },
    Steer {
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        upload_ids: Option<Vec<String>>,
    },
    FollowUp {
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        upload_ids: Option<Vec<String>>,
    },
    Stop,
    ClearQueue,
    SendNow {
        /// `steering` or `followUp`.
        queue: String,
        index: u64,
        message: String,
    },
    SetModel {
        provider: String,
        model_id: String,
    },
    SetThinking {
        /// `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`.
        level: String,
    },
}

/// What the gateway pushes into a session (`deliverBody`): a delegated
/// task, news of one, or a scheduled run. Validated by core.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Delivery {
    pub custom_type: String,
    pub content: String,
    #[serde(default)]
    pub details: Option<Map<String, Value>>,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub model: Option<DeliveryModel>,
    #[serde(default)]
    pub thinking: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeliveryModel {
    pub provider: String,
    pub id: String,
}

/// The node's agents, by session.
pub struct RunnerManager {
    node: WeakNode,
}

impl RunnerManager {
    pub fn new(node: WeakNode) -> Self {
        Self { node }
    }

    /// `runners.get(id)`: the session's runner until it exits.
    pub fn get(&self, session_id: &str) -> Option<Arc<Runner>> {
        let _ = (&self.node, session_id);
        todo!("runner")
    }

    /// `dispatch`: start the agent if needed and send the command (the
    /// command row is already `received`; this moves it through
    /// `dispatched` to `accepted`, `rejected` or `outcome_unknown`). The
    /// agent's response line. Errors that are not [`crate::error::ApiError`]s
    /// in TS are logged by the route; here every failure is an `ApiError`,
    /// and the route reads the command row for its status.
    pub async fn dispatch(
        &self,
        session_id: &str,
        command_id: &str,
        payload: &CommandPayload,
        user: &str,
    ) -> ApiResult<Map<String, Value>> {
        let _ = (session_id, command_id, payload, user);
        todo!("runner")
    }

    /// `deliver`: start the agent if needed; `set_role`, `set_model`,
    /// `set_thinking_level` (each must succeed, else 503), then `deliver`.
    pub async fn deliver(&self, session_id: &str, delivery: &Delivery) -> ApiResult<()> {
        let _ = (session_id, delivery);
        todo!("runner")
    }

    /// `answer`: 409 `stale_interaction` unless the session's live runner
    /// is in `epoch`; a node dialog is resolved locally, else
    /// `extension_ui_response` goes to the agent. The interaction is
    /// already claimed by the route.
    pub async fn answer(
        &self,
        session_id: &str,
        epoch: i64,
        rpc_id: &str,
        answer: &Map<String, Value>,
    ) -> ApiResult<()> {
        let _ = (session_id, epoch, rpc_id, answer);
        todo!("runner")
    }

    /// `stopSession` (chat deletion): wait for a start in flight, stop the
    /// runner (grace `config.shutdown_grace_ms`); 503 `runner_unavailable`
    /// "The chat process has not stopped yet; retry deletion" when it lives
    /// on; release its write leases.
    pub async fn stop_session(&self, session_id: &str) -> ApiResult<()> {
        let _ = session_id;
        todo!("runner")
    }

    /// Stop every runner, in parallel (node shutdown).
    pub async fn shutdown(&self) {
        todo!("runner")
    }
}

/// One live agent process (`PiRunner`).
pub struct Runner {
    _private: (),
}

impl Runner {
    pub fn epoch(&self) -> i64 {
        todo!("runner")
    }

    /// False once the process exited.
    pub fn alive(&self) -> bool {
        todo!("runner")
    }

    /// For snapshots: `{active: true}` (a runner exists only inside the sandbox).
    pub fn sandbox_status(&self) -> Value {
        todo!("runner")
    }

    /// The reduced live state (partial message, queue, notifications,
    /// widgets, statuses, running operations), for snapshots.
    pub fn state(&self) -> ReducedState {
        todo!("runner")
    }

    /// Send an RPC command (`{type, ...}`, without `id`) and wait for its
    /// `response` line (no timeout, as TS). 503 `runner_unavailable`
    /// "Runner is not available" when the process is gone or exits first.
    /// Used by panels for `get_panel_state`, `get_state`, `get_context`,
    /// `background_output`, `background_stop`, and by core for
    /// `set_session_name` and `get_state`.
    pub async fn request(&self, command: Map<String, Value>) -> ApiResult<Map<String, Value>> {
        let _ = command;
        todo!("runner")
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn command_payloads() {
        let parse = |value: Value| serde_json::from_value::<CommandPayload>(value).unwrap();
        assert_eq!(
            parse(json!({ "type": "follow_up", "message": "m", "uploadIds": ["u"] })),
            CommandPayload::FollowUp {
                message: "m".into(),
                upload_ids: Some(vec!["u".into()])
            }
        );
        assert_eq!(
            parse(json!({ "type": "set_model", "provider": "p", "modelId": "m" })),
            CommandPayload::SetModel {
                provider: "p".into(),
                model_id: "m".into()
            }
        );
        assert_eq!(
            serde_json::to_value(CommandPayload::SendNow {
                queue: "followUp".into(),
                index: 1,
                message: "m".into()
            })
            .unwrap(),
            json!({ "type": "send_now", "queue": "followUp", "index": 1, "message": "m" })
        );
        assert_eq!(
            parse(json!({ "type": "clear_queue" })),
            CommandPayload::ClearQueue
        );
        assert!(
            serde_json::from_value::<Delivery>(json!({ "customType": "scheduled-run",
            "content": "c", "extra": 1 }))
            .is_err()
        );
    }
}
