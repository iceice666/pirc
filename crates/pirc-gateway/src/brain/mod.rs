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
//! - [`faces`]: the faces it speaks through, and who answers.
//! - [`moving`]: topics, and moving a conversation to its room.
//! - [`turn`]: a room's agent, its streamed reply, its input.
//! - [`store`]: the rooms' conversations on disk and the turn records.
//! - [`loops`]: the open loops, always in its prompt.
//! - [`waking`]: a wake turn (`crate::wake`): its prompt, input and tools.
//! - [`worker_tools`]: calling workers (`crate::delegations`).
//! - [`source_tools`]: reading the sources (`crate::sources`).

mod face_tools;
pub mod faces;
pub mod hands;
pub mod identity;
mod loop_tools;
pub mod loops;
mod memory;
pub mod moving;
mod scheduler;
mod source_tools;
pub mod store;
mod stream;
#[cfg(test)]
mod tests;
mod tools;
mod turn;
mod ui;
mod waking;
mod worker_tools;

pub(crate) use worker_tools::readable as readable_workspace;

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

    /// Whether the gateway runs a brain: it tells the rooms how their
    /// workers ended.
    pub fn present(app: &App) -> bool {
        app.slots.get::<Arc<Brain>>().is_some()
    }

    /// Look at the pending input again (a message was sent, a room was
    /// unarchived, a worker ended). Nothing when the gateway runs without a
    /// brain.
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

/// Where the brain is thinking now: room id → the face it speaks as, and
/// since when.
#[derive(Default)]
struct Presence(Mutex<HashMap<String, (String, i64)>>);

/// A face starts thinking in a room (`Some`, which ends the one before
/// there, as `speak_as` does), or the brain stops thinking there (`None`):
/// ephemeral `brain_presence` events `{face, state}` for everyone in the
/// room, and `face_presence` for the faces whose state changed.
fn presence(app: &App, room_id: &str, face: Option<&str>) {
    let slot = app.slots.get_or_init(Presence::default);
    let before = {
        let mut rooms = slot.0.lock().unwrap_or_else(|p| p.into_inner());
        match face {
            Some(face) => rooms
                .insert(room_id.to_owned(), (face.to_owned(), crate::util::now_ms()))
                .map(|(face, _)| face),
            None => rooms.remove(room_id).map(|(face, _)| face),
        }
    };
    // Stopping where nothing was recorded still says the host is idle.
    let before = before.or_else(|| face.is_none().then(|| HOST_FACE_ID.to_owned()));
    if let Some(before) = before
        && face != Some(before.as_str())
    {
        app.rooms.publish_ephemeral(
            room_id,
            "brain_presence",
            json!({ "face": before, "state": "idle" }),
        );
        faces::presence_changed(app, &before, room_id);
    }
    if let Some(face) = face {
        app.rooms.publish_ephemeral(
            room_id,
            "brain_presence",
            json!({ "face": face, "state": "thinking" }),
        );
        faces::presence_changed(app, face, room_id);
    }
}

/// Where a face is thinking now, if it is: the room, and since when.
pub fn thinking_as(app: &App, face_id: &str) -> Option<(String, i64)> {
    let slot = app.slots.get::<Presence>()?;
    let rooms = slot.0.lock().unwrap_or_else(|p| p.into_inner());
    rooms
        .iter()
        .find(|(_, (face, _))| face == face_id)
        .map(|(room_id, (_, since))| (room_id.clone(), *since))
}

/// The rooms where a face is thinking now, for a room socket's `ready`
/// (presence events are not replayed).
pub fn current_presence(app: &App) -> Value {
    let Some(slot) = app.slots.get::<Presence>() else {
        return json!([]);
    };
    let rooms = slot.0.lock().unwrap_or_else(|p| p.into_inner());
    let mut list: Vec<(&String, &(String, i64))> = rooms.iter().collect();
    list.sort();
    Value::Array(
        list.into_iter()
            .map(|(room_id, (face, since))| {
                json!({ "face": face, "roomId": room_id, "state": "thinking", "since": since })
            })
            .collect(),
    )
}
