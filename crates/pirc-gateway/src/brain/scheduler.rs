//! The turn queue (decisions #13 and #16): one turn at a time, for the
//! whole household.
//!
//! People's messages wait in `room_pending` until their batch is ready:
//! "send now" at once; otherwise the debounce (`brain.json`, default 3 s)
//! after the last message, and not while its sender is still typing (a
//! keystroke signal lives [`TYPING_TTL_MS`]). A ready batch starts a turn in
//! its room when the brain is idle; while a turn runs, ready batches of its
//! own room are steered into it (one steer per scheduling pass), and other
//! rooms wait for it to end. Plan 05 adds wake turns behind user turns.
//!
//! Pending input leaves the table only once the brain's conversation has
//! it (the agent admitted it), so a restart in between hands it over
//! again; what a turn never admitted (steered in as it was stopped) is
//! retried by a new turn. A turn that fails keeps what it admitted: the
//! next turn in the room sees it in the conversation.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::rc::Rc;
use std::time::Duration;

use pirc_agent::stream::StreamFn;
use pirc_agent::tools::Tool;
use pirc_protocol::StopReason;
use serde_json::json;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use super::store::{Outcome, TurnStore};
use super::turn::{RoomAgent, compose, post_line};
use super::{Command, identity, memory, presence};
use crate::app::AppState;
use crate::db::rooms::{Pending, RoomInputStore, RoomStore};
use crate::rooms::TYPING_TTL_MS;
use crate::util::now_ms;

/// The line a turn that failed leaves in its room.
pub const FAILED_LINE: &str = "The model is unavailable right now.";

/// When a batch is ready for the brain.
pub fn due_at(pending: &Pending, keystroke: Option<i64>, debounce_ms: i64) -> i64 {
    if pending.immediate {
        return pending.last_at;
    }
    let after_send = pending.last_at + debounce_ms;
    keystroke.map_or(after_send, |at| after_send.max(at + TYPING_TTL_MS))
}

/// What is ready now and when the next batch will be.
#[derive(Debug, Default, PartialEq)]
pub struct Plan {
    /// Ready batches by room; rooms in the order of their oldest batch.
    pub ready: Vec<(String, Vec<Pending>)>,
    pub next_at: Option<i64>,
}

/// Plan the pending input (oldest first), leaving out messages already
/// handed to the brain (`in_flight`).
pub fn plan(
    pending: Vec<Pending>,
    in_flight: &HashSet<String>,
    now: i64,
    debounce_ms: i64,
    keystroke: impl Fn(&str, &str) -> Option<i64>,
) -> Plan {
    let mut out = Plan::default();
    for mut batch in pending {
        batch.message_ids.retain(|id| !in_flight.contains(id));
        if batch.message_ids.is_empty() {
            continue;
        }
        let at = due_at(&batch, keystroke(&batch.room_id, &batch.user), debounce_ms);
        if at > now {
            out.next_at = Some(out.next_at.map_or(at, |next| next.min(at)));
            continue;
        }
        match out
            .ready
            .iter_mut()
            .find(|(room, _)| *room == batch.room_id)
        {
            Some((_, batches)) => batches.push(batch),
            None => out.ready.push((batch.room_id.clone(), vec![batch])),
        }
    }
    out
}

struct Running {
    room_id: String,
    turn_id: String,
    room: Rc<RoomAgent>,
    task: JoinHandle<()>,
}

pub struct Scheduler {
    app: AppState,
    config_dir: PathBuf,
    stream: Rc<dyn StreamFn>,
    tools: Vec<Rc<dyn Tool>>,
    /// The gateway's main runtime (node requests).
    runtime: tokio::runtime::Handle,
    rooms: HashMap<String, Rc<RoomAgent>>,
    /// Message ids handed to an agent and not yet admitted.
    in_flight: Rc<RefCell<HashSet<String>>>,
    running: Option<Running>,
    /// To nudge itself from its tasks.
    commands: mpsc::UnboundedSender<Command>,
}

impl Scheduler {
    pub fn new(
        app: AppState,
        (stream, tools, runtime): (Rc<dyn StreamFn>, Vec<Rc<dyn Tool>>, tokio::runtime::Handle),
        commands: mpsc::UnboundedSender<Command>,
    ) -> Self {
        Self {
            config_dir: app.config.config_dir.clone(),
            app,
            stream,
            tools,
            runtime,
            rooms: HashMap::new(),
            in_flight: Rc::default(),
            running: None,
            commands,
        }
    }

