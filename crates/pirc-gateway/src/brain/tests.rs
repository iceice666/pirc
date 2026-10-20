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
use crate::db::rooms::{GENERAL_ROOM_ID, RoomInputStore, RoomStore};
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
    app.db
        .lock()
        .send_user_message(GENERAL_ROOM_ID, ME, text, &[], immediate)
        .unwrap();
    Brain::nudge(app);
}

fn host_messages(app: &AppState) -> Vec<crate::db::rooms::Message> {
    app.db
        .lock()
        .list_messages(GENERAL_ROOM_ID, None, 100)
        .unwrap()
        .into_iter()
        .filter(|message| message.speaker == "face:host")
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
    let replies = host_messages(&h.app);
    assert_eq!(replies.len(), 1);
    assert_eq!(replies[0].body, json!({ "text": "Hello there, friend" }));
    assert_eq!(replies[0].edited_at, None, "streaming is not editing");
    assert!(
        model.asked()[0]
            .messages
            .contains("me@example.com: hi brain")
    );
    let kinds: Vec<(String, Value)> = events
        .lock()
        .unwrap()
        .iter()
        .filter(|event| event.kind != "room_changed")
        .map(|event| (event.kind.clone(), event.data.clone()))
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
