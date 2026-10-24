//! The turn queue (decisions #13 and #16): one turn at a time, for the
//! whole household.
//!
//! People's messages wait in `room_pending` until their batch is ready:
//! "send now" at once; otherwise the debounce (`brain.json`, default 3 s)
//! after the last message, and not while its sender is still typing (a
//! keystroke signal lives [`TYPING_TTL_MS`]). A ready batch starts a turn in
//! its room when the brain is idle; while a turn runs, ready batches of its
//! own room are steered into it (one steer per scheduling pass), and other
//! rooms wait for it to end.
//!
//! A room whose workers ended hears it from the brain (a `report` turn,
//! plans/rewrite/06-workers.md) when no batch is ready and nothing runs:
//! it reads their reports and tells the room in its own words; when that
//! turn fails before it said anything, the room is shown the reports as
//! they are. A turn of people in that room takes the reports along instead.
//!
//! Wakes (plans/rewrite/05-self-wake.md, `crate::wake`) come behind
//! people and reports: one starts only when no batch is ready and nothing
//! runs, within the day's quota. A batch that becomes ready while a wake runs stops it
//! (`preempted`), and the wake is put back behind that turn, once; taken
//! over again, it ends `silent`. One that already spoke has done its job.
//!
//! Pending input leaves the table only once the brain's conversation has
//! it (the agent admitted it), so a restart in between hands it over
//! again; what a turn never admitted (steered in as it was stopped) is
//! retried by a new turn. A turn that fails keeps what it admitted: the
//! next turn in the room sees it in the conversation.

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::rc::Rc;
use std::time::Duration;

