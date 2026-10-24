use std::sync::{Arc, Mutex};
use std::time::Duration;

use pirc_agent::LocalBoxFuture;
use pirc_agent::stream::StreamRequest;
use pirc_protocol::{AssistantContent, AssistantDelta, AssistantMessage, StopReason};
use pirc_providers::backends::BackendService;
use serde_json::{Value, json};

use super::scheduler::FAILED_LINE;
use super::store::TurnStore;
use super::*;
use crate::db::Db;
use crate::db::rooms::{GENERAL_ROOM_ID, MessageKind, RoomInputStore, RoomStore, Speaker};
use crate::events::RoomEvent;

const ME: &str = "me@example.com";

fn models(base: &str) -> pirc_protocol::Models {
    serde_json::from_value(json!({
        "providers": { "fake": { "api": "openai-completions", "baseUrl": base, "apiKey": "test-key",
            "models": [{ "id": "fake-model", "name": "Fake model", "contextWindow": 100000,
                "maxTokens": 1000, "reasoning": false, "input": ["text"] }] } },
        "defaultModel": { "provider": "fake", "id": "fake-model" },
    }))
    .unwrap()
}

struct Harness {
    app: AppState,
    config_dir: std::path::PathBuf,
    _dir: tempfile::TempDir,
}

fn app_with(base: &str, timeout_ms: u64) -> Harness {
    let dir = tempfile::tempdir().unwrap();
    let state = dir.path().join("state");
    let config_dir = dir.path().join("config");
    std::fs::create_dir_all(&config_dir).unwrap();
    // Short enough for tests, long enough to batch what they send at once.
    std::fs::write(
        config_dir.join("brain.json"),
        r#"{ "debounceSeconds": 0.3 }"#,
    )
    .unwrap();
    let timeout = timeout_ms.to_string();
    let env = pirc_config::Env::new(
        [
            (
                "PIRC_NODE_TOKENS",
                r#"{"n1":"0123456789abcdef0123456789abcdef"}"#,
            ),
            ("PIRC_TRUSTED_PROXIES", "127.0.0.1"),
            ("PIRC_ALLOWED_ORIGINS", "https://a.example"),
            ("PIRC_ALLOWED_HOSTS", "a.example"),
            ("PIRC_ALLOWED_USERS", ME),
            ("PIRC_STATE_DIR", state.to_str().unwrap()),
            ("PIRC_CONFIG_DIR", config_dir.to_str().unwrap()),
            ("PIRC_BRAIN_TURN_TIMEOUT_MS", timeout.as_str()),
            ("PIRC_TIMEZONE", "UTC"),
            ("HOME", "/home/test"),
        ],
        "/",
    );
    let config = pirc_config::GatewayConfig::load(&env).unwrap();
    let backends = BackendService::open(&state, models(base)).unwrap();
    Harness {
        app: crate::app::App::new(
            config,
            Arc::new(Db::memory()),
            backends,
            crate::app::test_modes(),
        ),
        config_dir,
        _dir: dir,
    }
}

fn harness() -> Harness {
    app_with("https://gateway.invalid", 600_000)
}

/// What one model call was given.
#[derive(Clone, Debug)]
struct Asked {
    system_prompt: String,
    messages: String,
    tools: Vec<String>,
}