    /// Serve until told to stop (or the gateway drops its handle).
    pub async fn run(mut self, mut commands: mpsc::UnboundedReceiver<Command>) {
        if let Err(error) = self.app.db.lock().close_open_turns() {
            crate::log::warn(&format!(
                "brain: cannot close open turns: {}",
                error.message
            ));
        }
        loop {
            let next_at = self.step().await;
            let sleep = next_at
                .map(|at| tokio::time::sleep(Duration::from_millis((at - now_ms()).max(0) as u64)));
            let running = self.running.as_mut().map(|running| &mut running.task);
            tokio::select! {
                command = commands.recv() => match command {
                    Some(Command::Nudge) => {}
                    Some(Command::Stop(done)) => {
                        self.stop().await;
                        let _ = done.send(());
                        return;
                    }
                    None => {
                        self.stop().await;
                        return;
                    }
                },
                () = async { sleep.expect("guarded").await }, if sleep.is_some() => {}
                _ = async { running.expect("guarded").await }, if running.is_some() => {
                    self.running = None;
                }
            }
        }
    }

    /// Start or steer what is ready; when to look again.
    async fn step(&mut self) -> Option<i64> {
        let debounce_ms = identity::settings(&self.config_dir).debounce_ms;
        let pending = match self.app.db.lock().list_pending() {
            Ok(pending) => pending,
            Err(error) => {
                crate::log::warn(&format!(
                    "brain: cannot read pending input: {}",
                    error.message
                ));
                return Some(now_ms() + 5_000);
            }
        };
        let now = now_ms();
        let typing = self.app.typing();
        let mut plan = plan(
            pending,
            &self.in_flight.borrow(),
            now,
            debounce_ms,
            |room, user| typing.last_keystroke(room, user, now),
        );
        // An archived room waits until it is unarchived (which nudges).
        plan.ready.retain(|(room_id, _)| {
            self.app
                .db
                .lock()
                .get_room(room_id)
                .is_ok_and(|room| room.archived_at.is_none())
        });
        if let Some(running) = &self.running {
            let room_id = running.room_id.clone();
            if let Some((_, batches)) = plan.ready.into_iter().find(|(room, _)| *room == room_id) {
                self.steer(&batches);
            }
        } else if let Some((room_id, batches)) = plan.ready.into_iter().next() {
            self.start(&room_id, &batches).await;
            // Other rooms' batches wait for this turn.
        }
        plan.next_at
    }

    async fn room(&mut self, room_id: &str) -> Result<Rc<RoomAgent>, String> {
        if let Some(room) = self.rooms.get(room_id) {
            return Ok(room.clone());
        }
        let room = Rc::new(
            RoomAgent::open(
                &self.app,
                room_id,
                (self.stream.clone(), self.tools.clone()),
                &self.runtime,
            )
            .await?,
        );
        self.rooms.insert(room_id.to_owned(), room.clone());
        Ok(room)
    }

    async fn start(&mut self, room_id: &str, batches: &[Pending]) {
        let ids = message_ids(batches);
        let (text, room_row) = {
            let conn = self.app.db.lock();
            (compose(&conn, room_id, batches), conn.get_room(room_id))
        };
        let (text, room_row) = match (text, room_row) {
            (Ok(text), Ok(room_row)) => (text, room_row),
            (Err(error), _) | (_, Err(error)) => {
                crate::log::warn(&format!(
                    "brain: cannot read {room_id}'s input: {}",
                    error.message
                ));
                return;
            }
        };
        if text.is_empty() {
            consume(&self.app, batches);
            return;
        }
        let room = match self.room(room_id).await {
            Ok(room) => room,
            Err(error) => {
                // Never retried in a loop: the input stays in the room.
                crate::log::warn(&format!("brain: cannot open {room_id}: {error}"));
                consume(&self.app, batches);
                post_line(&self.app, room_id, FAILED_LINE);
                return;
            }
        };
        room.progress.reset_turn();
        let speakers = speakers(batches);
        let mut prompt = identity::sections(&self.config_dir, &room_row);
        prompt.extend(memory::sections(
            &self.app,
            &speakers,
            &memory::without_names(&text, &speakers),
        ));
        room.memory.set_speakers(speakers);
        room.agent.set_base_prompt(prompt);
        room.agent.refresh_models().await;
        let turn = match self.app.db.lock().start_turn(room_id, "user", &ids) {
            Ok(turn) => turn,
            Err(error) => {
                crate::log::warn(&format!("brain: cannot record a turn: {}", error.message));
                return;
            }
        };
        presence(&self.app, room_id, true);
        self.hand_over(&room, text, batches);
        let task = tokio::task::spawn_local(finish(
            self.app.clone(),
            room.clone(),
            room_id.to_owned(),
            turn.id.clone(),
            Duration::from_millis(self.app.config.brain_turn_timeout_ms),
        ));
        self.running = Some(Running {
            room_id: room_id.to_owned(),
            turn_id: turn.id,
            room,
            task,
        });
    }