use pirc_agent::agent::Delivery;
use pirc_agent::context::PromptSection;
use pirc_agent::stream::StreamFn;
use pirc_agent::tools::Tool;
use pirc_protocol::StopReason;
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use super::store::{Outcome, TurnStore};
use super::turn::{RoomAgent, compose, post_line};
use super::waking::{NOT_IN_WAKES, ONLY_IN_WAKES};
use super::{
    Command, faces, identity, loops, memory, moving, presence, source_tools, waking, worker_tools,
};
use crate::app::AppState;
use crate::db::rooms::{Pending, RoomInputStore, RoomStore};
use crate::delegations::Delegation;
use crate::rooms::TYPING_TTL_MS;
use crate::util::now_ms;
use crate::wake::{self, Wake, quota};

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
    /// A wake turn: people took over once this is set.
    preempted: Option<Rc<Cell<bool>>>,
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
        let interrupted = wake::close_interrupted(&self.app.db.lock(), now_ms());
        match interrupted {
            Ok(interrupted) => {
                for ended in interrupted {
                    wake::settle(&self.app, &ended);
                }
            }
            Err(error) => crate::log::warn(&format!(
                "brain: cannot close interrupted wakes: {}",
                error.message
            )),
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
            match &running.preempted {
                // People come first: the wake stops, and their turn starts
                // once it has.
                Some(preempted) => {
                    if !plan.ready.is_empty() && !preempted.get() {
                        preempted.set(true);
                        running.room.agent.abort();
                    }
                }
                None => {
                    let room_id = running.room_id.clone();
                    if let Some((_, batches)) =
                        plan.ready.into_iter().find(|(room, _)| *room == room_id)
                    {
                        self.steer(&batches);
                    }
                }
            }
            return plan.next_at;
        }
        if let Some((room_id, batches)) = plan.ready.into_iter().next() {
            self.start(&room_id, &batches).await;
            // Other rooms' batches wait for this turn.
            return plan.next_at;
        }
        // Nothing from people: a room whose workers ended hears of it.
        let unreported = crate::delegations::unreported_rooms(&self.app.db.lock());
        match unreported {
            Ok(rooms) => {
                for room_id in rooms {
                    let open = self
                        .app
                        .db
                        .lock()
                        .get_room(&room_id)
                        .is_ok_and(|room| room.archived_at.is_none());
                    // An archived room hears of them once unarchived.
                    if open && self.start_report(&room_id).await {
                        return plan.next_at;
                    }
                }
            }
            Err(error) => crate::log::warn(&format!(
                "brain: cannot read the workers that ended: {}",
                error.message
            )),
        }
        // Nothing from people: a wake that is due.
        loop {
            let next = wake::next(&self.app.db.lock(), now_ms());
            match next {
                Ok((Some(due), _)) => {
                    if self.start_wake(due).await {
                        return plan.next_at;
                    }
                }
                Ok((None, wake_at)) => {
                    return [plan.next_at, wake_at].into_iter().flatten().min();
                }
                Err(error) => {
                    crate::log::warn(&format!("brain: cannot read wakes: {}", error.message));
                    return Some(now_ms() + 5_000);
                }
            }
        }
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
        let said = memory::without_names(&text, &speakers);
        // Who answers (plan 10), and a move to suggest after the last turn.
        let (route, hint) = {
            let conn = self.app.db.lock();
            let route = faces::route(&conn, room_id, &said);
            let hint = moving::take_hint(&conn, room_id)
                .ok()
                .flatten()
                .map(|(name, to)| {
                    let messages =
                        moving::count(&conn, room_id, &name).unwrap_or(moving::MIN_MESSAGES);
                    moving::hint_section(&name, &to, messages)
                });
            (
                route.map(|route| (faces::sections(&conn, &route), route)),
                hint,
            )
        };
        let (face_sections, route) = match route {
            Ok(route) => route,
            Err(error) => {
                crate::log::warn(&format!("brain: cannot read the faces: {}", error.message));
                return;
            }
        };
        let mut prompt = identity::sections(&self.config_dir, &room_row);
        // Who it is now, after the room, before the house rules.
        let at = 2.min(prompt.len());
        prompt.splice(at..at, face_sections);
        // Preferences, open loops, then what may be remembered: recall
        // looks for what was said and what the loops are about.
        let (open_loops, about) = loops::section(&self.app, &route.face.id);
        let mut remembered = memory::sections(&self.app, &speakers, &format!("{said}\n{about}"));
        remembered.insert(1.min(remembered.len()), open_loops);
        prompt.extend(remembered);
        prompt.push(worker_tools::section(&self.app, false, &route.face.id));
        prompt.extend(source_tools::section(&self.app, room_id));
        prompt.extend(hint);
        room.memory.set_speakers(speakers);
        room.memory.start_turn(&route.face.id);
        room.memory.add_turn_messages(&ids);
        room.agent.set_base_prompt(prompt);
        let mut hidden: Vec<String> = ONLY_IN_WAKES
            .iter()
            .map(|name| (*name).to_owned())
            .collect();
        hidden.extend(crate::sources::tools::unused(&self.app));
        room.agent.set_hidden_tools(hidden);
        room.agent.refresh_models().await;
        let turn = match self.app.db.lock().start_turn(room_id, "user", &ids) {
            Ok(turn) => turn,
            Err(error) => {
                crate::log::warn(&format!("brain: cannot record a turn: {}", error.message));
                return;
            }
        };
        presence(&self.app, room_id, Some(&route.face.id));
        // How the room's workers ended since its last turn comes with
        // what people said.
        let reports = {
            let conn = self.app.db.lock();
            crate::delegations::untold(&conn, room_id)
                .unwrap_or_default()
                .into_iter()
                .map(|delegation| {
                    let note = report_note(&conn, &delegation);
                    (delegation, note)
                })
                .collect::<Vec<_>>()
        };
        let notes = reports.iter().map(|(_, note)| note.clone()).collect();
        self.hand_over(&room, text, batches, notes);
        let reports = told(&self.app, reports);
        let task = tokio::task::spawn_local(finish(
            self.app.clone(),
            room.clone(),
            (room_id.to_owned(), turn.id.clone(), false),
            reports,
            Duration::from_millis(self.app.config.brain_turn_timeout_ms),
        ));
        self.running = Some(Running {
            room_id: room_id.to_owned(),
            turn_id: turn.id,
            room,
            task,
            preempted: None,
        });
    }

    /// Tell a room how its workers ended, when nobody spoke there first: a
    /// turn of its own, as the face that called the first of them, that
    /// reads their reports and says what came of them. When it cannot
    /// start, the room is shown the reports as they are. Whether it started.
    async fn start_report(&mut self, room_id: &str) -> bool {
        let (ended, room_row) = {
            let conn = self.app.db.lock();
            (
                crate::delegations::untold(&conn, room_id),
                conn.get_room(room_id),
            )
        };
        let ended = match ended {
            Ok(ended) if !ended.is_empty() => ended,
            Ok(_) => return false,
            Err(error) => {
                crate::log::warn(&format!(
                    "brain: cannot read {room_id}'s workers: {}",
                    error.message
                ));
                return false;
            }
        };
        // Those whose room has not heard of them (the others were shown
        // their report before the brain told reports).
        let Some(first) = ended
            .iter()
            .find(|delegation| delegation.reported_at.is_none())
        else {
            return false;
        };
        let as_is = |app: &AppState| {
            for delegation in ended.iter().filter(|d| d.reported_at.is_none()) {
                crate::delegations::report(app, delegation);
            }
        };
        let Ok(room_row) = room_row else {
            as_is(&self.app);
            return false;
        };
        let room = match self.room(room_id).await {
            Ok(room) => room,
            Err(error) => {
                crate::log::warn(&format!("brain: cannot open {room_id}: {error}"));
                as_is(&self.app);
                return false;
            }
        };
        let route = {
            let conn = self.app.db.lock();
            faces::report_face(&conn, first.face(), room_id).map(|face| {
                let route = faces::Route {
                    face,
                    why: faces::Why::Reported,
                    mentioned: Vec::new(),
                };
                (faces::sections(&conn, &route), route)
            })
        };
        let (face_sections, route) = match route {
            Ok(route) => route,
            Err(error) => {
                crate::log::warn(&format!("brain: cannot read the faces: {}", error.message));
                as_is(&self.app);
                return false;
            }
        };
        // Whom they worked for, in the order they were called.
        let mut speakers: Vec<String> = Vec::new();
        for delegation in &ended {
            if !speakers.contains(&delegation.owner_user) {
                speakers.push(delegation.owner_user.clone());
            }
        }
        let about = ended
            .iter()
            .map(|delegation| delegation.title.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        let mut prompt = identity::sections(&self.config_dir, &room_row);
        // Who it is and what this turn is for, before the house rules.
        let at = 2.min(prompt.len());
        let mut inserted = face_sections;
        inserted.push(report_section(ended.len()));
        prompt.splice(at..at, inserted);
        let (open_loops, loops_about) = loops::section(&self.app, &route.face.id);
        let mut remembered =
            memory::sections(&self.app, &speakers, &format!("{about}\n{loops_about}"));
        remembered.insert(1.min(remembered.len()), open_loops);
        prompt.extend(remembered);
        prompt.push(worker_tools::section(&self.app, false, &route.face.id));
        prompt.extend(source_tools::section(&self.app, room_id));
        room.memory.set_speakers(speakers);
        room.memory.start_turn(&route.face.id);
        room.agent.set_base_prompt(prompt);
        let mut hidden: Vec<String> = ONLY_IN_WAKES
            .iter()
            .map(|name| (*name).to_owned())
            .collect();
        hidden.extend(crate::sources::tools::unused(&self.app));
        room.agent.set_hidden_tools(hidden);
        room.agent.refresh_models().await;
        let turn = match self.app.db.lock().start_turn(room_id, "report", &[]) {
            Ok(turn) => turn,
            Err(error) => {
                crate::log::warn(&format!("brain: cannot record a turn: {}", error.message));
                as_is(&self.app);
                return false;
            }
        };
        presence(&self.app, room_id, Some(&route.face.id));
        room.progress.reset_turn();
        *room.progress.report.borrow_mut() = Some(first.report_note());
        // All of them in one run: the earlier ones recorded, the last one
        // starts it.
        let notes: Vec<Delivery> = {
            let conn = self.app.db.lock();
            ended
                .iter()
                .map(|delegation| report_note(&conn, delegation))
                .collect()
        };
        let last = notes.len() - 1;
        let mut delivered = Ok(());
        for (index, note) in notes.into_iter().enumerate() {
            delivered = room.agent.deliver(note, index == last, false);
            if delivered.is_err() {
                break;
            }
        }
        if let Err(error) = delivered {
            crate::log::warn(&format!("brain: cannot hand over a report: {error}"));
            room.progress.report.borrow_mut().take();
            if let Err(error) =
                self.app
                    .db
                    .lock()
                    .end_turn(&turn.id, Outcome::Failed, Some(&error), &json!(null))
            {
                crate::log::warn(&format!(
                    "brain: cannot record a turn's end: {}",
                    error.message
                ));
            }
            presence(&self.app, room_id, None);
            as_is(&self.app);
            return false;
        }
        let reports = told(
            &self.app,
            ended
                .into_iter()
                .map(|delegation| (delegation, ()))
                .collect(),
        );
        let task = tokio::task::spawn_local(finish(
            self.app.clone(),
            room.clone(),
            (room_id.to_owned(), turn.id.clone(), true),
            reports,
            Duration::from_millis(self.app.config.brain_turn_timeout_ms),
        ));
        self.running = Some(Running {
            room_id: room_id.to_owned(),
            turn_id: turn.id,
            room,
            task,
            preempted: None,
        });
        true
    }

    /// Start a wake that is due, unless its room is gone or archived or
    /// the day's wakes are used up (then it ends at once). Whether it
    /// started.
    async fn start_wake(&mut self, due: Wake) -> bool {
        let now = now_ms();
        let app = self.app.clone();
        let end_now = |outcome: wake::Outcome, note: Option<&str>| {
            let ended = wake::end(&app.db.lock(), &due.id, outcome, note, now_ms());
            match ended {
                Ok(ended) => wake::settle(&app, &ended),
                Err(error) => {
                    crate::log::warn(&format!("brain: cannot end a wake: {}", error.message));
                }
            }
        };
        let room_row = match self.app.db.lock().get_room(&due.room_id) {
            Ok(room) if room.archived_at.is_none() => room,
            Ok(_) => {
                end_now(wake::Outcome::Failed, Some("the room is archived"));
                return false;
            }
            Err(_) => {
                end_now(wake::Outcome::Failed, Some("the room is gone"));
                return false;
            }
        };
        let zone = quota::zone(&self.app.config.timezone);
        let allowed = quota::allows(
            &self.app.db.lock(),
            now,
            zone,
            self.app.config.wakes_per_day,
        );
        if !allowed.unwrap_or(false) {
            end_now(wake::Outcome::Quota, None);
            return false;
        }
        let room = match self.room(&due.room_id).await {
            Ok(room) => room,
            Err(error) => {
                crate::log::warn(&format!("brain: cannot open {}: {error}", due.room_id));
                end_now(
                    wake::Outcome::Failed,
                    Some("the room's conversation cannot open"),
                );
                return false;
            }
        };
        let speakers: Vec<String> = due.user.iter().cloned().collect();
        let input = waking::input(&self.app, &due, &room_row);
        // The face it wears (plan 10).
        let route = {
            let conn = self.app.db.lock();
            faces::wake_face(&conn, &due).map(|face| {
                let route = faces::Route {
                    face,
                    why: faces::Why::Woke,
                    mentioned: Vec::new(),
                };
                (faces::sections(&conn, &route), route)
            })
        };
        let (face_sections, route) = match route {
            Ok(route) => route,
            Err(error) => {
                crate::log::warn(&format!("brain: cannot read the faces: {}", error.message));
                end_now(wake::Outcome::Failed, Some("the faces cannot be read"));
                return false;
            }
        };
        let mut prompt = identity::sections(&self.config_dir, &room_row);
        // Who it is, waking up and when to speak, before the house rules.
        let at = 2.min(prompt.len());
        let mut inserted = face_sections;
        inserted.extend(waking::sections(&self.app, &due));
        prompt.splice(at..at, inserted);
        let (open_loops, about) = loops::section(&self.app, &route.face.id);
        let mut remembered = memory::sections(&self.app, &speakers, &format!("{input}\n{about}"));
        remembered.insert(1.min(remembered.len()), open_loops);
        prompt.extend(remembered);
        prompt.push(worker_tools::section(&self.app, true, &route.face.id));
        prompt.extend(source_tools::section(&self.app, &due.room_id));
        room.memory.set_speakers(speakers);
        room.memory.start_turn(&route.face.id);
        room.agent.set_base_prompt(prompt);
        let mut hidden: Vec<String> = NOT_IN_WAKES.iter().map(|name| (*name).to_owned()).collect();
        hidden.extend(crate::sources::tools::unused(&self.app));
        room.agent.set_hidden_tools(hidden);
        room.agent.refresh_models().await;
        let turn = match self.app.db.lock().start_turn(&due.room_id, "wake", &[]) {
            Ok(turn) => turn,
            Err(error) => {
                crate::log::warn(&format!("brain: cannot record a turn: {}", error.message));
                end_now(wake::Outcome::Failed, Some("the turn cannot be recorded"));
                return false;
            }
        };
        let started = wake::start(&self.app.db.lock(), &due.id, &turn.id, now_ms());
        let started = match started {
            Ok(started) => started,
            Err(error) => {
                crate::log::warn(&format!("brain: cannot start a wake: {}", error.message));
                return false;
            }
        };
        wake::changed(&self.app, &started);
        room.progress.reset_turn();
        room.progress.spoke.set(false);
        *room.progress.wake.borrow_mut() = Some(started.clone());
        let delivered = room.agent.deliver(
            Delivery {
                custom_type: "wake".to_owned(),
                content: input,
                display: false,
                // What a source woke it with is the source's: its origin
                // goes with what the brain keeps from it.
                details: Some(match started.trigger.get("sourceId").and_then(Value::as_str) {
                    Some(source) if started.kind == wake::Kind::Source.as_str() => serde_json::json!({
                        "wakeId": started.id, "kind": started.kind, "origin": format!("tool:{source}"),
                    }),
                    _ => serde_json::json!({ "wakeId": started.id, "kind": started.kind }),
                }),
            },
            true,
            false,
        );
        let preempted = Rc::new(Cell::new(false));
        if let Err(error) = delivered {
            crate::log::warn(&format!("brain: cannot wake up: {error}"));
            *room.progress.wake.borrow_mut() = None;
            if let Err(error) =
                self.app
                    .db
                    .lock()
                    .end_turn(&turn.id, Outcome::Failed, Some(&error), &json!(null))
            {
                crate::log::warn(&format!(
                    "brain: cannot record a turn's end: {}",
                    error.message
                ));
            }
            end_now(wake::Outcome::Failed, Some(&error));
            return false;
        }
        let task = tokio::task::spawn_local(finish_wake(
            self.app.clone(),
            room.clone(),
            started,
            Duration::from_millis(self.app.config.brain_turn_timeout_ms),
            preempted.clone(),
        ));
        self.running = Some(Running {
            room_id: due.room_id.clone(),
            turn_id: turn.id,
            room,
            task,
            preempted: Some(preempted),
        });
        true
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
        room.memory.add_turn_messages(&message_ids(batches));
        self.hand_over(&room, text, batches, Vec::new());
    }

    /// Say `text` (with `notes` after it) in the room's conversation and
    /// take the batches out of the pending input once it is admitted.
    fn hand_over(
        &self,
        room: &Rc<RoomAgent>,
        text: String,
        batches: &[Pending],
        notes: Vec<Delivery>,
    ) {
        let ids = message_ids(batches);
        self.in_flight.borrow_mut().extend(ids.iter().cloned());
        let ticket = room.say_with(text, notes);
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

/// The brain's custom message about a worker that ended.
fn report_note(conn: &rusqlite::Connection, delegation: &Delegation) -> Delivery {
    Delivery {
        custom_type: crate::delegations::REPORT_TYPE.to_owned(),
        content: crate::delegations::update_message(conn, delegation),
        display: false,
        details: Some(json!({
            "delegationId": delegation.id,
            "status": delegation.status,
        })),
    }
}

/// The brain was told how these workers ended; those whose room had not
/// heard of it yet, which it is to tell now.
fn told<T>(app: &AppState, reports: Vec<(Delegation, T)>) -> Vec<Delegation> {
    let mut untold = Vec::new();
    for (delegation, _) in reports {
        if let Err(error) = crate::delegations::told(&app.db.lock(), &delegation) {
            crate::log::warn(&format!("brain: cannot note a report: {}", error.message));
        }
        if delegation.reported_at.is_none() {
            untold.push(delegation);
        }
    }
    untold
}

/// What a report turn is for (plans/rewrite/06-workers.md).
fn report_section(count: usize) -> PromptSection {
    let what = if count == 1 {
        "a worker you called has ended"
    } else {
        "workers you called have ended"
    };
    PromptSection::new(
        "worker-reports",
        "Worker reports",
        "built-in",
        format!(
            "## Worker reports\n\n\
             Nobody spoke: {what}, and the room has not been told. Tell the people here what came of it in one message, \
             the way you would tell a colleague: what got done, what to look at, what went wrong, in a few sentences. \
             Not a report and not a list; the whole of it is in the worker's thread."
        ),
    )
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
/// The workers it was to tell its room of (`reports`; a report turn is for
/// them alone) are shown there as they are when it said nothing.
async fn finish(
    app: AppState,
    room: Rc<RoomAgent>,
    (room_id, turn_id, reporting): (String, String, bool),
    reports: Vec<Delegation>,
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
    // The room hears how its workers ended either way.
    let as_is = !reports.is_empty() && !progress.wrote.get();
    progress.report.borrow_mut().take();
    match outcome {
        // A report turn's failure is said by the reports themselves.
        Outcome::Failed | Outcome::Timeout if reporting && as_is => {}
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
    if as_is {
        for delegation in &reports {
            crate::delegations::report(&app, delegation);
        }
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
    after_topic(&app, &room, &room_id);
    presence(&app, &room_id, None);
}

/// Tag the turn's messages with the topic it said, and see whether moving
/// it elsewhere is to be suggested next time (plan 10).
fn after_topic(app: &AppState, room: &RoomAgent, room_id: &str) {
    let Some((topic, ids)) = room.memory.take_topic() else {
        return;
    };
    let conn = app.db.lock();
    let now = now_ms();
    let checked = moving::tag(&conn, room_id, &topic, &ids, now).and_then(|()| {
        moving::check(
            &conn,
            room_id,
            &topic.name,
            now,
            quota::zone(&app.config.timezone),
        )
    });
    if let Err(error) = checked {
        crate::log::warn(&format!("brain: cannot keep a topic: {}", error.message));
    }
}

/// Run a wake to its end, within the time limit, and record how it went:
/// it spoke, or stayed silent; people took over (put back once); or it
/// failed (said nowhere but in the engine).
async fn finish_wake(
    app: AppState,
    room: Rc<RoomAgent>,
    running: Wake,
    timeout: Duration,
    preempted: Rc<Cell<bool>>,
) {
    let timed_out = tokio::select! {
        () = room.agent.idle() => false,
        () = tokio::time::sleep(timeout) => {
            room.agent.abort();
            room.agent.idle().await;
            true
        }
    };
    room.agent.clear_queue();
    let progress = &room.progress;
    let spoke = progress.spoke.get();
    let error = progress.last_error.borrow().clone();
    let turn_outcome = if preempted.get() {
        Outcome::Preempted
    } else if timed_out {
        Outcome::Timeout
    } else {
        match progress.last_stop.get() {
            Some(StopReason::Error) | None => Outcome::Failed,
            Some(StopReason::Aborted) => Outcome::Aborted,
            Some(_) => Outcome::Done,
        }
    };
    let (outcome, note) = match turn_outcome {
        // Said before it stopped: it has done its job.
        _ if spoke => (wake::Outcome::Spoke, None),
        Outcome::Preempted if running.attempt < wake::MAX_ATTEMPTS => {
            (wake::Outcome::Preempted, None)
        }
        Outcome::Preempted => (
            wake::Outcome::Silent,
            Some("people took over again".to_owned()),
        ),
        Outcome::Done => (wake::Outcome::Silent, None),
        Outcome::Timeout => (
            wake::Outcome::Failed,
            Some(format!("took longer than {}", duration_text(timeout))),
        ),
        Outcome::Aborted => (wake::Outcome::Failed, Some("stopped".to_owned())),
        Outcome::Failed => (
            wake::Outcome::Failed,
            Some(error.clone().unwrap_or_else(|| "No reply".to_owned())),
        ),
    };
    let usage = progress
        .usage
        .borrow()
        .as_ref()
        .map_or(json!(null), |usage| json!(usage));
    if let Some(turn_id) = &running.turn_id {
        let error = (turn_outcome == Outcome::Failed)
            .then(|| error.unwrap_or_else(|| "No reply".to_owned()));
        if let Err(error) = app
            .db
            .lock()
            .end_turn(turn_id, turn_outcome, error.as_deref(), &usage)
        {
            crate::log::warn(&format!(
                "brain: cannot record a turn's end: {}",
                error.message
            ));
        }
    }
    *progress.wake.borrow_mut() = None;
    let ended = wake::end(
        &app.db.lock(),
        &running.id,
        outcome,
        note.as_deref(),
        now_ms(),
    );
    match ended {
        Ok(ended) => {
            if outcome == wake::Outcome::Preempted {
                match wake::put_back(&app.db.lock(), &ended, now_ms()) {
                    Ok(again) => wake::changed(&app, &again),
                    Err(error) => crate::log::warn(&format!(
                        "brain: cannot put a wake back: {}",
                        error.message
                    )),
                }
                // Its loop closes after the wake put back, not now.
                wake::changed(&app, &ended);
            } else {
                wake::settle(&app, &ended);
            }
        }
        Err(error) => crate::log::warn(&format!("brain: cannot end a wake: {}", error.message)),
    }
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
