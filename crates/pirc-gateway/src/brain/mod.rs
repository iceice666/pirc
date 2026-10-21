//! The brain (plans/rewrite/02-brain-host.md): one `pirc-agent` loop that
//! lives in the gateway process and speaks in rooms as the host face.
//!
//! The agent is single-threaded (`Rc`, non-`Send` futures), so the brain
//! runs on its own thread: a current-thread runtime with a `LocalSet`,
//! where the turn queue ([`scheduler`]) and every room's agent live. The
//! rest of the gateway nudges it through [`Brain`] when people say
//! something; model calls and web searches run on the gateway's main
//! runtime ([`stream`], [`tools`]).
//!
//! - [`identity`]: `SOUL.md`, `CHAT.md` and `brain.json`.
//! - [`turn`]: a room's agent, its streamed reply, its input.
//! - [`store`]: the rooms' conversations on disk and the turn records.
//! - [`loops`]: the open loops, always in its prompt.
//! - [`waking`]: a wake turn (`crate::wake`): its prompt, input and tools.
//! - [`worker_tools`]: calling workers (`crate::delegations`).

pub mod hands;
pub mod identity;
mod loop_tools;
pub mod loops;
mod memory;
mod scheduler;
pub mod store;
mod stream;
#[cfg(test)]
mod tests;
mod tools;
mod turn;
mod ui;
mod waking;
mod worker_tools;

use std::collections::HashMap;
use std::rc::Rc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use pirc_agent::stream::StreamFn;
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};

use crate::app::{App, AppState};
use crate::db::rooms::HOST_FACE_ID;

/// Builds the brain's model access on its own thread (`Rc` is not `Send`).
pub type StreamFactory = Box<dyn FnOnce() -> Rc<dyn StreamFn> + Send>;

pub enum Command {
    /// Something changed: look at the pending input again.
    Nudge,
    /// Stop the running turn and the thread.
    Stop(oneshot::Sender<()>),
}

/// The gateway's handle on the brain thread (in `App::slots`).
pub struct Brain {
    commands: mpsc::UnboundedSender<Command>,
}

impl Brain {
    /// Start the brain thread with the gateway's own inference.
    pub fn start(app: &AppState) -> Result<Arc<Self>, String> {
        let runtime = tokio::runtime::Handle::current();
        let inference = app.clone();
        Self::start_with(
            app,
            Box::new(move || {
                Rc::new(stream::GatewayStream {
                    app: inference,
                    runtime,
                })
            }),
        )
    }

    /// Start the brain thread with another model (tests).
    pub fn start_with(app: &AppState, stream: StreamFactory) -> Result<Arc<Self>, String> {
        let (commands, receiver) = mpsc::unbounded_channel();
        let runtime = tokio::runtime::Handle::current();
        let thread_app = app.clone();
        let own = commands.clone();
        std::thread::Builder::new()
            .name("pirc-brain".to_owned())
            .spawn(move || {
                let local_runtime = match tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    Ok(runtime) => runtime,
                    Err(error) => {
                        crate::log::error(&format!("brain: cannot start its runtime: {error}"));
                        return;
                    }
                };
                let local = tokio::task::LocalSet::new();
                local.block_on(&local_runtime, async move {
                    let tools = tools::brain_tools(&thread_app, &runtime);
                    scheduler::Scheduler::new(thread_app, (stream(), tools, runtime), own)
                        .run(receiver)
                        .await;
                });
            })
            .map_err(|error| format!("cannot start the brain thread: {error}"))?;
        let brain = Arc::new(Self { commands });
        let stored = app.slots.get_or_init(|| Arc::clone(&brain));
        Ok(Arc::clone(&stored))
    }

    /// Look at the pending input again (a message was sent, a room was
    /// unarchived). Nothing when the gateway runs without a brain.
    pub fn nudge(app: &App) {
        if let Some(brain) = app.slots.get::<Arc<Brain>>() {
            let _ = brain.commands.send(Command::Nudge);
        }
    }

    /// Stop the running turn and the thread (gateway shutdown).
    pub async fn stop(app: &App) {
        let Some(brain) = app.slots.get::<Arc<Brain>>() else {
            return;
        };
        let (done, stopped) = oneshot::channel();
        if brain.commands.send(Command::Stop(done)).is_ok() {
            let _ = tokio::time::timeout(Duration::from_secs(10), stopped).await;
        }
    }
}

/// Where the brain is thinking now: room id → since when.
#[derive(Default)]
struct Presence(Mutex<HashMap<String, i64>>);

/// The host face starts (`thinking`) or stops thinking in a room: an
/// ephemeral `brain_presence` event `{face, state}` for everyone there.
fn presence(app: &App, room_id: &str, thinking: bool) {
    let slot = app.slots.get_or_init(Presence::default);
    {
        let mut rooms = slot.0.lock().unwrap_or_else(|p| p.into_inner());
        if thinking {
            rooms.insert(room_id.to_owned(), crate::util::now_ms());
        } else {
            rooms.remove(room_id);
        }
    }
    app.rooms.publish_ephemeral(
        room_id,
        "brain_presence",
        json!({ "face": HOST_FACE_ID, "state": if thinking { "thinking" } else { "idle" } }),
    );
}

/// The rooms where a face is thinking now, for a room socket's `ready`
/// (presence events are not replayed).
pub fn current_presence(app: &App) -> Value {
    let Some(slot) = app.slots.get::<Presence>() else {
        return json!([]);
    };
    let rooms = slot.0.lock().unwrap_or_else(|p| p.into_inner());
    let mut list: Vec<(&String, &i64)> = rooms.iter().collect();
    list.sort();
    Value::Array(
        list.into_iter()
            .map(|(room_id, since)| {
                json!({ "face": HOST_FACE_ID, "roomId": room_id, "state": "thinking", "since": since })
            })
            .collect(),
    )
}