/// How the scripted model answers.
#[derive(Clone)]
enum Answer {
    /// These words, one delta each.
    Words(&'static str),
    /// Wait for a permit (or the abort), then these words.
    After(Arc<tokio::sync::Semaphore>, &'static str),
    Fail,
    /// Call a tool with these arguments.
    Call(&'static str, Value),
}

/// A model that answers each call with the next answer (the last one
/// again when they run out) and records what it was asked.
#[derive(Clone)]
struct Scripted {
    answers: Arc<Mutex<Vec<Answer>>>,
    asked: Arc<Mutex<Vec<Asked>>>,
}

impl Scripted {
    fn new(answers: Vec<Answer>) -> Self {
        Self {
            answers: Arc::new(Mutex::new(answers)),
            asked: Arc::default(),
        }
    }

    fn asked(&self) -> Vec<Asked> {
        self.asked.lock().unwrap().clone()
    }

    fn factory(&self) -> StreamFactory {
        let model = self.clone();
        Box::new(move || Rc::new(model))
    }
}

fn reply(request: &StreamRequest, text: &str, stop: StopReason) -> AssistantMessage {
    AssistantMessage {
        content: if text.is_empty() {
            Vec::new()
        } else {
            vec![AssistantContent::Text {
                text: text.to_owned(),
                text_signature: None,
            }]
        },
        api: "openai-completions".to_owned(),
        provider: request.provider_name.clone(),
        model: request.model.id.clone(),
        usage: pirc_agent::messages::empty_usage(),
        stop_reason: stop,
        error_message: (stop == StopReason::Error).then(|| "Model inference failed".to_owned()),
        timestamp: pirc_agent::now_ms(),
        completed_at: None,
        canonical_provider: None,
        response_id: None,
        response_model: None,
    }
}

impl StreamFn for Scripted {
    fn stream<'a>(
        &'a self,
        request: StreamRequest,
        on_delta: &'a mut dyn FnMut(&AssistantDelta),
    ) -> LocalBoxFuture<'a, AssistantMessage> {
        Box::pin(async move {
            self.asked.lock().unwrap().push(Asked {
                system_prompt: request.system_prompt.clone(),
                messages: serde_json::to_string(&request.messages).unwrap(),
                tools: request.tools.iter().map(|tool| tool.name.clone()).collect(),
            });
            let answer = {
                let mut answers = self.answers.lock().unwrap();
                if answers.len() > 1 {
                    answers.remove(0)
                } else {
                    answers[0].clone()
                }
            };
            let words = match answer {
                Answer::Fail => return reply(&request, "", StopReason::Error),
                Answer::Call(name, arguments) => {
                    let mut message = reply(&request, "", StopReason::ToolUse);
                    message.content = vec![AssistantContent::ToolCall {
                        id: format!("call_{}", self.asked.lock().unwrap().len()),
                        name: name.to_owned(),
                        arguments: arguments.as_object().cloned().unwrap_or_default(),
                        thought_signature: None,
                    }];
                    return message;
                }
                Answer::Words(words) => words,
                Answer::After(gate, words) => {
                    tokio::select! {
                        permit = gate.acquire() => drop(permit),
                        () = request.signal.cancelled() => {
                            return reply(&request, "", StopReason::Aborted);
                        }
                    }
                    words
                }
            };
            for word in words.split_inclusive(' ') {
                tokio::time::sleep(Duration::from_millis(5)).await;
                on_delta(&AssistantDelta::TextDelta {
                    content_index: 0,
                    delta: word.to_owned(),
                });
            }
            reply(&request, words, StopReason::Stop)
        })
    }
}

fn say(app: &AppState, text: &str, immediate: bool) {
    say_in(app, GENERAL_ROOM_ID, text, immediate);
}

fn say_in(app: &AppState, room: &str, text: &str, immediate: bool) {
    app.db
        .lock()
        .send_user_message(room, ME, text, &[], immediate)
        .unwrap();
    Brain::nudge(app);
}

fn messages(app: &AppState, room: &str) -> Vec<crate::db::rooms::Message> {
    app.db.lock().list_messages(room, None, 100).unwrap()
}

fn host_messages(app: &AppState) -> Vec<crate::db::rooms::Message> {
    messages(app, GENERAL_ROOM_ID)
        .into_iter()
        .filter(|message| message.speaker == "face:host")
        .collect()
}

/// A room made from the API or by a tool: its id.
fn room(app: &AppState, name: &str) -> String {
    app.db.lock().create_room(name).unwrap().id
}

/// The text of the lines a face wrote in a room.
fn lines(app: &AppState, room: &str) -> Vec<String> {
    messages(app, room)
        .into_iter()
        .filter(|message| message.kind == "line")
        .map(|message| {
            message
                .body
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned()
        })
        .collect()
}

fn turns(app: &AppState) -> Vec<store::Turn> {
    app.db.lock().list_turns(GENERAL_ROOM_ID, 100).unwrap()
}

/// Wait (up to 5 s) until `done` holds.
async fn until(what: &str, mut done: impl FnMut() -> bool) {
    for _ in 0..500 {
        if done() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("timed out waiting for {what}");
}

/// Every room event from now on.
fn record(app: &AppState) -> (Arc<Mutex<Vec<RoomEvent>>>, crate::events::RoomSubscription) {
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    let subscription = app.rooms.attach(
        None,
        |_| {},
        Arc::new(move |event: &RoomEvent| sink.lock().unwrap().push(event.clone())),
    );
    (events, subscription)
}

fn finished(app: &AppState) -> bool {
    turns(app)
        .first()
        .is_some_and(|turn| turn.outcome.is_some())
}

#[tokio::test]
async fn a_turn_streams_the_reply_into_the_room() {
    let h = harness();
    let model = Scripted::new(vec![Answer::Words("Hello there, friend")]);
    Brain::start_with(&h.app, model.factory()).unwrap();
    let (events, _subscription) = record(&h.app);
    say(&h.app, "hi brain", true);
    until("the turn", || finished(&h.app)).await;
    // The turn is on record before the host stops thinking: wait for both.
    until("the host to stop thinking", || {
        events
            .lock()
            .unwrap()
            .iter()
            .any(|event| event.kind == "face_presence" && event.data["state"] == "idle")
    })
    .await;
    let replies = host_messages(&h.app);
    assert_eq!(replies.len(), 1);
    assert_eq!(replies[0].body, json!({ "text": "Hello there, friend" }));
    assert_eq!(replies[0].edited_at, None, "streaming is not editing");
    assert!(
        model.asked()[0]
            .messages
            .contains("me@example.com: hi brain")
    );
    let all: Vec<(String, Value)> = events
        .lock()
        .unwrap()
        .iter()
        .map(|event| (event.kind.clone(), event.data.clone()))
        .collect();
    // What the host is doing, for the member list (plan 10).
    let faces: Vec<&Value> = all
        .iter()
        .filter(|(kind, _)| kind == "face_presence")
        .map(|(_, data)| &data["state"])
        .collect();
    assert_eq!(faces, [&json!("thinking"), &json!("idle")]);
    let kinds: Vec<(String, Value)> = all
        .into_iter()
        .filter(|(kind, _)| kind != "room_changed" && kind != "face_presence")
        .collect();
    // (The test sends without the route, so its own message has no event.)
    assert_eq!(
        kinds[0],
        (
            "brain_presence".to_owned(),
            json!({ "face": "host", "state": "thinking" })
        )
    );
    assert_eq!(kinds[1].0, "room_message");
    assert_eq!(kinds[1].1["message"]["body"]["streaming"], json!(true));
    let last = kinds.last().unwrap();
    assert_eq!(
        last,
        &(
            "brain_presence".to_owned(),
            json!({ "face": "host", "state": "idle" })
        )
    );
    let end = &kinds[kinds.len() - 2];
    assert_eq!(end.0, "room_message_updated");
    assert_eq!(
        end.1["message"]["body"],
        json!({ "text": "Hello there, friend" })
    );
    // Taken: nothing waits any more, and the turn is on record.
    assert!(h.app.db.lock().list_pending().unwrap().is_empty());
    let turn = &turns(&h.app)[0];
    assert_eq!(
        (turn.kind.as_str(), turn.outcome.as_deref()),
        ("user", Some("done"))
    );
    assert_eq!(turn.message_ids.len(), 1);
    assert_eq!(current_presence(&h.app), json!([]));
}

#[tokio::test]
async fn messages_sent_close_together_make_one_turn() {
    let h = harness();
    let model = Scripted::new(vec![Answer::Words("All three.")]);
    Brain::start_with(&h.app, model.factory()).unwrap();
    for text in ["one", "two", "three"] {
        say(&h.app, text, false);
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    until("the turn", || finished(&h.app)).await;
    let asked = model.asked();
    assert_eq!(asked.len(), 1);
    assert!(
        asked[0]
            .messages
            .contains("me@example.com: one\\nme@example.com: two\\nme@example.com: three"),
        "{}",
        asked[0].messages
    );
    assert_eq!(turns(&h.app).len(), 1);
    // Typing holds the next one back.
    h.app.room_typing(GENERAL_ROOM_ID, ME, "web");
    say(&h.app, "four", false);
    tokio::time::sleep(Duration::from_millis(1_000)).await;
    assert_eq!(
        model.asked().len(),
        1,
        "still typing (the signal lives 6 s)"
    );
    h.app.typing().clear(GENERAL_ROOM_ID, ME);
    Brain::nudge(&h.app);
    until("the second turn", || {
        turns(&h.app).len() == 2 && finished(&h.app)
    })
    .await;
}

#[tokio::test]
async fn what_is_said_during_a_turn_is_steered_into_it() {
    let h = harness();
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    let model = Scripted::new(vec![
        Answer::After(gate.clone(), "First answer."),
        Answer::Words("Second answer."),
    ]);
    Brain::start_with(&h.app, model.factory()).unwrap();
    say(&h.app, "first", true);
    until("the model call", || model.asked().len() == 1).await;
    say(&h.app, "second", false);
    say(&h.app, "third", false);
    // Both are in flight once the debounce passed, steered in one go.
    until("the steer", || turns(&h.app)[0].message_ids.len() == 3).await;
    gate.add_permits(1);
    until("the turn", || finished(&h.app)).await;
    let asked = model.asked();
    assert_eq!(asked.len(), 2, "one more call for the steer");
    assert!(
        asked[1]
            .messages
            .contains("me@example.com: second\\nme@example.com: third")
    );
    assert_eq!(turns(&h.app).len(), 1);
    assert_eq!(host_messages(&h.app).len(), 2);
    assert!(h.app.db.lock().list_pending().unwrap().is_empty());
}

#[tokio::test]
async fn a_failed_turn_says_so_and_does_not_loop() {
    let h = harness();
    let model = Scripted::new(vec![Answer::Fail, Answer::Words("Back.")]);
    Brain::start_with(&h.app, model.factory()).unwrap();
    say(&h.app, "hello?", true);
    until("the turn", || finished(&h.app)).await;
    let turn = &turns(&h.app)[0];
    assert_eq!(turn.outcome.as_deref(), Some("failed"));
    let lines = host_messages(&h.app);
    assert_eq!(
        (lines[0].kind.as_str(), &lines[0].body),
        ("line", &json!({ "text": FAILED_LINE }))
    );
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(turns(&h.app).len(), 1, "no retry without new input");
    // The next turn still has the first message in its conversation.
    say(&h.app, "now?", true);
    until("the second turn", || {
        turns(&h.app).len() == 2 && finished(&h.app)
    })
    .await;
    let asked = model.asked();
    assert!(asked.last().unwrap().messages.contains("hello?"));
}

#[tokio::test]
async fn a_turn_that_runs_too_long_is_stopped() {
    let h = app_with("https://gateway.invalid", 300);
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    let model = Scripted::new(vec![Answer::After(gate, "never")]);
    Brain::start_with(&h.app, model.factory()).unwrap();
    say(&h.app, "think hard", true);
    until("the turn", || finished(&h.app)).await;
    assert_eq!(turns(&h.app)[0].outcome.as_deref(), Some("timeout"));
    let lines = host_messages(&h.app);
    assert_eq!(
        lines.last().unwrap().body["text"],
        "That took longer than 0 seconds, so I stopped."
    );
}

#[tokio::test]
async fn a_new_soul_applies_to_the_next_turn() {
    let h = harness();
    let model = Scripted::new(vec![Answer::Words("ok")]);
    Brain::start_with(&h.app, model.factory()).unwrap();
    say(&h.app, "one", true);
    until("the turn", || finished(&h.app)).await;
    identity::write(&h.config_dir, identity::PromptName::Soul, "You are Mo.").unwrap();
    say(&h.app, "two", true);
    until("the second turn", || {
        turns(&h.app).len() == 2 && finished(&h.app)
    })
    .await;
    let asked = model.asked();
    assert!(asked[0].system_prompt.contains("the household's assistant"));
    assert!(asked[1].system_prompt.starts_with("You are Mo."));
    assert!(asked[1].system_prompt.contains("#general"));
}

/// A model server speaking `openai-completions`: two text chunks.
async fn model_server() -> (String, Arc<Mutex<Vec<Value>>>) {
    use axum::body::Body;
    use axum::extract::State;
    use axum::response::IntoResponse;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(Vec::new()));
    async fn handle(
        State(seen): State<Arc<Mutex<Vec<Value>>>>,
        body: axum::body::Bytes,
    ) -> axum::response::Response {
        seen.lock()
            .unwrap()
            .push(serde_json::from_slice(&body).unwrap_or_default());
        let data = |value: Value| format!("data: {value}\n\n");
        let text = [
            data(json!({ "choices": [{ "index": 0, "delta": { "content": "Hi " } }] })),
            data(json!({ "choices": [{ "index": 0, "delta": { "content": "from the model" } }] })),
            data(json!({ "choices": [{ "index": 0, "delta": {}, "finish_reason": "stop" }] })),
            "data: [DONE]\n\n".to_owned(),
        ]
        .concat();
        (
            [(axum::http::header::CONTENT_TYPE, "text/event-stream")],
            Body::from(text),
        )
            .into_response()
    }
    let router = axum::Router::new()
        .fallback(handle)
        .with_state(seen.clone());
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    (base, seen)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_turn_uses_the_gateway_inference() {
    let (base, seen) = model_server().await;
    let h = app_with(&base, 600_000);
    Brain::start(&h.app).unwrap();
    say(&h.app, "hello?", true);
    until("the turn", || finished(&h.app)).await;
    assert_eq!(
        host_messages(&h.app)[0].body,
        json!({ "text": "Hi from the model" })
    );
    let request = seen.lock().unwrap()[0].to_string();
    assert!(request.contains("hello?"), "{request}");
    assert!(
        request.contains("household"),
        "the brain's identity: {request}"
    );
    assert!(!request.contains("ptc"), "no scripts: {request}");
}

/// The tool results the model was given in its last call.
fn tool_results(asked: &Asked) -> String {
    asked.messages.clone()
}

#[tokio::test]
async fn remembering_says_so_and_brings_it_back_later() {
    let h = harness();
    let model = Scripted::new(vec![
        Answer::Call(
            "remember",
            json!({ "fact": "Uses TLP for power management" }),
        ),
        Answer::Words("Noted."),
        Answer::Words("You use TLP."),
    ]);
    Brain::start_with(&h.app, model.factory()).unwrap();
    say(&h.app, "I use TLP for power management", true);
    until("the turn", || finished(&h.app)).await;
    let facts = crate::memory_records::person::list(&h.app.db.lock(), ME, 10, None).unwrap();
    assert_eq!(facts.len(), 1);
    let fact = &facts[0];
    assert_eq!(
        (
            fact.content.as_str(),
            fact.origin.as_str(),
            fact.room_id.as_deref()
        ),
        (
            "Uses TLP for power management",
            "user",
            Some(GENERAL_ROOM_ID)
        )
    );
    // The room is told, with what undoes it.
    let line = host_messages(&h.app)
        .into_iter()
        .find(|message| message.kind == "line")
        .unwrap();
    assert_eq!(
        line.body,
        json!({ "text": "Noted: Uses TLP for power management",
            "memory": { "kind": "fact", "id": fact.id, "origin": "user", "user": ME } })
    );
    assert!(tool_results(&model.asked()[1]).contains(&format!("Remembered [{}]", fact.id)));
    assert!(model.asked()[0].system_prompt.contains("## Preferences"));

    // The next turn about it recalls it without a search.
    say(&h.app, "what do I use for power?", true);
    until("the second turn", || {
        turns(&h.app).len() == 2 && finished(&h.app)
    })
    .await;
    let prompt = &model.asked()[2].system_prompt;
    assert!(prompt.contains("## You may remember"), "{prompt}");
    assert!(
        prompt.contains(&format!("[{}] (", fact.id)) && prompt.contains("from user) Uses TLP"),
        "{prompt}"
    );

    // "Don't keep this" forgets it and the line's text.
    crate::memory::lines::forget_fact(&h.app, ME, &fact.id, "user:me@example.com").unwrap();
    let line = h
        .app
        .db
        .lock()
        .get_message(GENERAL_ROOM_ID, &line.id)
        .unwrap();
    assert_eq!(line.body["text"], "Forgotten.");
    assert_eq!(line.body["memory"]["forgotten"], true);
}

#[tokio::test]
async fn preferences_and_forgetting_need_the_persons_words() {
    let h = harness();
    let model = Scripted::new(vec![
        Answer::Call(
            "save_preference",
            json!({ "preference": "Prefers short answers", "quote": "I never said this" }),
        ),
        Answer::Call(
            "save_preference",
            json!({ "preference": "Prefers short answers", "quote": "keep answers short" }),
        ),
        Answer::Words("Will do."),
        Answer::Call("forget", json!({ "id": "PREF", "quote": "forget that" })),
        Answer::Words("Forgotten."),
    ]);
    Brain::start_with(&h.app, model.factory()).unwrap();
    say(&h.app, "please keep answers short", true);
    until("the turn", || finished(&h.app)).await;
    let asked = model.asked();
    assert!(
        tool_results(&asked[1]).contains("That quote is not in what anyone here said"),
        "a made-up quote is refused"
    );
    let saved = {
        let conn = h.app.db.lock();
        crate::memory::store(&h.app, &conn)
            .list(ME, Some("active"))
            .unwrap()
    };
    assert_eq!(saved.len(), 1);
    assert_eq!(saved[0].content, "Prefers short answers");
    assert_eq!(saved[0].sources["quote"], "keep answers short");
    let line = host_messages(&h.app)
        .into_iter()
        .find(|message| message.kind == "line")
        .unwrap();
    assert_eq!(line.body["memory"]["kind"], "preference");

    // In every later prompt; forgetting takes the person's word too.
    {
        let mut answers = model.answers.lock().unwrap();
        answers[0] = Answer::Call(
            "forget",
            json!({ "id": saved[0].id, "quote": "forget that" }),
        );
    }
    say(&h.app, "forget that, please", true);
    until("the second turn", || {
        turns(&h.app).len() == 2 && finished(&h.app)
    })
    .await;
    let asked = model.asked();
    assert!(
        asked[3]
            .system_prompt
            .contains(&format!("[{}] Prefers short answers", saved[0].id))
    );
    assert!(tool_results(&asked[4]).contains(&format!("Forgot [{}]", saved[0].id)));
    let forgotten = {
        let conn = h.app.db.lock();
        crate::memory::store(&h.app, &conn)
            .get(ME, &saved[0].id)
            .unwrap()
    };
    assert_eq!(
        (forgotten.status.as_str(), forgotten.content.as_str()),
        ("forgotten", "")
    );
}

#[tokio::test]
async fn the_brain_opens_a_loop_and_has_it_in_front_of_it() {
    let h = harness();
    let model = Scripted::new(vec![
        Answer::Call(
            "open_loop",
            json!({ "what": "Team meeting", "anchor": { "cron": "0 18 * * 3" } }),
        ),
        Answer::Call(
            "open_loop",
            json!({ "what": "Dentist", "anchor": { "at": "2001-01-01T10:00" } }),
        ),
        Answer::Words("I'll keep it in mind."),
    ]);
    Brain::start_with(&h.app, model.factory()).unwrap();
    say(&h.app, "we meet every Wednesday at 18:00", true);
    until("the turn", || finished(&h.app)).await;
    let asked = model.asked();
    assert!(asked[0].system_prompt.contains("## Open loops"));
    assert!(asked[0].system_prompt.contains("(none)"));
    assert!(tool_results(&asked[2]).contains("That time has passed"));
    let open = loops::list_open(&h.app.db.lock()).unwrap();
    assert_eq!(open.len(), 1);
    assert_eq!(
        (
            open[0].origin.as_str(),
            open[0].user.as_str(),
            open[0].room_id.as_deref()
        ),
        ("user", ME, Some(GENERAL_ROOM_ID))
    );
    let line = host_messages(&h.app)
        .into_iter()
        .find(|message| message.kind == "line")
        .unwrap();
    assert!(
        line.body["text"]
            .as_str()
            .unwrap()
            .starts_with("Holding on to: Team meeting (next Wed "),
        "{}",
        line.body
    );
    assert_eq!(
        line.body["loop"],
        json!({ "id": open[0].id, "event": "opened" })
    );

    // The next turn has it in front of it, and closes it.
    {
        let mut answers = model.answers.lock().unwrap();
        *answers = vec![
            Answer::Call(
                "close_loop",
                json!({ "id": open[0].id, "reason": "The team stopped meeting" }),
            ),
            Answer::Words("Closed."),
        ];
    }
    say(&h.app, "we stopped meeting", true);
    until("the second turn", || {
        turns(&h.app).len() == 2 && finished(&h.app)
    })
    .await;
    let asked = model.asked();
    assert!(
        asked[3].system_prompt.contains(&format!(
            "- [{}] Team meeting · from user · next Wed ",
            open[0].id
        )),
        "{}",
        asked[3].system_prompt
    );
    let closed = loops::get(&h.app.db.lock(), &open[0].id).unwrap();
    assert_eq!(
        closed.closed_reason.as_deref(),
        Some("The team stopped meeting")
    );
    assert!(host_messages(&h.app).iter().any(|message| {
        message.body["text"] == "Closed: Team meeting (The team stopped meeting)"
            && message.body["loop"]["event"] == "closed"
    }));
}

// ---------- waking up (plans/rewrite/05-self-wake.md) ----------

/// Wake up in #general now, as if the brain had asked to.
fn wake_now(app: &AppState) -> crate::wake::Wake {
    crate::wake::schedule(
        app,
        &crate::wake::NewWake {
            kind: crate::wake::Kind::SelfScheduled,
            trigger: json!({ "at": crate::util::now_ms(), "why": "look at the dotfiles" }),
            room_id: GENERAL_ROOM_ID,
            face_id: None,
            user: Some(ME),
            scheduled_at: crate::util::now_ms(),
        },
    )
    .unwrap()
}

fn wake_of(app: &AppState, id: &str) -> crate::wake::Wake {
    crate::wake::get(&app.db.lock(), id).unwrap()
}

fn ended(app: &AppState, id: &str) -> bool {
    wake_of(app, id).outcome.is_some()
}

#[tokio::test]
async fn a_wake_says_something_only_with_speak() {
    let h = harness();
    let model = Scripted::new(vec![
        Answer::Call("speak", json!({ "text": "Your dotfiles look fine." })),
        Answer::Words("Done, nobody sees this."),
        Answer::Words("Hello."),
    ]);
    Brain::start_with(&h.app, model.factory()).unwrap();
    let (events, _subscription) = record(&h.app);
    let wake = wake_now(&h.app);
    until("the wake", || ended(&h.app, &wake.id)).await;
    let wake = wake_of(&h.app, &wake.id);
    assert_eq!(wake.outcome.as_deref(), Some("spoke"));
    let said = host_messages(&h.app);
    assert_eq!(said.len(), 1, "only what it spoke: {said:?}");
    assert_eq!(
        (said[0].kind.as_str(), &said[0].body),
        ("text", &json!({ "text": "Your dotfiles look fine." }))
    );
    let turn = &turns(&h.app)[0];
    assert_eq!(
        (turn.kind.as_str(), turn.outcome.as_deref(), Some(&turn.id)),
        ("wake", Some("done"), wake.turn_id.as_ref())
    );
    let asked = model.asked();
    assert!(asked[0].tools.contains(&"speak".to_owned()));
    assert!(asked[0].tools.contains(&"schedule_wake".to_owned()));
    // What acts for people is not in a wake's tool list at all.
    for hidden in [
        "create_face",
        "update_face",
        "move_room",
        "create_room",
        "archive_room",
        "topic",
    ] {
        assert!(
            !asked[0].tools.iter().any(|tool| tool == hidden),
            "a wake has no {hidden}: {:?}",
            asked[0].tools
        );
    }
    let prompt = &asked[0].system_prompt;
    assert!(prompt.contains("## Waking up"), "{prompt}");
    assert!(prompt.contains("## When to speak after waking"));
    assert!(
        prompt.find("## When to speak").unwrap() > prompt.find("#general").unwrap(),
        "after the room"
    );
    assert!(
        asked[0]
            .messages
            .contains("You asked to come back now (on "),
        "{}",
        asked[0].messages
    );
    // No presence for a wake; its changes go out as wake_changed.
    let kinds: Vec<String> = events
        .lock()
        .unwrap()
        .iter()
        .map(|event| event.kind.clone())
        .collect();
    assert!(!kinds.contains(&"brain_presence".to_owned()), "{kinds:?}");
    assert!(kinds.contains(&"wake_changed".to_owned()));

    // A conversation has no speak: the reply is what is said.
    say(&h.app, "hi", true);
    until("the user turn", || {
        turns(&h.app).len() == 2 && finished(&h.app)
    })
    .await;
    let asked = model.asked();
    let last = asked.last().unwrap();
    assert!(
        !last.tools.contains(&"speak".to_owned()),
        "{:?}",
        last.tools
    );
    assert!(last.tools.contains(&"schedule_wake".to_owned()));
    assert!(!last.system_prompt.contains("## Waking up"));
    assert_eq!(host_messages(&h.app).last().unwrap().body["text"], "Hello.");
}

#[tokio::test]
async fn a_silent_wake_leaves_nothing_in_the_room() {
    let h = harness();
    let model = Scripted::new(vec![Answer::Words("Nothing new there.")]);
    Brain::start_with(&h.app, model.factory()).unwrap();
    let wake = wake_now(&h.app);
    until("the wake", || ended(&h.app, &wake.id)).await;
    assert_eq!(wake_of(&h.app, &wake.id).outcome.as_deref(), Some("silent"));
    assert!(host_messages(&h.app).is_empty());
}

#[tokio::test]
async fn people_take_over_a_wake_and_it_comes_back_once() {
    let h = harness();
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    let model = Scripted::new(vec![
        Answer::After(gate.clone(), "never"),
        Answer::Words("Hi!"),
        Answer::After(gate.clone(), "never"),
        Answer::Words("Hi again!"),
        Answer::Words("Quiet."),
    ]);
    Brain::start_with(&h.app, model.factory()).unwrap();
    let first = wake_now(&h.app);
    until("the wake's call", || model.asked().len() == 1).await;
    say(&h.app, "hi", true);
    until("the first wake to end", || ended(&h.app, &first.id)).await;
    assert_eq!(
        wake_of(&h.app, &first.id).outcome.as_deref(),
        Some("preempted")
    );
    // The people's turn, then the wake put back.
    until("the second wake's call", || model.asked().len() == 3).await;
    assert!(model.asked()[1].messages.contains("me@example.com: hi"));
    let again = crate::wake::list(&h.app.db.lock(), None, crate::wake::Status::Pending, 10)
        .unwrap()
        .remove(0);
    assert_eq!(
        (again.attempt, again.trigger.clone()),
        (2, first.trigger.clone())
    );
    // Taken over again: it gives up, silently.
    say(&h.app, "me again", true);
    until("the second wake to end", || ended(&h.app, &again.id)).await;
    let again = wake_of(&h.app, &again.id);
    assert_eq!(
        (again.outcome.as_deref(), again.note.as_deref()),
        (Some("silent"), Some("people took over again"))
    );
    until("the last turn", || {
        turns(&h.app).len() == 4 && finished(&h.app)
    })
    .await;
    let kinds: Vec<(String, Option<String>)> = turns(&h.app)
        .into_iter()
        .rev()
        .map(|turn| (turn.kind, turn.outcome))
        .collect();
    assert_eq!(
        kinds,
        [
            ("wake".to_owned(), Some("preempted".to_owned())),
            ("user".to_owned(), Some("done".to_owned())),
            ("wake".to_owned(), Some("preempted".to_owned())),
            ("user".to_owned(), Some("done".to_owned())),
        ]
    );
    assert!(
        crate::wake::list(&h.app.db.lock(), None, crate::wake::Status::Pending, 10)
            .unwrap()
            .is_empty(),
        "not put back twice"
    );
    let texts: Vec<Value> = host_messages(&h.app)
        .into_iter()
        .map(|message| message.body["text"].clone())
        .collect();
    assert_eq!(texts, [json!("Hi!"), json!("Hi again!")]);
}

/// Open a loop in #general whose time comes in `ms`.
fn loop_due_in(app: &AppState, what: &str, ms: i64, auto_close: bool) -> loops::OpenLoop {
    let at = crate::util::now_ms() + ms;
    loops::open(
        &app.db.lock(),
        &loops::NewLoop {
            user: ME,
            room_id: Some(GENERAL_ROOM_ID),
            face_id: Some("host"),
            what,
            why: "",
            origin: "user",
            anchor: Some(loops::Anchor {
                json: json!({ "at": at, "zone": "UTC", "autoClose": auto_close }),
                due_at: at,
                notice_at: None,
            }),
            next_check: None,
            source_entry_ids: &[],
        },
        crate::util::now_ms(),
    )
    .unwrap()
    .0
}

#[tokio::test]
async fn a_time_that_comes_wakes_the_brain_and_then_closes_its_loop() {
    let h = harness();
    let model = Scripted::new(vec![
        Answer::Call("speak", json!({ "text": "Time to drink water." })),
        Answer::Words("ok"),
    ]);
    Brain::start_with(&h.app, model.factory()).unwrap();
    loops::start_timer(&h.app);
    let water = loop_due_in(&h.app, "Drink water", 200, true);
    // A little later, so the order of the wakes is known.
    let kept = loop_due_in(&h.app, "Call the bank", 400, false);
    until("both wakes", || {
        crate::wake::list(&h.app.db.lock(), None, crate::wake::Status::Ended, 10)
            .unwrap()
            .len()
            == 2
    })
    .await;
    let closed = loops::get(&h.app.db.lock(), &water.id).unwrap();
    assert_eq!(closed.closed_reason.as_deref(), Some(loops::ELAPSED));
    let open = loops::get(&h.app.db.lock(), &kept.id).unwrap();
    assert_eq!(open.status, "open", "it waits for the people");
    let asked = model.asked();
    assert!(
        asked[0].messages.contains("An open loop's time came: [")
            && asked[0].messages.contains("Drink water")
            && asked[0].messages.contains("closes once this wake is over"),
        "{}",
        asked[0].messages
    );
    // Said, then closed (the wake of the other loop said nothing: "ok").
    let texts: Vec<String> = host_messages(&h.app)
        .into_iter()
        .map(|message| message.body["text"].as_str().unwrap_or_default().to_owned())
        .collect();
    let spoken = texts
        .iter()
        .position(|text| text == "Time to drink water.")
        .unwrap();
    let closing = texts
        .iter()
        .position(|text| text.starts_with("Closed: Drink water"))
        .unwrap();
    assert!(spoken < closing, "{texts:?}");
}

#[tokio::test]
async fn past_the_days_wakes_a_time_is_still_said() {
    let h = harness();
    let model = Scripted::new(vec![Answer::Words("never asked")]);
    Brain::start_with(&h.app, model.factory()).unwrap();
    let now = crate::util::now_ms();
    for n in 0..24 {
        h.app
            .db
            .lock()
            .execute(
                "INSERT INTO wakes (id,kind,trigger_json,room_id,scheduled_at,started_at,outcome,created_at) VALUES (?,'self','{}','general',?,?,'silent',?)",
                rusqlite::params![format!("w{n}"), now, now, now],
            )
            .unwrap();
    }
    let open_loop = loop_due_in(&h.app, "Pay the rent", 60_000, true);
    crate::wake::for_loop(&h.app, &open_loop, crate::wake::moment::DUE, Some(now));
    until("the quota", || {
        crate::wake::list(&h.app.db.lock(), None, crate::wake::Status::Pending, 10)
            .unwrap()
            .is_empty()
    })
    .await;
    let quota = crate::wake::list(&h.app.db.lock(), None, crate::wake::Status::Ended, 1)
        .unwrap()
        .remove(0);
    assert_eq!(
        (quota.outcome.as_deref(), quota.started_at),
        (Some("quota"), None)
    );
    assert!(model.asked().is_empty(), "the 25th did not start");
    until("the lines", || host_messages(&h.app).len() == 2).await;
    let texts: Vec<Value> = host_messages(&h.app)
        .into_iter()
        .map(|message| message.body["text"].clone())
        .collect();
    assert_eq!(texts[0], "Reminder: Pay the rent");
    assert!(
        texts[1]
            .as_str()
            .unwrap()
            .starts_with("Closed: Pay the rent")
    );
}

#[tokio::test]
async fn the_brain_comes_back_when_it_said_it_would() {
    let h = harness();
    let at = crate::time::cron::format_time(
        crate::util::now_ms() + 120_000,
        crate::time::cron::Zone::Fixed(0),
        "UTC",
    );
    // `YYYY-MM-DD HH:MM (UTC)` → `YYYY-MM-DDTHH:MM`.
    let at = at[..16].replace(' ', "T");
    let model = Scripted::new(vec![
        Answer::Call(
            "schedule_wake",
            json!({ "at": at, "why": "look at his dotfiles" }),
        ),
        Answer::Words("I'll look later."),
    ]);
    Brain::start_with(&h.app, model.factory()).unwrap();
    say(&h.app, "can you look at my dotfiles later?", true);
    until("the turn", || finished(&h.app)).await;
    let pending =
        crate::wake::list(&h.app.db.lock(), None, crate::wake::Status::Pending, 10).unwrap();
    assert_eq!(pending.len(), 1);
    let wake = &pending[0];
    assert_eq!(
        (
            wake.kind.as_str(),
            wake.user.as_deref(),
            wake.trigger["why"].clone()
        ),
        ("self", Some(ME), json!("look at his dotfiles"))
    );
    let line = host_messages(&h.app)
        .into_iter()
        .find(|message| message.kind == "line")
        .unwrap();
    assert!(
        line.body["text"]
            .as_str()
            .unwrap()
            .starts_with("I'll come back "),
        "{}",
        line.body
    );
    assert!(
        line.body["text"]
            .as_str()
            .unwrap()
            .ends_with(" to look at: look at his dotfiles")
    );
    assert_eq!(
        line.body["wake"],
        json!({ "id": wake.id, "event": "scheduled" })
    );
    let (cancelled, _) =
        crate::wake::cancel(&h.app.db.lock(), &wake.id, crate::util::now_ms()).unwrap();
    assert_eq!(cancelled.outcome.as_deref(), Some("cancelled"));
}

// ---------- the rooms and faces it looks after (plan 10) ----------

/// A turn in a room other than `#general` ended.
fn finished_in(app: &AppState, room: &str) -> bool {
    app.db
        .lock()
        .list_turns(room, 10)
        .unwrap()
        .first()
        .is_some_and(|turn| turn.outcome.is_some())
}

#[tokio::test]
async fn the_brain_makes_a_room_when_asked() {
    let h = harness();
    let model = Scripted::new(vec![
        Answer::Call(
            "create_room",
            json!({ "name": "garden", "quote": "nobody asked" }),
        ),
        Answer::Call(
            "create_room",
            json!({ "name": "garden", "quote": "let's have a room for the garden" }),
        ),
        Answer::Call(
            "create_room",
            json!({ "name": "#garden", "quote": "let's have a room for the garden" }),
        ),
        Answer::Call(
            "create_room",
            json!({ "name": "#", "quote": "let's have a room for the garden" }),
        ),
        Answer::Words("Made it."),
    ]);
    Brain::start_with(&h.app, model.factory()).unwrap();
    say(&h.app, "let's have a room for the garden", true);
    until("the turn", || finished(&h.app)).await;
    let asked = model.asked();
    assert!(
        tool_results(&asked[1]).contains("That quote is not in what anyone here said"),
        "a made-up quote is refused: {}",
        tool_results(&asked[1])
    );
    assert!(
        tool_results(&asked[2]).contains("Made #garden"),
        "{}",
        tool_results(&asked[2])
    );
    assert!(
        tool_results(&asked[3]).contains("There is a room called #garden already"),
        "a room with the name, in another case: {}",
        tool_results(&asked[3])
    );
    assert!(
        tool_results(&asked[4]).contains("A room name has 1 to 80 characters"),
        "{}",
        tool_results(&asked[4])
    );
    let garden = h
        .app
        .db
        .lock()
        .list_rooms(ME, true)
        .unwrap()
        .into_iter()
        .filter(|view| view.room.name == "garden")
        .collect::<Vec<_>>();
    assert_eq!(garden.len(), 1, "one garden");
    assert_eq!(garden[0].room.kind, "topic");
    // The room it was asked in says so, with the id that names it.
    let made = format!("Made #garden ({})", garden[0].room.id);
    assert_eq!(lines(&h.app, GENERAL_ROOM_ID), [made]);
    assert_eq!(
        host_messages(&h.app).last().unwrap().body["text"],
        "Made it."
    );
}

#[tokio::test]
async fn the_brain_archives_a_room_but_never_the_one_it_answers_in() {
    let h = harness();
    let old = room(&h.app, "old garden");
    let here = room(&h.app, "here");
    h.app
        .db
        .lock()
        .send_user_message(&old, ME, "keep me", &[], false)
        .unwrap();
    let model = Scripted::new(vec![
        Answer::Call(
            "archive_room",
            json!({ "room": "#old garden", "quote": "archive the old garden room" }),
        ),
        Answer::Call(
            "archive_room",
            json!({ "room": "general", "quote": "archive the old garden room" }),
        ),
        Answer::Words("Archived."),
        Answer::Call(
            "archive_room",
            json!({ "room": "#old garden", "archived": false, "quote": "bring it back" }),
        ),
        Answer::Words("Back."),
        Answer::Call(
            "archive_room",
            json!({ "room": "#here", "quote": "archive this one" }),
        ),
        Answer::Words("Then archive it yourself, if you like."),
    ]);
    Brain::start_with(&h.app, model.factory()).unwrap();
    say(&h.app, "archive the old garden room", true);
    until("the turn", || finished(&h.app)).await;
    let asked = model.asked();
    assert!(
        tool_results(&asked[1]).contains("Nothing is deleted: its 1 messages stay"),
        "{}",
        tool_results(&asked[1])
    );
    assert!(
        tool_results(&asked[2]).contains("#general is never archived"),
        "{}",
        tool_results(&asked[2])
    );
    assert!(
        h.app
            .db
            .lock()
            .get_room(&old)
            .unwrap()
            .archived_at
            .is_some()
    );
    assert_eq!(messages(&h.app, &old).len(), 1, "nothing was deleted");
    assert_eq!(
        lines(&h.app, GENERAL_ROOM_ID),
        ["Archived #old garden".to_owned()]
    );

    // Back, by its name (the room is archived: the name still finds it).
    say(&h.app, "bring it back", true);
    until("the second turn", || {
        turns(&h.app).len() == 2 && finished(&h.app)
    })
    .await;
    let asked = model.asked();
    assert!(
        tool_results(&asked[4]).contains("Brought #old garden"),
        "{}",
        tool_results(&asked[4])
    );
    assert!(
        h.app
            .db
            .lock()
            .get_room(&old)
            .unwrap()
            .archived_at
            .is_none()
    );
    assert_eq!(
        lines(&h.app, GENERAL_ROOM_ID).last().unwrap(),
        "Brought #old garden back",
        "the messages are all still there"
    );
    assert_eq!(messages(&h.app, &old).len(), 1);

    // The room it is answering in: refused, so its answer has somewhere to go.
    say_in(&h.app, &here, "archive this one", true);
    until("the turn in it", || finished_in(&h.app, &here)).await;
    let asked = model.asked();
    assert!(
        tool_results(asked.last().unwrap()).contains("This is #here itself"),
        "{}",
        tool_results(asked.last().unwrap())
    );
    assert!(
        h.app
            .db
            .lock()
            .get_room(&here)
            .unwrap()
            .archived_at
            .is_none()
    );
    assert_eq!(
        messages(&h.app, &here).last().unwrap().body["text"],
        "Then archive it yourself, if you like.",
        "the room still takes messages"
    );
}

#[tokio::test]
async fn the_brain_changes_a_face_when_asked() {
    let h = harness();
    let slimeos = room(&h.app, "slimeos");
    let garden = room(&h.app, "garden");
    let pm = faces::create(
        &h.app.db.lock(),
        &faces::NewFace {
            name: "PM".into(),
            tone: "dry".into(),
            territory: faces::Territory {
                rooms: vec![slimeos.clone()],
                ..Default::default()
            },
            ..Default::default()
        },
    )
    .unwrap()
    .id;
    let model = Scripted::new(vec![
        Answer::Call(
            "update_face",
            json!({ "face": "PM", "tone": "terse", "quote": "nobody asked" }),
        ),
        Answer::Call(
            "update_face",
            json!({ "face": "PM", "tone": "terse", "quote": "make PM terser" }),
        ),
        Answer::Call(
            "update_face",
            json!({ "face": "PM", "rooms": [slimeos, garden], "quote": "make PM terser" }),
        ),
        Answer::Call(
            "update_face",
            json!({ "face": "PM", "name": "pirc", "quote": "make PM terser" }),
        ),
        Answer::Call(
            "update_face",
            json!({ "face": "PM", "workspaces": ["work:none"], "quote": "make PM terser" }),
        ),
        Answer::Call("update_face", json!({ "face": "PM", "name": "Gardener" })),
        Answer::Call(
            "update_face",
            json!({ "face": "Nope", "tone": "terse", "quote": "make PM terser" }),
        ),
        Answer::Call(
            "update_face",
            json!({ "face": "PM", "quote": "make PM terser" }),
        ),
        Answer::Words("Done."),
    ]);
    Brain::start_with(&h.app, model.factory()).unwrap();
    say(&h.app, "make PM terser", true);
    until("the turn", || finished(&h.app)).await;
    let asked = model.asked();
    assert!(
        asked[0]
            .system_prompt
            .contains("A face is made only when someone asks for one"),
        "suggest one first: {}",
        asked[0].system_prompt
    );
    assert!(tool_results(&asked[1]).contains("That quote is not in what anyone here said"));
    assert!(
        tool_results(&asked[2]).contains(&format!("Changed PM ({pm}): tone")),
        "{}",
        tool_results(&asked[2])
    );
    assert!(
        tool_results(&asked[3]).contains(&format!("Changed PM ({pm}): territory")),
        "{}",
        tool_results(&asked[3])
    );
    assert!(
        tool_results(&asked[4]).contains("There is a face called pirc already"),
        "{}",
        tool_results(&asked[4])
    );
    assert!(
        tool_results(&asked[5]).contains("No directory workspace work:none"),
        "{}",
        tool_results(&asked[5])
    );
    assert!(
        tool_results(&asked[6]).contains("quote is required"),
        "{}",
        tool_results(&asked[6])
    );
    assert!(tool_results(&asked[7]).contains("No face Nope"));
    assert!(tool_results(&asked[8]).contains("Nothing to change"));
    let changed = {
        let conn = h.app.db.lock();
        faces::get(&conn, &pm).unwrap()
    };
    assert_eq!(changed.tone, "terse");
    assert_eq!(changed.territory.rooms, [slimeos.clone(), garden.clone()]);
    assert!(
        lines(&h.app, GENERAL_ROOM_ID).contains(&"PM answers in #slimeos, #garden now.".to_owned()),
        "the rooms that changed are said: {:?}",
        lines(&h.app, GENERAL_ROOM_ID)
    );

    // Archived and back, by name, and the host is never archived.
    {
        let mut answers = model.answers.lock().unwrap();
        *answers = vec![
            Answer::Call(
                "update_face",
                json!({ "face": "PM", "archived": true, "quote": "archive PM" }),
            ),
            Answer::Words("Archived."),
            Answer::Call(
                "update_face",
                json!({ "face": "PM", "archived": false, "quote": "bring PM back" }),
            ),
            Answer::Call(
                "update_face",
                json!({ "face": "host", "archived": true, "quote": "bring PM back" }),
            ),
            Answer::Words("Back."),
        ];
    }
    say(&h.app, "archive PM", true);
    until("the archive", || {
        turns(&h.app).len() == 2 && finished(&h.app)
    })
    .await;
    let asked = model.asked();
    let archived = tool_results(&asked[asked.len() - 1]);
    assert!(
        archived.contains(&format!("Changed PM ({pm}): archived")),
        "{archived}"
    );
    assert!(
        faces::find(&h.app.db.lock(), "PM").unwrap().is_none(),
        "an archived face answers nowhere"
    );
    assert!(
        lines(&h.app, GENERAL_ROOM_ID)
            .contains(&"PM is archived: its rooms answer as the host until it is back.".to_owned()),
        "{:?}",
        lines(&h.app, GENERAL_ROOM_ID)
    );

    say(&h.app, "bring PM back", true);
    until("its return", || {
        turns(&h.app).len() == 3 && finished(&h.app)
    })
    .await;
    let asked = model.asked();
    let back = tool_results(&asked[asked.len() - 1]);
    assert!(
        back.contains(&format!("Changed PM ({pm}): brought back")),
        "{back}"
    );
    assert!(back.contains("The host cannot be archived"), "{back}");
    let returned = {
        let conn = h.app.db.lock();
        faces::get(&conn, &pm).unwrap()
    };
    assert!(returned.active());
    assert!(
        lines(&h.app, GENERAL_ROOM_ID).contains(&"PM is back.".to_owned()),
        "{:?}",
        lines(&h.app, GENERAL_ROOM_ID)
    );
}

/// A worker of #general that ended with `status` and `result`.
fn ended_worker(app: &AppState, id: &str, status: &str, result: &str) {
    app.db
        .lock()
        .execute(
            "INSERT INTO delegations (id,owner_user,room_id,workspace_id,title,task,status,result,thread_id,expires_at,created_at,updated_at)
             VALUES (?1,?2,?3,'work:repo',?4,'x',?5,?6,?7,0,0,0)",
            rusqlite::params![
                id,
                ME,
                GENERAL_ROOM_ID,
                format!("Task {id}"),
                status,
                result,
                format!("thread_{id}")
            ],
        )
        .unwrap();
}

fn unreported(app: &AppState) -> Vec<String> {
    crate::delegations::unreported_rooms(&app.db.lock()).unwrap()
}

#[tokio::test]
async fn the_brain_tells_the_room_how_its_workers_ended() {
    let h = harness();
    ended_worker(
        &h.app,
        "d1",
        "completed",
        "All 42 tests pass; clippy is clean.",
    );
    ended_worker(&h.app, "d2", "failed", "The run cancelled");
    let model = Scripted::new(vec![Answer::Words(
        "The tests pass; the other run was stopped.",
    )]);
    Brain::start_with(&h.app, model.factory()).unwrap();
    until("the report turn", || finished(&h.app)).await;
    let turn = &turns(&h.app)[0];
    assert_eq!(
        (turn.kind.as_str(), turn.outcome.as_deref()),
        ("report", Some("done"))
    );
    // One model call has both reports, and says what the turn is for.
    let asked = model.asked();
    assert_eq!(asked.len(), 1);
    assert!(asked[0].system_prompt.contains("## Worker reports"));
    assert!(
        asked[0]
            .system_prompt
            .contains("It called the worker that reported back.")
    );
    assert!(asked[0].messages.contains("All 42 tests pass"));
    assert!(asked[0].messages.contains("The run cancelled"));
    assert!(asked[0].messages.contains("the room has not been told"));
    // The room hears it in the brain's words, linked to the first thread.
    let replies = host_messages(&h.app);
    assert_eq!(replies.len(), 1, "{replies:?}");
    assert_eq!(
        replies[0].body,
        json!({ "text": "The tests pass; the other run was stopped.", "worker": {
            "delegationId": "d1", "threadId": "thread_d1", "status": "completed", "report": true,
        } })
    );
    assert!(unreported(&h.app).is_empty());
    assert!(
        crate::delegations::untold(&h.app.db.lock(), GENERAL_ROOM_ID)
            .unwrap()
            .is_empty()
    );
    // Not again, and people's next turn is theirs.
    say(&h.app, "thanks", true);
    until("the next turn", || {
        turns(&h.app).len() == 2 && finished(&h.app)
    })
    .await;
    assert_eq!(turns(&h.app)[0].kind, "user");
    assert_eq!(model.asked().len(), 2);
    assert!(!host_messages(&h.app)[1].body.get("worker").is_some());
}

#[tokio::test]
async fn a_report_turn_that_fails_shows_the_report_as_it_is() {
    let h = harness();
    ended_worker(&h.app, "d1", "completed", "All 42 tests pass.");
    let model = Scripted::new(vec![Answer::Fail]);
    Brain::start_with(&h.app, model.factory()).unwrap();
    until("the report turn", || finished(&h.app)).await;
    until("the report", || !host_messages(&h.app).is_empty()).await;
    assert_eq!(turns(&h.app)[0].outcome.as_deref(), Some("failed"));
    let shown = host_messages(&h.app);
    assert_eq!(shown.len(), 1, "the report, without the failure line");
    assert_eq!(
        shown[0].body,
        json!({ "text": "All 42 tests pass.", "worker": {
            "delegationId": "d1", "threadId": "thread_d1", "status": "completed", "report": true,
        } })
    );
    assert!(unreported(&h.app).is_empty());
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(turns(&h.app).len(), 1, "no retry");
}

#[tokio::test]
async fn people_who_speak_first_hear_of_their_worker_in_their_turn() {
    let h = harness();
    ended_worker(&h.app, "d1", "completed", "All 42 tests pass.");
    h.app
        .db
        .lock()
        .send_user_message(GENERAL_ROOM_ID, ME, "how did it go?", &[], true)
        .unwrap();
    let model = Scripted::new(vec![Answer::Words("It went well: every test passes.")]);
    Brain::start_with(&h.app, model.factory()).unwrap();
    until("the turn", || finished(&h.app)).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let all = turns(&h.app);
    assert_eq!(all.len(), 1, "no report turn after it");
    assert_eq!(all[0].kind, "user");
    let asked = model.asked();
    assert!(asked[0].messages.contains("how did it go?"));
    assert!(asked[0].messages.contains("All 42 tests pass."));
    assert!(!asked[0].system_prompt.contains("## Worker reports"));
    assert_eq!(
        host_messages(&h.app)
            .iter()
            .map(|message| message.body["text"].as_str().unwrap_or_default())
            .collect::<Vec<_>>(),
        ["It went well: every test passes."]
    );
    assert!(unreported(&h.app).is_empty());
}

#[tokio::test]
async fn a_topic_move_shows_both_rooms_and_announces_the_copy() {
    let h = harness();
    let target = room(&h.app, "slimeos");
    {
        let conn = h.app.db.lock();
        let first = conn
            .post_message(
                GENERAL_ROOM_ID,
                Speaker::User(ME),
                MessageKind::Text,
                &json!({ "text": "the parser broke" }),
            )
            .unwrap();
        let second = conn
            .post_message(
                GENERAL_ROOM_ID,
                Speaker::User(ME),
                MessageKind::Text,
                &json!({ "text": "fixed it" }),
            )
            .unwrap();
        moving::tag(
            &conn,
            GENERAL_ROOM_ID,
            &moving::Topic {
                name: "slimeos".into(),
                ..Default::default()
            },
            &[first.id, second.id],
            1,
        )
        .unwrap();
    }
    let (events, _subscription) = record(&h.app);
    let done = {
        let conn = h.app.db.lock();
        moving::move_room(&conn, GENERAL_ROOM_ID, &target, Some("slimeos")).unwrap()
    };
    moving::moved(&h.app, &done);
    // Every device sees the new room's line and its copy, in that order.
    let announced: Vec<Value> = events
        .lock()
        .unwrap()
        .iter()
        .filter(|event| event.kind == "room_message" && event.room_id == target)
        .map(|event| event.data["message"].clone())
        .collect();
    assert_eq!(announced.len(), 2, "the line and the copy");
    assert_eq!(announced[0]["body"]["move"]["direction"], "from");
    let copy = &announced[1]["body"]["quote"];
    assert_eq!(copy["from"]["name"], "general");
    assert_eq!(copy["messages"][0]["text"], "the parser broke");
    assert_eq!(copy["messages"][1]["text"], "fixed it");
    assert_eq!(copy["messages"][0]["speaker"], "user");
    assert_eq!(copy["messages"][0]["user"], ME);
    // And the old room hears where it went.
    assert!(
        events
            .lock()
            .unwrap()
            .iter()
            .any(|event| event.room_id == GENERAL_ROOM_ID
                && event.kind == "room_message"
                && event.data["message"]["body"]["move"]["direction"] == "to")
    );
}