    /// One steer into the running turn: what its room said meanwhile.
    fn steer(&mut self, batches: &[Pending]) {
        let Some(running) = &self.running else {
            return;
        };
        let text = match compose(&self.app.db.lock(), &running.room_id, batches) {
            Ok(text) => text,
            Err(_) => return,
        };
        let room = running.room.clone();
        if text.is_empty() {
            consume(&self.app, batches);
            return;
        }
        if let Err(error) = self
            .app
            .db
            .lock()
            .add_turn_messages(&running.turn_id, &message_ids(batches))
        {
            crate::log::warn(&format!("brain: cannot record a steer: {}", error.message));
        }
        self.hand_over(&room, text, batches);
    }

    /// Say `text` in the room's conversation and take the batches out of
    /// the pending input once it is admitted.
    fn hand_over(&self, room: &Rc<RoomAgent>, text: String, batches: &[Pending]) {
        let ids = message_ids(batches);
        self.in_flight.borrow_mut().extend(ids.iter().cloned());
        let ticket = room.say(text);
        tokio::task::spawn_local(admit(
            self.app.clone(),
            room.clone(),
            ticket,
            batches.to_vec(),
            self.in_flight.clone(),
            self.commands.clone(),
        ));
    }

    /// Stop the running turn (the gateway is shutting down).
    async fn stop(&mut self) {
        if let Some(running) = self.running.take() {
            running.room.agent.abort();
            let _ = tokio::time::timeout(Duration::from_secs(5), running.task).await;
        }
    }
}

/// The people of a turn, in the order of their batches.
fn speakers(batches: &[Pending]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for batch in batches {
        if !out.contains(&batch.user) {
            out.push(batch.user.clone());
        }
    }
    out
}

fn message_ids(batches: &[Pending]) -> Vec<String> {
    batches
        .iter()
        .flat_map(|batch| batch.message_ids.iter().cloned())
        .collect()
}

/// Take the batches out of the pending input.
fn consume(app: &AppState, batches: &[Pending]) {
    let conn = app.db.lock();
    for batch in batches {
        if let Err(error) = conn.consume_pending(&batch.room_id, &batch.user, &batch.message_ids) {
            crate::log::warn(&format!("brain: cannot consume input: {}", error.message));
        }
    }
}

/// Wait until the agent admitted `ticket`, then consume its batches; when
/// the run ends first, release them for a later turn.
async fn admit(
    app: AppState,
    room: Rc<RoomAgent>,
    ticket: u64,
    batches: Vec<Pending>,
    in_flight: Rc<RefCell<HashSet<String>>>,
    commands: mpsc::UnboundedSender<Command>,
) {
    let release = || {
        let mut in_flight = in_flight.borrow_mut();
        for id in batches.iter().flat_map(|batch| &batch.message_ids) {
            in_flight.remove(id);
        }
    };
    loop {
        let changed = room.progress.changed.notified();
        if room.progress.admitted.get() >= ticket {
            consume(&app, &batches);
            release();
            return;
        }
        if !room.agent.is_running() {
            release();
            let _ = commands.send(Command::Nudge);
            return;
        }
        changed.await;
    }
}

/// Run the turn to its end, within the time limit, and record how it went.
async fn finish(
    app: AppState,
    room: Rc<RoomAgent>,
    room_id: String,
    turn_id: String,
    timeout: Duration,
) {
    let timed_out = tokio::select! {
        () = room.agent.idle() => false,
        () = tokio::time::sleep(timeout) => {
            room.agent.abort();
            room.agent.idle().await;
            true
        }
    };
    // Steers it never took wait for the next turn.
    room.agent.clear_queue();
    let progress = &room.progress;
    let outcome = if timed_out {
        Outcome::Timeout
    } else {
        match progress.last_stop.get() {
            Some(StopReason::Error) | None => Outcome::Failed,
            Some(StopReason::Aborted) => Outcome::Aborted,
            Some(_) => Outcome::Done,
        }
    };
    let error = match outcome {
        Outcome::Failed => Some(
            progress
                .last_error
                .borrow()
                .clone()
                .unwrap_or_else(|| "No reply".to_owned()),
        ),
        _ => None,
    };
    match outcome {
        Outcome::Failed => post_line(&app, &room_id, FAILED_LINE),
        Outcome::Timeout => post_line(
            &app,
            &room_id,
            &format!(
                "That took longer than {}, so I stopped.",
                duration_text(timeout)
            ),
        ),
        _ => {}
    }
    let usage = progress
        .usage
        .borrow()
        .as_ref()
        .map_or(json!(null), |usage| json!(usage));
    if let Err(error) = app
        .db
        .lock()
        .end_turn(&turn_id, outcome, error.as_deref(), &usage)
    {
        crate::log::warn(&format!(
            "brain: cannot record a turn's end: {}",
            error.message
        ));
    }
    presence(&app, &room_id, false);
}

fn duration_text(duration: Duration) -> String {
    let seconds = duration.as_secs();
    if seconds >= 60 && seconds.is_multiple_of(60) {
        let minutes = seconds / 60;
        format!("{minutes} minute{}", if minutes == 1 { "" } else { "s" })
    } else {
        format!("{seconds} second{}", if seconds == 1 { "" } else { "s" })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn batch(room: &str, user: &str, ids: &[&str], last_at: i64, immediate: bool) -> Pending {
        Pending {
            room_id: room.into(),
            user: user.into(),
            message_ids: ids.iter().map(|id| (*id).to_owned()).collect(),
            first_at: last_at - 100,
            last_at,
            immediate,
        }
    }

    #[test]
    fn a_batch_waits_for_the_debounce_and_the_typing() {
        let quiet = batch("r", "u", &["a"], 10_000, false);
        assert_eq!(due_at(&quiet, None, 3_000), 13_000);
        // Still typing: the keystroke signal must lapse too.
        assert_eq!(due_at(&quiet, Some(9_000), 3_000), 15_000);
        assert_eq!(due_at(&quiet, Some(5_000), 3_000), 13_000);
        let now = batch("r", "u", &["a"], 10_000, true);
        assert_eq!(due_at(&now, Some(9_500), 3_000), 10_000, "send now");
    }

    #[test]
    fn plans_ready_rooms_in_order_and_the_next_wake() {
        let pending = vec![
            batch("one", "u", &["a"], 1_000, false),
            batch("two", "v", &["b"], 1_500, false),
            batch("one", "v", &["c", "d"], 1_800, false),
            batch("three", "u", &["e"], 4_000, false),
            batch("four", "u", &["f"], 500, false),
        ];
        let in_flight: HashSet<String> = ["d".to_owned(), "f".to_owned()].into();
        let typing = |room: &str, _: &str| (room == "two").then_some(4_500);
        let plan = plan(pending, &in_flight, 5_000, 3_000, typing);
        let ready: Vec<(&str, Vec<Vec<String>>)> = plan
            .ready
            .iter()
            .map(|(room, batches)| {
                (
                    room.as_str(),
                    batches.iter().map(|b| b.message_ids.clone()).collect(),
                )
            })
            .collect();
        assert_eq!(
            ready,
            [("one", vec![vec!["a".to_owned()], vec!["c".to_owned()]])],
            "four is in flight, two is typing, three is not due"
        );
        assert_eq!(plan.next_at, Some(7_000), "three at 7 s, two at 10.5 s");
    }

    #[test]
    fn says_how_long() {
        assert_eq!(duration_text(Duration::from_secs(600)), "10 minutes");
        assert_eq!(duration_text(Duration::from_secs(60)), "1 minute");
        assert_eq!(duration_text(Duration::from_millis(1500)), "1 second");
    }
}
