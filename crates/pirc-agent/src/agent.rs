//! The agent (`agent/agent.ts`): queues, the run loop, model calls with
//! retries and role fallbacks, tool execution through the policy chain
//! (validation, hooks, auto mode, write lease), and the API the RPC layer
//! drives. Built-in features (todo, goal, …) hook in where the TS agent
//! called them (`crate::feature`).

use std::cell::{Cell, RefCell};
use std::rc::{Rc, Weak};
use std::time::Duration;

use indexmap::IndexMap;
use pirc_policy::PathGuard;
use pirc_protocol::{
    AssistantContent, AssistantMessage, Message, ModelRef, Models, StopReason, ThinkingLevel,
    ToolChoice, ToolSpec, UserBlock, UserContent,
};
use serde_json::{Map, Value, json};
use tokio::sync::Notify;

use crate::auto_mode::AutoMode;
use crate::capabilities::{Capabilities, capability_for_tool};
use crate::compaction::{self, CompactionReason, CompactionSettings};
use crate::config::{AgentConfig, session_settings};
use crate::context::{self, ContextInput, PromptSection, join_prompt, trim_sections};
use crate::feature::{BeforeStart, Feature, PromptAddition};
use crate::hooks::{HookName, HookRunner};
use crate::host::AgentHost;
use crate::messages::empty_usage;
use crate::ptc::{self, CapabilityRegistry, DIRECT_CAPABILITIES, WRAPPER_NAMES};
use crate::roles::{AgentRole, expand_models, read_roles};
use crate::rpc::Write;
use crate::session_store::{EntryData, SessionEntry, SessionStore};
use crate::signal::{AbortController, AbortSignal};
use crate::stream::{StreamFn, StreamRequest};
use crate::tools::{AcquireWrite, HumanWait, Tool, ToolContext, ToolResult};
use crate::ui::{Choice, DialogOptions, NotifyLevel, Ui};
use crate::{LocalBoxFuture, now_ms};

/// Session entry recording the role a session started in.
const ROLE_ENTRY: &str = "agent.role";
const RETRY_DELAYS: [u64; 3] = [2_000, 5_000, 15_000];
const INTERRUPTED_PARTIAL_CHARS: usize = 2000;

/// `AgentOptions`.
pub struct AgentOptions {
    pub config: AgentConfig,
    pub capabilities: Capabilities,
    /// A chat project's instructions from the node.
    pub project_instructions: Option<String>,
    /// A role from the configure line.
    pub role: Option<AgentRole>,
    pub store: SessionStore,
    /// Events and side-channel requests (stdout).
    pub emit: Write,
    pub ui: Rc<dyn Ui>,
    pub has_ui: bool,
    pub tools: Vec<Rc<dyn Tool>>,
    /// Built-in features, in hook order.
    pub features: Vec<Rc<dyn Feature>>,
    /// The write-lease transport (`processWriteLease`); `None` grants all.
    pub acquire_write: Option<AcquireWrite>,
    /// Only these capabilities (a restricted kind).
    pub allowed_tools: Option<Vec<String>>,
    /// Test seam: the model.
    pub stream_override: Option<Rc<dyn StreamFn>>,
}

/// Which queue `send_now` takes from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Queue {
    Steering,
    FollowUp,
}

/// Who named the session.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NameSource {
    User,
    Auto,
}

impl NameSource {
    fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Auto => "auto",
        }
    }
}

/// A message from outside the conversation (`deliver`).
#[derive(Clone, Debug, PartialEq)]
pub struct Delivery {
    pub custom_type: String,
    pub content: String,
    pub display: bool,
    pub details: Option<Value>,
}

/// `QueueItem`.
#[derive(Clone, Debug)]
enum QueueItem {
    User {
        text: String,
        images: Vec<UserBlock>,
    },
    Custom(Box<Message>),
}

/// `ResolvedModel`.
#[derive(Clone)]
pub struct ResolvedModel {
    pub provider_name: String,
    pub provider: pirc_protocol::Provider,
    pub model: pirc_protocol::Model,
}

/// Runs on the final reply just before its `message_end`; an error ends
/// the call without that `message_end` (TS: a throw out of `beforeEnd`).
pub type BeforeEnd = Box<dyn FnMut(&AssistantMessage) -> Result<(), String>>;

/// Options of one model call (`stream`'s options).
#[derive(Default)]
pub struct StreamOptions {
    /// Emit `message_*` events (default true).
    pub quiet: bool,
    pub max_tokens: Option<u64>,
    pub tool_choice: Option<ToolChoice>,
    /// Appended after the history, not persisted.
    pub extra_messages: Vec<Message>,
    /// Only context entries before this entry id.
    pub up_to: Option<String>,
    pub thinking: Option<ThinkingLevel>,
    /// `retries: false`.
    pub no_retries: bool,
    /// Persist the reply just before its `message_end`, so an event is never
    /// ahead of the session file.
    pub before_end: Option<BeforeEnd>,
}

/// `Agent`.
pub struct Agent {
    weak: Weak<Agent>,
    capabilities: RefCell<Capabilities>,
    project_instructions: Option<String>,
    role: RefCell<Option<AgentRole>>,
    config: Rc<AgentConfig>,
    /// The gateway's live public catalog (`refreshModels` replaces it).
    models: RefCell<Models>,
    store: RefCell<SessionStore>,
    guard: Rc<PathGuard>,
    hooks: HookRunner,
    auto_mode: AutoMode,
    /// The UI with dialogs linked to the operation that opens them.
    ui: Rc<dyn Ui>,
    has_ui: bool,
    emit_raw: Write,
    /// Internal capabilities, by name.
    tools: RefCell<IndexMap<String, Rc<dyn Tool>>>,
    /// `ptc` and `ptc_docs`.
    wrappers: RefCell<IndexMap<String, Rc<dyn Tool>>>,
    registry: CapabilityRegistry,
    stream_override: Option<Rc<dyn StreamFn>>,
    write_lease: Option<AcquireWrite>,
    steering: RefCell<Vec<QueueItem>>,
    follow_ups: RefCell<Vec<QueueItem>>,
    running: Cell<bool>,
    /// A run task is alive (`runPromise`).
    run_active: Cell<bool>,
    run_done: Notify,
    controller: RefCell<Option<AbortController>>,
    /// Aborts only the current model call and tool batch.
    turn: RefCell<Option<AbortController>>,
    /// `sendNow` arrived between turns.
    interrupt_pending: Cell<bool>,
    extra_system_prompt: RefCell<String>,
    /// What features added to the system prompt for the latest run.
    run_prompt: RefCell<Vec<PromptSection>>,
    last_context: RefCell<Option<Value>>,
    compacting: RefCell<Option<AbortController>>,
    closed: Cell<bool>,
    model_ref: RefCell<Option<(String, String)>>,
    thinking: Cell<ThinkingLevel>,
    session_name: RefCell<Option<String>>,
    name_source: Cell<Option<NameSource>>,
    /// Side-panel sections changed since the last flush (`panelChanged`).
    changed_sections: RefCell<Vec<String>>,
    /// Flushes the TS agent would have queued as microtasks by now.
    scheduled_flushes: Cell<usize>,
    /// The direct tool call running now (`operationScope`); dialogs carry it.
    current_operation: RefCell<Option<String>>,
    features: Vec<Rc<dyn Feature>>,
    /// Wakes [`Agent::wait_for_completion`] (`completionWake`).
    completion_wake: Notify,
    completion_waiting: RefCell<Vec<String>>,
    completion_revision: Cell<u64>,
    /// Dialogs and other waits for a human now open (`openDialogs`).
    open_dialogs: Cell<usize>,
    human_wait_listeners: RefCell<Vec<(u64, HumanWaitListener)>>,
    next_listener: Cell<u64>,
    /// Capabilities started by `ptc` executions still running, one set per
    /// execution (`runningScripts`): their results are not in the session
    /// yet, so features that judge where content came from (memory
    /// provenance) consult this too.
    running_scripts: RefCell<Vec<ScriptCapabilities>>,
}

/// Told whether a human is being asked (`onHumanWait`).
pub type HumanWaitListener = Rc<dyn Fn(bool)>;

/// The capability names one running `ptc` execution started.
pub type ScriptCapabilities = Rc<RefCell<Vec<String>>>;

/// `sanitizeHistory`: every tool call has a result and no result is
/// orphaned, so providers accept the history.
pub fn sanitize_history(messages: &[Message]) -> Vec<Message> {
    let mut out = Vec::with_capacity(messages.len());
    let mut open: IndexMap<String, String> = IndexMap::new();
    let flush = |out: &mut Vec<Message>, open: &mut IndexMap<String, String>| {
        for (id, name) in open.drain(..) {
            out.push(Message::ToolResult {
                tool_call_id: id,
                tool_name: name,
                content: vec![UserBlock::Text {
                    text: "Tool call was interrupted before producing a result.".to_owned(),
                    text_signature: None,
                }],
                details: None,
                is_error: true,
                timestamp: now_ms(),
            });
        }
    };
    for message in messages {
        if let Message::ToolResult { tool_call_id, .. } = message {
            if open.shift_remove(tool_call_id).is_none() {
                continue;
            }
            out.push(message.clone());
            continue;
        }
        flush(&mut out, &mut open);
        out.push(message.clone());
        if let Message::Assistant(assistant) = message
            && !matches!(
                assistant.stop_reason,
                StopReason::Error | StopReason::Aborted
            )
        {
            for part in &assistant.content {
                if let AssistantContent::ToolCall { id, name, .. } = part {
                    open.insert(id.clone(), name.clone());
                }
            }
        }
    }
    flush(&mut out, &mut open);
    out
}

/// JavaScript's `String.prototype.length` slicing, by UTF-16 units.
fn slice16(text: &str, max: usize) -> (String, bool) {
    let mut units = 0;
    let mut out = String::new();
    for c in text.chars() {
        units += c.len_utf16();
        if units > max {
            return (out, true);
        }
        out.push(c);
    }
    (out, false)
}

/// `interruptedNote`: tell the model its reply was cut off by the user.
fn interrupted_note(message: &AssistantMessage) -> QueueItem {
    let partial: String = message
        .content
        .iter()
        .filter_map(|part| match part {
            AssistantContent::Text { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    let partial = js_trim(&partial);
    let (mut shown, cut) = slice16(partial, INTERRUPTED_PARTIAL_CHARS);
    if cut {
        shown.push('…');
    }
    let content = if shown.is_empty() {
        "[Your previous response was interrupted by the user before it produced any text.]"
            .to_owned()
    } else {
        format!("[Your previous response was interrupted by the user.] Partial output:\n\n{shown}")
    };
    QueueItem::Custom(Box::new(Message::Custom {
        custom_type: "interrupted".to_owned(),
        content,
        display: false,
        details: None,
        timestamp: now_ms(),
    }))
}

/// `/name args` (`/^\/([a-z][\w:-]*)(?:\s+([\s\S]*))?$/i` on the trimmed
/// text): the name and the trimmed arguments.
fn parse_command(text: &str) -> Option<(String, String)> {
    use std::sync::LazyLock;
    static COMMAND: LazyLock<regex_lite::Regex> = LazyLock::new(|| {
        regex_lite::Regex::new(
            r"(?s)^/([A-Za-z][A-Za-z0-9_:-]*)(?:[\t\n\x0B\x0C\r \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]+(.*))?$",
        )
        .unwrap()
    });
    let found = COMMAND.captures(js_trim(text))?;
    let name = found.get(1).map_or("", |m| m.as_str()).to_owned();
    let args = js_trim(found.get(2).map_or("", |m| m.as_str())).to_owned();
    Some((name, args))
}

/// `String.prototype.trim`.
fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}')
}

/// `lenientArgs`: a direct call's arguments as `main` accepted them before
/// schemas were checked: null for an optional argument means absent, and a
/// closed schema ignores unknown keys.
pub fn lenient_args(tool: Option<&Rc<dyn Tool>>, args: &Map<String, Value>) -> Map<String, Value> {
    let Some(tool) = tool else {
        return args.clone();
    };
    let schema = tool.parameters();
    let Some(properties) = schema.get("properties").and_then(Value::as_object) else {
        return args.clone();
    };
    if args.contains_key("__invalid_json") {
        return args.clone();
    }
    let required: Vec<&str> = schema
        .get("required")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let closed = schema.get("additionalProperties") == Some(&Value::Bool(false));
    args.iter()
        .filter(|(key, value)| {
            !(value.is_null() && !required.contains(&key.as_str()))
                && (!closed || properties.contains_key(*key))
        })
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

fn text_block(text: impl Into<String>) -> UserBlock {
    UserBlock::Text {
        text: text.into(),
        text_signature: None,
    }
}

fn thinking_name(level: ThinkingLevel) -> &'static str {
    match level {
        ThinkingLevel::Off => "off",
        ThinkingLevel::Minimal => "minimal",
        ThinkingLevel::Low => "low",
        ThinkingLevel::Medium => "medium",
        ThinkingLevel::High => "high",
        ThinkingLevel::Xhigh => "xhigh",
    }
}

fn parse_thinking(level: &str) -> Option<ThinkingLevel> {
    serde_json::from_value(json!(level)).ok()
}

/// Waits until a run has ended (`idle`).
async fn sleep_or_abort(ms: u64, signal: &AbortSignal) {
    tokio::select! {
        () = tokio::time::sleep(Duration::from_millis(ms)) => {}
        () = signal.cancelled() => {}
    }
}

/// The UI with dialogs linked to the direct tool call that opens them and
/// counted as waits for a human (`trackDialogs`), so a running `ptc`
/// script's active-time budget pauses while a human answers.
struct TrackingUi {
    inner: Rc<dyn Ui>,
    agent: Weak<Agent>,
}

impl TrackingUi {
    /// The linked options, and the wait counted from now until the dialog's
    /// future is done (or dropped).
    fn link(&self, mut opts: DialogOptions) -> (DialogOptions, HumanWait) {
        let Some(agent) = self.agent.upgrade() else {
            return (opts, HumanWait::none());
        };
        if opts.tool_call_id.is_none() {
            opts.tool_call_id = agent.current_operation.borrow().clone();
        }
        (opts, agent.human_wait())
    }
}

/// `future`, holding `wait` until it is done.
fn while_waiting<'a, T: 'a>(
    future: LocalBoxFuture<'a, T>,
    wait: HumanWait,
) -> LocalBoxFuture<'a, T> {
    Box::pin(async move {
        let value = future.await;
        drop(wait);
        value
    })
}

impl Ui for TrackingUi {
    fn select<'a>(
        &'a self,
        title: &'a str,
        options: &'a [String],
        opts: DialogOptions,
    ) -> LocalBoxFuture<'a, Option<String>> {
        let (opts, wait) = self.link(opts);
        while_waiting(self.inner.select(title, options, opts), wait)
    }
    fn choose<'a>(
        &'a self,
        title: &'a str,
        options: &'a [Choice],
        multiple: bool,
        opts: DialogOptions,
    ) -> LocalBoxFuture<'a, Option<Vec<String>>> {
        let (opts, wait) = self.link(opts);
        while_waiting(self.inner.choose(title, options, multiple, opts), wait)
    }
    fn confirm<'a>(
        &'a self,
        title: &'a str,
        message: &'a str,
        opts: DialogOptions,
    ) -> LocalBoxFuture<'a, Option<bool>> {
        let (opts, wait) = self.link(opts);
        while_waiting(self.inner.confirm(title, message, opts), wait)
    }
    fn input<'a>(
        &'a self,
        title: &'a str,
        placeholder: Option<&'a str>,
        opts: DialogOptions,
    ) -> LocalBoxFuture<'a, Option<String>> {
        let (opts, wait) = self.link(opts);
        while_waiting(self.inner.input(title, placeholder, opts), wait)
    }
    fn editor<'a>(
        &'a self,
        title: &'a str,
        prefill: Option<&'a str>,
        opts: DialogOptions,
    ) -> LocalBoxFuture<'a, Option<String>> {
        let (opts, wait) = self.link(opts);
        while_waiting(self.inner.editor(title, prefill, opts), wait)
    }
    fn notify(&self, message: &str, level: NotifyLevel) {
        self.inner.notify(message, level);
    }
    fn set_status(&self, key: &str, text: Option<&str>) {
        self.inner.set_status(key, text);
    }
    fn set_widget(&self, key: &str, lines: Option<&[String]>) {
        self.inner.set_widget(key, lines);
    }
}

/// Clears `compacting` when dropped.
struct CompactingGuard<'a>(&'a RefCell<Option<AbortController>>);

impl Drop for CompactingGuard<'_> {
    fn drop(&mut self) {
        *self.0.borrow_mut() = None;
    }
}

/// How far a capability call got (`OperationStage`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OperationStage {
    Unavailable,
    Invalid,
    Denied,
    Refused,
    Cancelled,
    Threw,
    Executed,
}

impl Agent {
    pub fn new(options: AgentOptions) -> Rc<Self> {
        let config = Rc::new(options.config);
        let guard = Rc::new(PathGuard::new(
            &config.workspace,
            &config.path_policy,
            &config.protected_paths,
        ));
        let session_id = options.store.session_id();
        let agent = Rc::new_cyclic(|weak: &Weak<Agent>| {
            let ui: Rc<dyn Ui> = Rc::new(TrackingUi {
                inner: options.ui.clone(),
                agent: weak.clone(),
            });
            let warn_ui = options.ui.clone();
            let mut base = Map::new();
            base.insert("sessionId".to_owned(), json!(session_id));
            base.insert("cwd".to_owned(), json!(config.workspace));
            let hooks = HookRunner::new(
                config.hooks.clone(),
                config.workspace.clone(),
                config.env.clone(),
                base,
                Rc::new(move |message: &str| warn_ui.notify(message, NotifyLevel::Warning)),
            );
            let mut tools = IndexMap::new();
            for tool in options.tools {
                if !WRAPPER_NAMES.contains(&tool.name()) {
                    tools.insert(tool.name().to_owned(), tool);
                }
            }
            Agent {
                weak: weak.clone(),
                capabilities: RefCell::new(options.capabilities),
                project_instructions: options.project_instructions,
                role: RefCell::new(options.role),
                models: RefCell::new(config.models.clone()),
                config: config.clone(),
                store: RefCell::new(options.store),
                guard,
                hooks,
                auto_mode: AutoMode::new(),
                ui,
                has_ui: options.has_ui,
                emit_raw: options.emit,
                tools: RefCell::new(tools),
                wrappers: RefCell::new(IndexMap::new()),
                registry: CapabilityRegistry::new(session_id.clone()),
                stream_override: options.stream_override,
                write_lease: options.acquire_write,
                steering: RefCell::new(Vec::new()),
                follow_ups: RefCell::new(Vec::new()),
                running: Cell::new(false),
                run_active: Cell::new(false),
                run_done: Notify::new(),
                controller: RefCell::new(None),
                turn: RefCell::new(None),
                interrupt_pending: Cell::new(false),
                extra_system_prompt: RefCell::new(String::new()),
                run_prompt: RefCell::new(Vec::new()),
                last_context: RefCell::new(None),
                compacting: RefCell::new(None),
                closed: Cell::new(false),
                model_ref: RefCell::new(None),
                thinking: Cell::new(ThinkingLevel::Medium),
                session_name: RefCell::new(None),
                name_source: Cell::new(None),
                changed_sections: RefCell::new(Vec::new()),
                scheduled_flushes: Cell::new(0),
                current_operation: RefCell::new(None),
                features: options.features,
                completion_wake: Notify::new(),
                completion_waiting: RefCell::new(Vec::new()),
                completion_revision: Cell::new(0),
                open_dialogs: Cell::new(0),
                human_wait_listeners: RefCell::new(Vec::new()),
                next_listener: Cell::new(0),
                running_scripts: RefCell::new(Vec::new()),
            }
        });
        // The wrappers are never capabilities: no recursive dispatch.
        for feature in agent.features.clone() {
            for tool in feature.tools(&agent) {
                if !WRAPPER_NAMES.contains(&tool.name()) {
                    agent
                        .tools
                        .borrow_mut()
                        .insert(tool.name().to_owned(), tool);
                }
            }
        }
        let host: Weak<dyn AgentHost> = {
            let weak: Weak<Agent> = Rc::downgrade(&agent);
            weak
        };
        for tool in ptc::model_tools(host) {
            agent
                .wrappers
                .borrow_mut()
                .insert(tool.name().to_owned(), tool);
        }
        if let Some(allowed) = options.allowed_tools {
            agent.restrict_tools(&allowed);
        }
        agent.restore_settings();
        // A session started in a role keeps its role (and allowlist) on restart.
        if let Some((role, tools)) = agent.recorded_role()
            && agent.role.borrow().is_none()
        {
            *agent.role.borrow_mut() = Some(role);
            if let Some(tools) = tools {
                agent.restrict_tools(&tools);
            }
        }
        agent
    }

    /// `emit`: nothing once shut down.
    pub fn emit(&self, event: Value) {
        if !self.closed.get() {
            (self.emit_raw)(event);
        }
    }

    pub fn config(&self) -> Rc<AgentConfig> {
        self.config.clone()
    }

    /// Notify the user (`ui.notify`), e.g. the config's warnings.
    pub fn notify_warning(&self, message: &str) {
        self.ui.notify(message, NotifyLevel::Warning);
    }

    /// `init`: the `sessionStart` hooks, then the features'; `Err` ends the
    /// agent at startup.
    pub async fn init(self: &Rc<Self>) -> Result<(), String> {
        let extra = self.hooks.collect(HookName::SessionStart, Map::new()).await;
        *self.extra_system_prompt.borrow_mut() = extra;
        for feature in self.features.clone() {
            feature.init(self).await?;
        }
        Ok(())
    }

    fn restore_settings(&self) {
        let branch = self.store.borrow().branch();
        let (model, thinking) = {
            let models = self.models.borrow();
            session_settings(&branch, self.config.default_model.as_ref(), &models)
        };
        if model.is_some() {
            *self.model_ref.borrow_mut() = model;
        }
        self.thinking.set(thinking);
        if let Some(entry) = branch
            .iter()
            .rev()
            .find(|entry| matches!(entry.data, EntryData::SessionInfo { .. }))
            && let EntryData::SessionInfo { name, source } = &entry.data
        {
            *self.session_name.borrow_mut() = Some(name.clone());
            self.name_source
                .set(Some(if source.as_deref() == Some("auto") {
                    NameSource::Auto
                } else {
                    NameSource::User
                }));
        }
    }

    pub fn is_running(&self) -> bool {
        self.running.get()
    }

    /// Queued items, user and custom (`pendingCount`).
    pub fn pending_count(&self) -> usize {
        self.steering.borrow().len() + self.follow_ups.borrow().len()
    }

    /// The built-in features this agent runs, in hook order.
    pub fn features(&self) -> &[Rc<dyn Feature>] {
        &self.features
    }

    /// Some feature will start another run after this one settles
    /// (`Feature::will_continue`).
    pub fn will_continue(self: &Rc<Self>) -> bool {
        self.features
            .iter()
            .any(|feature| feature.will_continue(self))
    }

    /// Feature state changed: recheck completion without polling or calling
    /// the model (`completionChanged`).
    pub fn completion_changed(&self) {
        self.completion_revision
            .set(self.completion_revision.get() + 1);
        self.completion_wake.notify_waiters();
    }

    /// Remove only matching queued custom notifications; never human input
    /// (`discardNotifications`).
    pub fn discard_notifications(&self, predicate: impl Fn(&Message) -> bool) {
        let keep = |item: &QueueItem| match item {
            QueueItem::Custom(message) => !predicate(message),
            QueueItem::User { .. } => true,
        };
        self.steering.borrow_mut().retain(keep);
        self.follow_ups.borrow_mut().retain(keep);
    }

    /// `teamBatchSize`: how many adjacent team events lead the follow-up
    /// queue (at most 50, and past the first at most 40,000 bytes); a human
    /// follow-up is never reordered.
    fn team_batch_size(&self) -> usize {
        let follow_ups = self.follow_ups.borrow();
        let mut count = 0;
        let mut bytes = 0;
        while count < 50 {
            let Some(QueueItem::Custom(message)) = follow_ups.get(count) else {
                break;
            };
            if !matches!(&**message, Message::Custom { custom_type, .. } if custom_type == "agent-team")
            {
                break;
            }
            bytes +=
                crate::tools::js::stringify(&serde_json::to_value(&**message).unwrap_or_default())
                    .len();
            if count > 0 && bytes > 40_000 {
                break;
            }
            count += 1;
        }
        count
    }

    /// `waitForCompletion`: while features report blockers (team workers),
    /// wait for a change, up to `limits.completionWaitMs`; then tell the
    /// model what is still pending. True when the wait timed out.
    async fn wait_for_completion(self: &Rc<Self>, signal: &AbortSignal) -> bool {
        let deadline = tokio::time::Instant::now()
            + Duration::from_millis(self.config.limits.completion_wait_ms);
        let timed_out = loop {
            if signal.aborted() || self.pending_count() > 0 {
                break false;
            }
            let revision = self.completion_revision.get();
            let blockers: Vec<String> = self
                .features
                .iter()
                .flat_map(|feature| feature.completion_blockers(self))
                .collect();
            if blockers.is_empty() {
                break false;
            }
            *self.completion_waiting.borrow_mut() = blockers.clone();
            self.ui.set_status(
                "completion-wait",
                Some(&format!("Waiting for team: {}", blockers.join(", "))),
            );
            if tokio::time::Instant::now() >= deadline {
                let _ = self.deliver(
                    Delivery {
                        custom_type: "completion-timeout".to_owned(),
                        content: format!(
                            "Team completion wait timed out. These workers have NOT completed: {}. Report the pending work honestly; do not claim completion. Workers were not stopped.",
                            blockers.join(", ")
                        ),
                        display: true,
                        details: None,
                    },
                    false,
                    true,
                );
                break true;
            }
            let woken = self.completion_wake.notified();
            if signal.aborted()
                || self.pending_count() > 0
                || revision != self.completion_revision.get()
            {
                continue;
            }
            tokio::select! {
                () = woken => {}
                () = tokio::time::sleep_until(deadline.max(tokio::time::Instant::now() + Duration::from_millis(1))) => {}
                () = signal.cancelled() => {}
            }
        };
        if !self.completion_waiting.borrow().is_empty() {
            self.ui.set_status("completion-wait", None);
        }
        self.completion_waiting.borrow_mut().clear();
        timed_out
    }

    /// Start a wait for a human (`humanWait`); it ends when the guard drops.
    pub fn human_wait(&self) -> HumanWait {
        let agent = self.weak.clone();
        HumanWait::new(Rc::new(move |delta: isize| {
            if let Some(agent) = agent.upgrade() {
                agent.human_wait_changed(delta);
            }
        }))
    }

    fn human_wait_changed(&self, delta: isize) {
        let before = self.open_dialogs.get() > 0;
        self.open_dialogs
            .set(self.open_dialogs.get().saturating_add_signed(delta));
        let after = self.open_dialogs.get() > 0;
        if before != after {
            let listeners: Vec<Rc<dyn Fn(bool)>> = self
                .human_wait_listeners
                .borrow()
                .iter()
                .map(|(_, listener)| listener.clone())
                .collect();
            for listener in listeners {
                listener(after);
            }
        }
    }

    /// Listen for "a human is being asked" (`onHumanWait`); told at once if
    /// one is. The id unsubscribes ([`Agent::off_human_wait`]).
    pub fn on_human_wait(&self, listener: Rc<dyn Fn(bool)>) -> u64 {
        let id = self.next_listener.get();
        self.next_listener.set(id + 1);
        self.human_wait_listeners
            .borrow_mut()
            .push((id, listener.clone()));
        if self.open_dialogs.get() > 0 {
            listener(true);
        }
        id
    }

    pub fn off_human_wait(&self, id: u64) {
        self.human_wait_listeners
            .borrow_mut()
            .retain(|(listener, _)| *listener != id);
    }

    /// Record a running `ptc` execution's capabilities (`runningScripts.add`).
    pub fn add_running_script(&self, names: ScriptCapabilities) {
        self.running_scripts.borrow_mut().push(names);
    }

    /// `runningScripts.delete`.
    pub fn remove_running_script(&self, names: &ScriptCapabilities) {
        self.running_scripts
            .borrow_mut()
            .retain(|item| !Rc::ptr_eq(item, names));
    }

    /// Capability names started by `ptc` executions still running.
    pub fn running_script_capabilities(&self) -> Vec<String> {
        self.running_scripts
            .borrow()
            .iter()
            .flat_map(|names| names.borrow().clone())
            .collect()
    }

    /// The session's current branch (`store.branch()`).
    pub fn branch(&self) -> Vec<SessionEntry> {
        self.store.borrow().branch()
    }

    /// Append a session entry (`store.append`); `Err` with the file
    /// system's error text.
    pub fn append_entry(&self, data: EntryData) -> Result<SessionEntry, String> {
        self.store.borrow_mut().append(data)
    }

    /// The newest entry of a type on the branch (`store.latest`).
    pub fn latest_entry(&self, type_name: &str) -> Option<SessionEntry> {
        self.store.borrow().latest(type_name)
    }

    /// Custom entries of a type on the branch (`store.customEntries`).
    pub fn custom_entries(&self, custom_type: &str) -> Vec<SessionEntry> {
        self.store.borrow().custom_entries(custom_type)
    }

    /// The session directory (`store.dir`).
    pub fn session_dir(&self) -> std::path::PathBuf {
        self.store.borrow().dir.clone()
    }

    /// The session file (`store.file`).
    pub fn session_file(&self) -> std::path::PathBuf {
        self.store.borrow().file.clone()
    }

    /// The gateway's policy for this project (`capabilities`).
    pub fn capabilities(&self) -> Capabilities {
        self.capabilities.borrow().clone()
    }

    /// The path guard (`guard`).
    pub fn path_guard(&self) -> Rc<PathGuard> {
        self.guard.clone()
    }

    /// The capability registry (`capabilityRegistry`).
    pub fn registry(&self) -> &CapabilityRegistry {
        &self.registry
    }

    /// The current thinking level.
    pub fn thinking(&self) -> ThinkingLevel {
        self.thinking.get()
    }

    /// `isCompacting`.
    pub fn is_compacting(&self) -> bool {
        self.compacting.borrow().is_some()
    }

    /// Whether a human can answer dialogs (`hasUI`).
    pub fn has_ui(&self) -> bool {
        self.has_ui
    }

    /// `getTool`: a capability, unless the gateway's policy disables it.
    pub fn get_tool(&self, name: &str) -> Option<Rc<dyn Tool>> {
        if let Some(capability) = capability_for_tool(name)
            && !self.capabilities.borrow().allows(capability)
        {
            return None;
        }
        self.tools.borrow().get(name).cloned()
    }

    /// `toolList`: available internal capabilities.
    pub fn available_tools(&self) -> Vec<Rc<dyn Tool>> {
        let names: Vec<String> = self.tools.borrow().keys().cloned().collect();
        names
            .iter()
            .filter_map(|name| self.get_tool(name))
            .collect()
    }

    /// `directToolList`.
    pub fn direct_tools(&self) -> Vec<Rc<dyn Tool>> {
        DIRECT_CAPABILITIES
            .iter()
            .filter_map(|name| {
                let tool = self.get_tool(name)?;
                let same = self
                    .tools
                    .borrow()
                    .get(*name)
                    .is_some_and(|own| Rc::ptr_eq(own, &tool));
                same.then_some(tool)
            })
            .collect()
    }

    /// `modelToolList`: `ptc` and `ptc_docs` when any capability is
    /// available, then the direct core capabilities.
    fn model_tool_list(&self) -> Vec<Rc<dyn Tool>> {
        if self.available_tools().is_empty() {
            return Vec::new();
        }
        let mut list: Vec<Rc<dyn Tool>> = self.wrappers.borrow().values().cloned().collect();
        list.extend(self.direct_tools());
        list
    }

    /// `resolveModel`.
    pub fn resolve_model(
        &self,
        reference: Option<(String, String)>,
    ) -> Result<ResolvedModel, String> {
        let reference = reference.or_else(|| self.model_ref.borrow().clone());
        let Some((provider_name, id)) = reference else {
            return Err("No model configured. Add providers to the gateway models.json".to_owned());
        };
        let models = self.models.borrow();
        let provider = models.providers.get(&provider_name);
        let model = provider.and_then(|p| p.models.iter().find(|m| m.id == id));
        match (provider, model) {
            (Some(provider), Some(model)) => Ok(ResolvedModel {
                provider_name,
                provider: provider.clone(),
                model: model.clone(),
            }),
            _ => Err(format!("Unknown model {provider_name}/{id}")),
        }
    }

    /// `availableModels`: `listModels(config.models)`.
    pub fn available_models(&self) -> Vec<Value> {
        let models = self.models.borrow();
        models
            .providers
            .iter()
            .flat_map(|(provider, config)| {
                config.models.iter().map(move |model| {
                    json!({ "provider": provider, "id": model.id,
                        "name": model.name.as_ref().unwrap_or(&model.id),
                        "contextWindow": model.context_window, "maxTokens": model.max_tokens,
                        "reasoning": model.reasoning, "input": model.input })
                })
            })
            .collect()
    }

    /// `state()` (`get_state`).
    pub fn state(&self) -> Value {
        let model = self.resolve_model(None).ok().map(|resolved| {
            json!({ "provider": resolved.provider_name, "id": resolved.model.id,
                "name": resolved.model.name.as_ref().unwrap_or(&resolved.model.id),
                "contextWindow": resolved.model.context_window,
                "reasoning": resolved.model.reasoning })
        });
        let store = self.store.borrow();
        json!({
            "sessionId": store.session_id(),
            "sessionFile": store.file.display().to_string(),
            "sessionName": *self.session_name.borrow(),
            "sessionNameSource": self.name_source.get().map(NameSource::as_str),
            "model": model,
            "thinkingLevel": thinking_name(self.thinking.get()),
            "isStreaming": self.running.get(),
            "completionWaiting": *self.completion_waiting.borrow(),
            "isCompacting": self.compacting.borrow().is_some(),
            "messageCount": store.all_messages().len(),
            "pendingMessageCount": self.pending_count(),
        })
    }

    /// Append a session entry; `Err` with the file system's error text.
    fn append(&self, data: EntryData) -> Result<String, String> {
        self.store.borrow_mut().append(data).map(|entry| entry.id)
    }

    pub fn set_model(&self, provider: &str, id: &str) -> Result<(), String> {
        self.resolve_model(Some((provider.to_owned(), id.to_owned())))?;
        *self.model_ref.borrow_mut() = Some((provider.to_owned(), id.to_owned()));
        self.append(EntryData::ModelChange {
            provider: provider.to_owned(),
            model_id: id.to_owned(),
        })?;
        Ok(())
    }

    /// `restrictTools`: keep only the named capabilities.
    fn restrict_tools(&self, names: &[String]) {
        let ignored: Vec<&String> = names
            .iter()
            .filter(|name| WRAPPER_NAMES.contains(&name.as_str()))
            .collect();
        let unknown: Vec<&String> = names
            .iter()
            .filter(|name| {
                !WRAPPER_NAMES.contains(&name.as_str()) && !self.tools.borrow().contains_key(*name)
            })
            .collect();
        self.tools
            .borrow_mut()
            .retain(|name, _| names.iter().any(|allowed| allowed == name));
        let unique = |items: Vec<&String>| {
            let mut out: Vec<&str> = Vec::new();
            for item in items {
                if !out.contains(&item.as_str()) {
                    out.push(item);
                }
            }
            out.join(", ")
        };
        if !ignored.is_empty() {
            self.ui.notify(
                &format!(
                    "Tool list: {} ignored; ptc and ptc_docs come with any capability",
                    unique(ignored)
                ),
                NotifyLevel::Warning,
            );
        }
        if !unknown.is_empty() {
            self.ui.notify(
                &format!(
                    "Tool list: unknown or unavailable capabilities {} grant nothing",
                    unique(unknown)
                ),
                NotifyLevel::Warning,
            );
        }
    }

    /// The role recorded on the branch, with its tool allowlist.
    fn recorded_role(&self) -> Option<(AgentRole, Option<Vec<String>>)> {
        let branch = self.store.borrow().branch();
        let data = branch.iter().rev().find_map(|entry| match &entry.data {
            EntryData::Custom { custom_type, data } if custom_type == ROLE_ENTRY => Some(data),
            _ => None,
        })?;
        let name = data.get("name")?.as_str()?.to_owned();
        let strings = |value: Option<&Value>| -> Option<Vec<String>> {
            value?.as_array().map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str().map(str::to_owned))
                    .collect()
            })
        };
        Some((
            AgentRole {
                name,
                instructions: data
                    .get("instructions")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                models: strings(data.get("models")),
            },
            strings(data.get("tools")),
        ))
    }

    /// `nextFallback`: the next catalog model after the current one along
    /// the role's model patterns.
    fn next_fallback(&self) -> Option<(String, String)> {
        let patterns = self.role.borrow().as_ref()?.models.clone()?;
        if patterns.is_empty() {
            return None;
        }
        let (provider, id) = self.model_ref.borrow().clone()?;
        let candidates = expand_models(&patterns, &self.models.borrow());
        match candidates
            .iter()
            .position(|(p, m)| *p == provider && *m == id)
        {
            Some(index) => candidates.get(index + 1).cloned(),
            None => {
                let known = self
                    .models
                    .borrow()
                    .providers
                    .get(&provider)
                    .is_some_and(|p| p.models.iter().any(|m| m.id == id));
                if known {
                    None
                } else {
                    candidates.first().cloned()
                }
            }
        }
    }

    /// `fallBack`: switch to the next fallback model; false when none. A
    /// failure to record the switch ends the call (TS: `setModel` throws).
    fn fall_back(&self, reason: &str) -> Result<bool, String> {
        let Some((provider, id)) = self.next_fallback() else {
            return Ok(false);
        };
        let from = self
            .model_ref
            .borrow()
            .as_ref()
            .map_or_else(|| "none".to_owned(), |(p, m)| format!("{p}/{m}"));
        self.set_model(&provider, &id)?;
        let (reason, _) = slice16(reason, 200);
        self.ui.notify(
            &format!("Model {from} failed ({reason}); switching to {provider}/{id}"),
            NotifyLevel::Warning,
        );
        Ok(true)
    }

    /// `setRole`: start this session in one of the workspace's roles.
    pub fn set_role(&self, name: &str) -> Result<(), String> {
        let current = self
            .role
            .borrow()
            .clone()
            .or_else(|| self.recorded_role().map(|(role, _)| role));
        if let Some(current) = current {
            if current.name == name {
                return Ok(());
            }
            return Err(format!(
                "This session already runs in role {}",
                current.name
            ));
        }
        if self
            .store
            .borrow()
            .branch()
            .iter()
            .any(|entry| matches!(entry.data, EntryData::Message(_)))
        {
            return Err("A role can only be set before the session starts".to_owned());
        }
        let roles = read_roles(&self.config.role_dirs)?;
        let Some(preset) = roles.get(name).cloned() else {
            let available: Vec<&str> = roles.keys().map(String::as_str).collect();
            return Err(format!(
                "Unknown role: {name}; available: {}",
                available.join(", ")
            ));
        };
        if let Some(patterns) = &preset.models {
            let candidates = expand_models(patterns, &self.models.borrow());
            let Some((provider, id)) = candidates.first().cloned() else {
                return Err(format!(
                    "No model matches role {name}: {}",
                    patterns.join(", ")
                ));
            };
            self.set_model(&provider, &id)?;
        }
        if let Some(thinking) = &preset.thinking {
            self.set_thinking(if thinking == "max" { "xhigh" } else { thinking })?;
        }
        let mut data = Map::new();
        data.insert("name".to_owned(), json!(name));
        if let Some(instructions) = &preset.instructions {
            data.insert("instructions".to_owned(), json!(instructions));
        }
        if let Some(tools) = &preset.tools {
            data.insert("tools".to_owned(), json!(tools));
        }
        if let Some(models) = &preset.models {
            data.insert("models".to_owned(), json!(models));
        }
        self.append(EntryData::Custom {
            custom_type: ROLE_ENTRY.to_owned(),
            data: Value::Object(data),
        })?;
        *self.role.borrow_mut() = Some(AgentRole {
            name: name.to_owned(),
            instructions: preset.instructions.clone(),
            models: preset.models.clone(),
        });
        if let Some(tools) = &preset.tools {
            self.restrict_tools(tools);
        }
        Ok(())
    }

    pub fn set_thinking(&self, level: &str) -> Result<(), String> {
        let parsed =
            parse_thinking(level).ok_or_else(|| format!("Unknown thinking level {level}"))?;
        self.thinking.set(parsed);
        self.append(EntryData::ThinkingLevelChange {
            thinking_level: level.to_owned(),
        })?;
        Ok(())
    }

    pub fn session_name(&self) -> Option<String> {
        self.session_name.borrow().clone()
    }

    pub fn set_name(&self, name: &str, source: NameSource) -> Result<(), String> {
        if self.session_name.borrow().as_deref() == Some(name)
            && self.name_source.get() == Some(source)
        {
            return Ok(());
        }
        *self.session_name.borrow_mut() = Some(name.to_owned());
        self.name_source.set(Some(source));
        self.append(EntryData::SessionInfo {
            name: name.to_owned(),
            source: Some(source.as_str().to_owned()),
        })?;
        self.emit(json!({ "type": "session_name_changed", "name": name,
            "source": source.as_str() }));
        Ok(())
    }

    fn queue_texts(items: &[QueueItem]) -> Vec<String> {
        items
            .iter()
            .filter_map(|item| match item {
                QueueItem::User { text, .. } => Some(text.clone()),
                QueueItem::Custom(_) => None,
            })
            .collect()
    }

    fn emit_queue(&self) {
        let steering = Self::queue_texts(&self.steering.borrow());
        let follow_up = Self::queue_texts(&self.follow_ups.borrow());
        self.emit(json!({ "type": "queue_update", "steering": steering, "followUp": follow_up }));
    }

    /// `clearQueue`: `{steering, followUp}` texts.
    pub fn clear_queue(self: &Rc<Self>) -> Value {
        let cleared = json!({ "steering": Self::queue_texts(&self.steering.borrow()),
            "followUp": Self::queue_texts(&self.follow_ups.borrow()) });
        let notifications: Vec<Message> = self
            .steering
            .borrow()
            .iter()
            .chain(self.follow_ups.borrow().iter())
            .filter_map(|item| match item {
                QueueItem::Custom(message) => Some((**message).clone()),
                QueueItem::User { .. } => None,
            })
            .collect();
        for feature in &self.features {
            feature.notifications_cleared(self, &notifications);
        }
        self.steering.borrow_mut().clear();
        self.follow_ups.borrow_mut().clear();
        self.emit_queue();
        cleared
    }

    /// `tryCommand`: run `/name args` if a feature registered it (names may
    /// be namespaced, e.g. `om:status`); true when handled.
    fn try_command(self: &Rc<Self>, text: &str) -> bool {
        let Some((name, args)) = parse_command(text) else {
            return false;
        };
        let Some(feature) = self
            .features
            .iter()
            .find(|feature| {
                feature
                    .commands()
                    .iter()
                    .any(|command| command.name == name)
            })
            .cloned()
        else {
            return false;
        };
        let agent = self.clone();
        crate::spawn_eager(async move {
            if let Err(error) = feature.run_command(&agent, &name, args).await {
                agent.ui.notify(&error, NotifyLevel::Error);
            }
        });
        true
    }

    /// `panelState`: side-panel state contributed by features, merged.
    pub fn panel_state(self: &Rc<Self>) -> Value {
        let mut out = Map::new();
        for feature in &self.features {
            if let Some(panel) = feature.panel(self) {
                out.extend(panel);
            }
        }
        Value::Object(out)
    }

    /// `panelChanged`: coalesced until [`Agent::flush_panel`], where the TS
    /// agent's microtask ran.
    pub fn panel_changed(&self, section: &str) {
        let size = {
            let mut sections = self.changed_sections.borrow_mut();
            if !sections.iter().any(|s| s == section) {
                sections.push(section.to_owned());
            }
            sections.len()
        };
        // `if (size > 1) return; queueMicrotask(flush)`: one flush per call
        // that leaves a single section; the later ones find nothing.
        if size == 1 {
            self.scheduled_flushes.set(self.scheduled_flushes.get() + 1);
        }
    }

    fn flush_panel(&self) {
        for _ in 0..self.scheduled_flushes.replace(0) {
            let sections = std::mem::take(&mut *self.changed_sections.borrow_mut());
            self.emit(json!({ "type": "panel_changed", "sections": sections }));
        }
    }

    /// `commandList`: the features' slash commands.
    pub fn command_list(&self) -> Vec<Value> {
        self.features
            .iter()
            .flat_map(|feature| feature.commands())
            .map(|command| {
                json!({ "name": command.name, "description": command.description,
                    "source": "extension" })
            })
            .collect()
    }

    /// `userInput`: a human submitted input.
    fn user_input(self: &Rc<Self>, text: &str) {
        for feature in &self.features {
            feature.user_input(self, text);
        }
    }

    fn user_item(text: String, images: Vec<UserBlock>) -> QueueItem {
        QueueItem::User { text, images }
    }

    /// `prompt`: start a run; `Err` while one is active.
    pub fn prompt(self: &Rc<Self>, text: String, images: Vec<UserBlock>) -> Result<(), String> {
        if self.try_command(&text) {
            return Ok(());
        }
        if self.running.get() {
            return Err("Agent is already running; use steer or follow_up".to_owned());
        }
        self.user_input(&text);
        self.start_run(vec![Self::user_item(text, images)]);
        Ok(())
    }

    pub fn steer(self: &Rc<Self>, text: String, images: Vec<UserBlock>) {
        if self.try_command(&text) {
            return;
        }
        self.user_input(&text);
        let item = Self::user_item(text, images);
        if !self.running.get() {
            return self.start_run(vec![item]);
        }
        self.steering.borrow_mut().push(item);
        self.completion_changed();
        self.emit_queue();
    }

    pub fn follow_up(self: &Rc<Self>, text: String, images: Vec<UserBlock>) {
        if self.try_command(&text) {
            return;
        }
        self.user_input(&text);
        let item = Self::user_item(text, images);
        if !self.running.get() {
            return self.start_run(vec![item]);
        }
        self.follow_ups.borrow_mut().push(item);
        self.completion_changed();
        self.emit_queue();
    }

    /// `sendNow`: deliver the `index`th queued user message now.
    pub fn send_now(self: &Rc<Self>, queue: Queue, index: usize, text: &str) -> Result<(), String> {
        let list = match queue {
            Queue::Steering => &self.steering,
            Queue::FollowUp => &self.follow_ups,
        };
        let item = {
            let mut list = list.borrow_mut();
            let at = list
                .iter()
                .enumerate()
                .filter(|(_, item)| matches!(item, QueueItem::User { .. }))
                .map(|(i, _)| i)
                .nth(index);
            match at.map(|at| (at, &list[at])) {
                Some((at, QueueItem::User { text: queued, .. })) if queued == text => {
                    list.remove(at)
                }
                _ => return Err("That message is no longer queued".to_owned()),
            }
        };
        if !self.running.get() {
            self.emit_queue();
            self.start_run(vec![item]);
            return Ok(());
        }
        self.steering.borrow_mut().insert(0, item);
        self.emit_queue();
        self.completion_changed();
        let turn = self.turn.borrow().clone();
        match turn {
            Some(turn) => turn.abort(),
            None => self.interrupt_pending.set(true),
        }
        Ok(())
    }

    /// `deliver`: queued while running; idle, it starts a run or is
    /// recorded without one.
    pub fn deliver(
        self: &Rc<Self>,
        delivery: Delivery,
        trigger_turn: bool,
        follow_up: bool,
    ) -> Result<(), String> {
        let message = Message::Custom {
            custom_type: delivery.custom_type,
            content: delivery.content,
            display: delivery.display,
            details: delivery.details,
            timestamp: now_ms(),
        };
        let item = QueueItem::Custom(Box::new(message.clone()));
        if self.running.get() {
            if follow_up {
                self.follow_ups.borrow_mut().push(item);
            } else {
                self.steering.borrow_mut().push(item);
            }
            self.completion_changed();
            return Ok(());
        }
        if trigger_turn {
            self.start_run(vec![item]);
        } else {
            self.append_message(message)?;
        }
        Ok(())
    }

    pub fn abort(self: &Rc<Self>) {
        for feature in &self.features {
            feature.abort(self);
        }
        // Clones first: abort listeners must be free to touch the agent.
        let controller = self.controller.borrow().clone();
        if let Some(controller) = controller {
            controller.abort();
        }
        let compacting = self.compacting.borrow().clone();
        if let Some(compacting) = compacting {
            compacting.abort();
        }
    }

    /// Resolves once no run is active (`idle`).
    pub async fn idle(&self) {
        loop {
            let done = self.run_done.notified();
            if !self.run_active.get() {
                return;
            }
            done.await;
        }
    }

    /// `appendMessage`: written, then announced.
    pub fn append_message(&self, message: Message) -> Result<String, String> {
        let id = self.append(EntryData::Message(message.clone()))?;
        let value = serde_json::to_value(&message).unwrap_or_default();
        self.emit(json!({ "type": "message_start", "message": value }));
        self.emit(json!({ "type": "message_end", "message": value }));
        Ok(id)
    }

    /// `startRun`. The TS agent ran `run()` at once up to its first await:
    /// `agent_start` and, without `beforePrompt` hooks (whose processes
    /// are that await), the admitted messages go out before the command
    /// that started the run is answered.
    fn start_run(self: &Rc<Self>, initial: Vec<QueueItem>) {
        self.running.set(true);
        self.run_active.set(true);
        let controller = AbortController::new();
        *self.controller.borrow_mut() = Some(controller.clone());
        self.emit(json!({ "type": "agent_start" }));
        // Features' `beforeAgentStart` comes first and is awaited (in TS
        // even a feature without one is an await), so with features
        // everything is admitted in the run task.
        let with_features = !self.features.is_empty();
        // Only a user item awaits (`beforePrompt` hooks run before it), so
        // the items before the first one are admitted at once either way.
        let mut now = initial;
        let later = if with_features {
            std::mem::take(&mut now)
        } else if self.hooks.has(HookName::BeforePrompt) {
            let first_user = now
                .iter()
                .position(|item| matches!(item, QueueItem::User { .. }))
                .unwrap_or(now.len());
            now.split_off(first_user)
        } else {
            Vec::new()
        };
        let pending = match self.admit_now(now) {
            Ok(()) if !later.is_empty() => Some(later),
            Ok(()) => None,
            Err(error) => {
                self.start_failed(&error);
                None
            }
        };
        let agent = self.clone();
        tokio::task::spawn_local(async move {
            let run = agent.clone();
            let signal = controller.signal();
            // A panic is a bug; it ends the run like a crash.
            let outcome =
                tokio::task::spawn_local(
                    async move { run.run(signal, pending, with_features).await },
                )
                .await;
            let error = match outcome {
                Ok(Ok(())) => None,
                Ok(Err(error)) => Some(error),
                // The payload may quote session content and is stored by
                // the node; it stays in the panic message on stderr.
                Err(_) => Some("internal error".to_owned()),
            };
            if let Some(error) = error {
                let message = format!("Agent loop crashed: {error}");
                agent.emit(json!({ "type": "agent_error", "error": message }));
                agent.ui.notify(&message, NotifyLevel::Error);
            }
            agent.running.set(false);
            *agent.controller.borrow_mut() = None;
            agent.run_active.set(false);
            agent.run_done.notify_waiters();
            agent.settle().await;
        });
    }

    /// The start of a run with features: their `beforeAgentStart` in order
    /// (system prompt sections into `extra_prompt`, hidden messages after
    /// the run's first item), then admission. A failing feature skips the
    /// admission, as the TS agent's `try` did.
    async fn start_features(
        self: &Rc<Self>,
        mut items: Vec<QueueItem>,
        extra_prompt: &mut Vec<PromptSection>,
    ) -> Result<(), String> {
        let mut hidden = Vec::new();
        for feature in self.features.clone() {
            let Some(BeforeStart {
                system_prompt,
                messages,
            }) = feature.before_agent_start(self).await?
            else {
                continue;
            };
            match system_prompt {
                Some(PromptAddition::Text(text)) if !text.is_empty() => {
                    let name = feature.name();
                    extra_prompt.push(PromptSection::new(
                        name,
                        name,
                        &format!("feature:{name}"),
                        text,
                    ));
                }
                Some(PromptAddition::Sections(sections)) => extra_prompt.extend(sections),
                _ => {}
            }
            hidden.extend(messages);
        }
        let rest = if items.is_empty() {
            Vec::new()
        } else {
            items.split_off(1)
        };
        items.extend(
            hidden
                .into_iter()
                .map(|message| QueueItem::Custom(Box::new(message))),
        );
        items.extend(rest);
        self.admit(items).await
    }

    /// The run's start failed (`Failed to start run`); it goes on.
    fn start_failed(&self, error: &str) {
        self.ui
            .notify(&format!("Failed to start run: {error}"), NotifyLevel::Error);
    }

    async fn settle(self: &Rc<Self>) {
        self.emit(json!({ "type": "agent_settled" }));
        if self.hooks.has(HookName::AgentSettled) {
            let agent = self.clone();
            let count = self.store.borrow().all_messages().len();
            tokio::task::spawn_local(async move {
                let mut data = Map::new();
                data.insert("messageCount".to_owned(), json!(count));
                agent.hooks.run(HookName::AgentSettled, data, None).await;
            });
        }
        for feature in self.features.clone() {
            if let Err(error) = feature.agent_settled(self).await {
                self.ui.notify(
                    &format!("{}: {error}", feature.name()),
                    NotifyLevel::Warning,
                );
            }
        }
        // A feature (e.g. background completion) may have queued work while settling.
        if !self.running.get() && self.pending_count() > 0 {
            let mut next = std::mem::take(&mut *self.steering.borrow_mut());
            next.append(&mut self.follow_ups.borrow_mut());
            self.emit_queue();
            self.start_run(next);
        }
    }

    /// `admitted`: tell the features a message reached model history.
    fn admitted(&self, message: &Message) {
        let Some(agent) = self.weak.upgrade() else {
            return;
        };
        for feature in &self.features {
            feature.message_admitted(&agent, message);
        }
    }

    /// One queued item into the session, without hooks.
    fn admit_item(&self, item: QueueItem) -> Result<(), String> {
        match item {
            QueueItem::Custom(message) => {
                self.append_message((*message).clone())?;
                self.admitted(&message);
            }
            QueueItem::User { text, images } => {
                let content = if images.is_empty() {
                    UserContent::Text(text)
                } else {
                    let mut blocks = vec![text_block(text)];
                    blocks.extend(images);
                    UserContent::Blocks(blocks)
                };
                self.append_message(Message::User {
                    content,
                    timestamp: now_ms(),
                })?;
            }
        }
        Ok(())
    }

    /// `admit` when no `beforePrompt` hook runs: nothing to wait for.
    fn admit_now(&self, items: Vec<QueueItem>) -> Result<(), String> {
        items.into_iter().try_for_each(|item| self.admit_item(item))
    }

    /// `admit`: `beforePrompt` hooks add hidden context before each prompt.
    async fn admit(&self, items: Vec<QueueItem>) -> Result<(), String> {
        for item in items {
            if let QueueItem::User { text, .. } = &item
                && self.hooks.has(HookName::BeforePrompt)
            {
                let mut data = Map::new();
                data.insert("prompt".to_owned(), json!(text));
                let extra = self.hooks.collect(HookName::BeforePrompt, data).await;
                if !extra.is_empty() {
                    self.append_message(Message::Custom {
                        custom_type: "hook-context".to_owned(),
                        content: extra,
                        display: false,
                        details: None,
                        timestamp: now_ms(),
                    })?;
                }
            }
            self.admit_item(item)?;
        }
        Ok(())
    }

    /// The system prompt with the latest run's feature additions.
    pub fn system_prompt(&self) -> String {
        join_prompt(&self.prompt_sections())
    }

    /// `promptSections`.
    pub fn prompt_sections(&self) -> Vec<PromptSection> {
        let mut sections = self.config.system_prompt.clone();
        let extra = self.extra_system_prompt.borrow();
        if !extra.is_empty() {
            sections.push(PromptSection::new(
                "hook:sessionStart",
                "Session start hook",
                "hook",
                extra.clone(),
            ));
        }
        sections.extend(self.run_prompt.borrow().iter().cloned());
        if let Some(index) = ptc::capability_index_prompt(self) {
            sections.push(PromptSection::new(
                "capabilities",
                "Capabilities",
                "built-in",
                index,
            ));
        }
        sections.push(PromptSection::new(
            "cwd",
            "Working directory",
            "built-in",
            format!("Current working directory: {}", self.config.workspace),
        ));
        sections
    }

    fn save_context(&self, snapshot: Value) {
        if context::write_context(&self.store.borrow().dir, &snapshot).is_err() {
            self.ui.notify(
                "Unable to persist the context snapshot; the live inspector is still available.",
                NotifyLevel::Warning,
            );
        }
        *self.last_context.borrow_mut() = Some(snapshot);
        self.panel_changed("context");
    }

    /// The latest context snapshot (`lastContext`).
    pub fn last_context(&self) -> Option<Value> {
        self.last_context.borrow().clone()
    }

    fn tool_specs(&self) -> Vec<ToolSpec> {
        self.model_tool_list()
            .iter()
            .map(|tool| ToolSpec {
                name: tool.name().to_owned(),
                description: tool.description().to_owned(),
                parameters: tool.parameters().clone(),
            })
            .collect()
    }

    /// `compactionSettings`.
    pub fn compaction_settings(&self) -> CompactionSettings {
        CompactionSettings::from_features(&self.config.features)
    }

    /// Manual compaction (`compact`), only while idle.
    pub async fn compact(self: &Rc<Self>, instructions: Option<String>) -> Result<Value, String> {
        if self.running.get() {
            return Err("Cannot compact while the agent is running".to_owned());
        }
        if self.compacting.borrow().is_some() {
            return Err("Compaction already in progress".to_owned());
        }
        let controller = AbortController::new();
        let _compacting = self.compacting_guard(controller.clone());
        let result = compaction::run_compaction(
            self,
            CompactionReason::Manual,
            &controller.signal(),
            instructions,
            &self.compaction_settings(),
        )
        .await?;
        if !result.ok {
            return Err(result
                .error
                .unwrap_or_else(|| "Compaction failed".to_owned()));
        }
        Ok(result.to_json())
    }

    /// Compact before a turn when the context is near the window.
    async fn maybe_compact(self: &Rc<Self>, signal: &AbortSignal) -> Result<(), String> {
        let settings = self.compaction_settings();
        if !settings.enabled {
            return Ok(());
        }
        let Ok(resolved) = self.resolve_model(None) else {
            return Ok(());
        };
        let window = resolved.model.context_window;
        let used = compaction::context_tokens(&self.store.borrow().context_entries());
        // JavaScript arithmetic: signed, and a reserve that is not a number
        // (NaN) always compacts.
        if (used as f64) <= window as f64 - settings.reserve_tokens {
            return Ok(());
        }
        let result = self
            .with_compacting(signal, |inner| async move {
                compaction::run_compaction(
                    self,
                    CompactionReason::Threshold,
                    &inner,
                    None,
                    &settings,
                )
                .await
            })
            .await?;
        if !result.ok && !signal.aborted() {
            self.ui.notify(
                &format!(
                    "Automatic compaction failed: {}",
                    result.error.unwrap_or_default()
                ),
                NotifyLevel::Warning,
            );
        }
        Ok(())
    }

    async fn with_compacting<'a, T, F>(
        &'a self,
        signal: &AbortSignal,
        work: impl FnOnce(AbortSignal) -> F,
    ) -> T
    where
        F: std::future::Future<Output = T> + 'a,
    {
        let controller = AbortController::child_of(signal);
        let _compacting = self.compacting_guard(controller.clone());
        work(controller.signal()).await
    }

    /// `compacting` while the guard lives (`finally` in the TS agent).
    fn compacting_guard(&self, controller: AbortController) -> CompactingGuard<'_> {
        *self.compacting.borrow_mut() = Some(controller);
        CompactingGuard(&self.compacting)
    }

    /// `refreshModels`: the node's current public catalog.
    pub async fn refresh_models(&self) {
        let Some(inference) = self.config.models.inference.clone() else {
            return;
        };
        let Ok(latest) = crate::remote::fetch_remote_models(&inference).await else {
            return;
        };
        {
            let mut models = self.models.borrow_mut();
            models.providers = latest.providers.clone();
            models.default_model = latest.default_model.clone();
        }
        if self.model_ref.borrow().is_none() {
            let fallback: Option<ModelRef> = self
                .config
                .default_model
                .clone()
                .or(latest.default_model.clone());
            let first = latest.providers.iter().next().and_then(|(name, provider)| {
                provider
                    .models
                    .first()
                    .map(|m| (name.clone(), m.id.clone()))
            });
            *self.model_ref.borrow_mut() = fallback.map(|f| (f.provider, f.id)).or(first);
        }
    }

    /// `streamFunction`: the gateway's inference (tests may override it).
    pub fn stream_function(&self) -> Rc<dyn StreamFn> {
        if let Some(stream) = &self.stream_override {
            return stream.clone();
        }
        match &self.config.models.inference {
            Some(inference) => Rc::new(crate::remote::RemoteStream {
                config: inference.clone(),
            }),
            None => Rc::new(NoInference),
        }
    }

    fn context_for(&self, up_to: Option<&str>) -> Vec<Message> {
        let entries = self.store.borrow().context_entries();
        let end = match up_to {
            None | Some("end") => entries.len(),
            Some(id) => entries
                .iter()
                .position(|(entry_id, _)| entry_id == id)
                .unwrap_or(entries.len()),
        };
        entries
            .into_iter()
            .take(end)
            .map(|(_, message)| message)
            .collect()
    }

    /// `stream`: one model call with retries and role fallbacks; emits
    /// the streaming events.
    pub async fn stream(
        &self,
        system_prompt: &str,
        signal: &AbortSignal,
        mut options: StreamOptions,
    ) -> Result<AssistantMessage, String> {
        let mut resolved = match self.resolve_model(None) {
            Ok(resolved) => resolved,
            Err(error) => {
                if options.no_retries || !self.fall_back(&error)? {
                    return Err(error);
                }
                self.resolve_model(None)?
            }
        };
        let mut stream_fn = self.stream_function();
        let emit = !options.quiet;
        let mut attempt: usize = 0;
        loop {
            let timestamp = now_ms();
            if emit {
                self.emit(
                    json!({ "type": "message_start", "message": { "role": "assistant",
                    "content": [], "timestamp": timestamp, "provider": resolved.provider_name,
                    "model": resolved.model.id } }),
                );
            }
            let mut messages = sanitize_history(&self.context_for(options.up_to.as_deref()));
            messages.extend(options.extra_messages.iter().cloned());
            let tools = self.tool_specs();
            let sections = self.prompt_sections();
            let shown = if join_prompt(&sections) == system_prompt {
                sections
            } else {
                vec![PromptSection::new(
                    "request",
                    "Request system prompt",
                    "built-in",
                    system_prompt,
                )]
            };
            // Observational memory's folded compactions (M5) add memory tokens.
            let snapshot = context::capture_context(ContextInput {
                sections: &shown,
                tools: &tools,
                messages: &messages,
                provider: &resolved.provider_name,
                model_id: &resolved.model.id,
                context_window: Some(resolved.model.context_window).filter(|window| *window > 0),
                memory_tokens: 0,
                capabilities: Some(self.registry.summaries(&self.available_tools())),
            });
            let snapshot_id = snapshot.get("id").cloned();
            self.save_context(snapshot.clone());
            // The TS agent's microtask: the network call is its first await.
            self.flush_panel();
            let thinking = if resolved.model.reasoning {
                options.thinking.unwrap_or(self.thinking.get())
            } else {
                ThinkingLevel::Off
            };
            let request = StreamRequest {
                provider_name: resolved.provider_name.clone(),
                provider: resolved.provider.clone(),
                model: resolved.model.clone(),
                system_prompt: system_prompt.to_owned(),
                messages,
                tools,
                thinking,
                session_id: self.store.borrow().session_id(),
                signal: signal.clone(),
                max_tokens: options.max_tokens.filter(|n| *n > 0),
                tool_choice: options.tool_choice,
            };
            let mut on_delta = |delta: &pirc_protocol::AssistantDelta| {
                if emit {
                    self.emit(json!({ "type": "message_update",
                        "assistantMessageEvent": delta }));
                }
            };
            let mut message = stream_fn.stream(request, &mut on_delta).await;
            if self
                .last_context
                .borrow()
                .as_ref()
                .and_then(|s| s.get("id").cloned())
                == snapshot_id
            {
                self.save_context(context::with_reported_usage(&snapshot, &message.usage));
            }
            message.timestamp = timestamp;
            message.completed_at = Some(now_ms());
            let retryable = message.stop_reason == StopReason::Error
                && !options.no_retries
                && !signal.aborted()
                && is_retryable(message.error_message.as_deref())
                && !message.content.iter().any(
                    |part| matches!(part, AssistantContent::Text { text, .. } if !text.is_empty()),
                );
            if retryable && self.fall_back(message.error_message.as_deref().unwrap_or("error"))? {
                if emit {
                    self.emit_end(&message);
                }
                resolved = self.resolve_model(None)?;
                stream_fn = self.stream_function();
                attempt = 0;
                continue;
            }
            let retry = retryable && attempt < RETRY_DELAYS.len();
            if !retry {
                if let Some(before_end) = options.before_end.as_mut()
                    && let Err(error) = before_end(&message)
                {
                    self.flush_panel();
                    return Err(error);
                }
                if emit {
                    self.emit_end(&message);
                }
                // The TS agent's microtask after `stream` returned.
                self.flush_panel();
                return Ok(message);
            }
            if emit {
                self.emit_end(&message);
            }
            let delay = RETRY_DELAYS[attempt];
            self.emit(json!({ "type": "auto_retry_start", "attempt": attempt + 1,
                "maxAttempts": RETRY_DELAYS.len(), "delayMs": delay,
                "errorMessage": message.error_message }));
            // The TS agent's microtask ran at the retry's sleep.
            self.flush_panel();
            sleep_or_abort(delay, signal).await;
            self.emit(
                json!({ "type": "auto_retry_end", "success": !signal.aborted(),
                "attempt": attempt + 1 }),
            );
            if signal.aborted() {
                message.stop_reason = StopReason::Aborted;
                return Ok(message);
            }
            attempt += 1;
        }
    }

    fn emit_end(&self, message: &AssistantMessage) {
        let mut value = serde_json::to_value(message).unwrap_or_default();
        if let Some(object) = value.as_object_mut() {
            let mut with_role = Map::new();
            with_role.insert("role".to_owned(), json!("assistant"));
            with_role.extend(std::mem::take(object));
            *object = with_role;
        }
        self.emit(json!({ "type": "message_end", "message": value }));
    }

    /// The run after its start (`run`): `pending` are the queued items
    /// still to admit when `beforePrompt` hooks made admitting wait.
    async fn run(
        self: &Rc<Self>,
        signal: AbortSignal,
        pending: Option<Vec<QueueItem>>,
        with_features: bool,
    ) -> Result<(), String> {
        let mut extra_prompt = Vec::new();
        if with_features {
            let items = pending.unwrap_or_default();
            if let Err(error) = self.start_features(items, &mut extra_prompt).await {
                self.start_failed(&error);
            }
        } else if let Some(items) = pending
            && let Err(error) = self.admit(items).await
        {
            self.start_failed(&error);
        }
        *self.run_prompt.borrow_mut() = trim_sections(&extra_prompt);
        let max_turns = self.config.limits.max_turns;
        let mut turns: u64 = 0;
        let mut overflow_retried = false;
        let mut completion_timed_out = false;
        let mut produced: Vec<Message> = Vec::new();
        while !signal.aborted() {
            turns += 1;
            if turns > max_turns {
                self.ui.notify(
                    &format!("Stopped after {max_turns} turns"),
                    NotifyLevel::Warning,
                );
                break;
            }
            // Team reports are safe at tool boundaries. Admit them before the
            // next model call so a final synthesis cannot overlook
            // already-queued results.
            let team_batch = self.team_batch_size();
            if team_batch > 0 {
                let items: Vec<QueueItem> =
                    self.follow_ups.borrow_mut().drain(..team_batch).collect();
                self.admit(items).await?;
            }
            *self.turn.borrow_mut() = None;
            self.maybe_compact(&signal).await?;
            if signal.aborted() {
                break;
            }
            if self.interrupt_pending.replace(false) {
                let items = std::mem::take(&mut *self.steering.borrow_mut());
                self.emit_queue();
                self.admit(items).await?;
            }
            let turn = AbortController::child_of(&signal);
            *self.turn.borrow_mut() = Some(turn.clone());
            let turn_signal = turn.signal();
            let interrupted = || turn_signal.aborted() && !signal.aborted();
            self.emit(json!({ "type": "turn_start" }));
            let settings = self.compaction_settings();
            let compacts_instead = |reply: &AssistantMessage, retried: bool| {
                compaction::is_context_overflow(reply) && !retried && settings.enabled
            };
            let persisted = Rc::new(Cell::new(false));
            let marker = persisted.clone();
            let agent = self.clone();
            let retried = overflow_retried;
            let settings_enabled = settings.enabled;
            let before_end: BeforeEnd = Box::new(move |reply| {
                if compaction::is_context_overflow(reply) && !retried && settings_enabled {
                    return Ok(());
                }
                agent.append(EntryData::Message(Message::Assistant(reply.clone())))?;
                marker.set(true);
                Ok(())
            });
            let prompt = self.system_prompt();
            let message = self
                .stream(
                    &prompt,
                    &turn_signal,
                    StreamOptions {
                        before_end: Some(before_end),
                        ..StreamOptions::default()
                    },
                )
                .await?;
            if !persisted.get() && compacts_instead(&message, overflow_retried) {
                overflow_retried = true;
                self.emit(json!({ "type": "turn_end" }));
                let result = self
                    .with_compacting(&signal, |inner| async move {
                        compaction::run_compaction(
                            self,
                            CompactionReason::Overflow,
                            &inner,
                            None,
                            &settings,
                        )
                        .await
                    })
                    .await?;
                if result.ok {
                    continue;
                }
            }
            if !persisted.get() {
                self.append(EntryData::Message(Message::Assistant(message.clone())))?;
            }
            produced.push(Message::Assistant(message.clone()));
            if message.stop_reason == StopReason::ToolUse {
                let calls: Vec<(String, String, Map<String, Value>)> = message
                    .content
                    .iter()
                    .filter_map(|part| match part {
                        AssistantContent::ToolCall {
                            id,
                            name,
                            arguments,
                            ..
                        } => Some((id.clone(), name.clone(), arguments.clone())),
                        _ => None,
                    })
                    .collect();
                for (id, name, arguments) in calls {
                    if turn_signal.aborted() {
                        let text = if signal.aborted() {
                            "Aborted by the user before this tool ran."
                        } else {
                            "Interrupted: the user sent a message before this tool ran."
                        };
                        self.record_result(&id, &name, ToolResult::error(text))?;
                        continue;
                    }
                    self.execute_tool(&id, &name, arguments, &turn_signal)
                        .await?;
                }
            }
            self.emit(json!({ "type": "turn_end" }));
            for feature in self.features.clone() {
                feature.turn_end(self, &message).await?;
            }
            if message.stop_reason == StopReason::Error {
                break;
            }
            if message.stop_reason == StopReason::Aborted && !interrupted() {
                break;
            }
            if !self.steering.borrow().is_empty() {
                let mut items = std::mem::take(&mut *self.steering.borrow_mut());
                self.interrupt_pending.set(false);
                self.emit_queue();
                if message.stop_reason == StopReason::Aborted {
                    items.insert(0, interrupted_note(&message));
                }
                self.admit(items).await?;
                continue;
            }
            if message.stop_reason == StopReason::ToolUse {
                continue;
            }
            if turns >= max_turns {
                self.ui.notify(
                    &format!("Stopped after {max_turns} turns; team work may still be pending."),
                    NotifyLevel::Warning,
                );
                break;
            }
            if self.pending_count() == 0 && !completion_timed_out {
                completion_timed_out = self.wait_for_completion(&signal).await;
            }
            if signal.aborted() {
                break;
            }
            if self.follow_ups.borrow().is_empty() {
                for feature in self.features.clone() {
                    feature.agent_end(self, &produced).await?;
                }
            }
            if self.pending_count() > 0 {
                let count = self.team_batch_size().max(1);
                let mut items = std::mem::take(&mut *self.steering.borrow_mut());
                let take = count.min(self.follow_ups.borrow().len());
                items.extend(self.follow_ups.borrow_mut().drain(..take));
                self.emit_queue();
                self.admit(items).await?;
                continue;
            }
            break;
        }
        *self.turn.borrow_mut() = None;
        self.interrupt_pending.set(false);
        self.emit(json!({ "type": "agent_end", "willRetry": false }));
        Ok(())
    }

    fn record_result(&self, id: &str, name: &str, result: ToolResult) -> Result<Message, String> {
        let content = if result.content.is_empty() {
            vec![text_block("(no output)")]
        } else {
            result.content
        };
        let message = Message::ToolResult {
            tool_call_id: id.to_owned(),
            tool_name: name.to_owned(),
            content,
            details: result.details,
            is_error: result.is_error,
            timestamp: now_ms(),
        };
        self.append_message(message.clone())?;
        self.admitted(&message);
        Ok(message)
    }

    /// `acquireWrite`: the write lease for the allowed root containing
    /// `file` (none for shared roots).
    pub async fn acquire_write(&self, file: &str, signal: &AbortSignal) -> Result<(), String> {
        let Some(root) = self.guard.lease_root(file) else {
            return Ok(());
        };
        let Some(lease) = self.write_lease.clone() else {
            return Ok(());
        };
        if signal.aborted() {
            return Err("The operation was aborted.".to_owned());
        }
        tokio::select! {
            result = lease(root) => result,
            () = signal.cancelled() => Err("Aborted".to_owned()),
        }
    }

    fn tool_context(
        &self,
        tool_call_id: &str,
        signal: &AbortSignal,
        on_update: Rc<dyn Fn(ToolResult)>,
    ) -> ToolContext {
        let agent = self.weak.clone();
        let lease_signal = signal.clone();
        ToolContext {
            cwd: self.config.workspace.clone(),
            config: self.config.clone(),
            guard: self.guard.clone(),
            signal: signal.clone(),
            tool_call_id: tool_call_id.to_owned(),
            ui: self.ui.clone(),
            has_ui: self.has_ui,
            env: self.config.env.clone(),
            acquire_write: Rc::new(move |file: String| {
                let agent = agent.clone();
                let signal = lease_signal.clone();
                Box::pin(async move {
                    match agent.upgrade() {
                        Some(agent) => agent.acquire_write(&file, &signal).await,
                        None => Err("Aborted".to_owned()),
                    }
                })
            }),
            update: on_update,
            human_wait: {
                let agent = self.weak.clone();
                Rc::new(move || match agent.upgrade() {
                    Some(agent) => agent.human_wait(),
                    None => HumanWait::none(),
                })
            },
        }
    }

    /// `invokeOperation`: availability, then the policy chain.
    async fn invoke_operation(
        &self,
        name: &str,
        raw_args: Map<String, Value>,
        signal: &AbortSignal,
        tool_call_id: &str,
        on_update: Rc<dyn Fn(ToolResult)>,
    ) -> (OperationStage, ToolResult) {
        let tool = self.get_tool(name);
        if tool.is_none()
            && let Some(capability) = capability_for_tool(name)
            && self.tools.borrow().contains_key(name)
        {
            return (
                OperationStage::Unavailable,
                ToolResult::error(format!(
                    "The {capability} capability is disabled for this project; {name} is unavailable. Ask the user to enable it in the project settings if needed."
                )),
            );
        }
        let Some(tool) = tool else {
            return (
                OperationStage::Unavailable,
                ToolResult::error(format!("Unknown tool: {name}")),
            );
        };
        self.run_tool(&tool, raw_args, signal, tool_call_id, on_update)
            .await
    }

    /// `runTool`: validation, `beforeTool` hooks, validation of rewritten
    /// arguments, auto mode and the write lease, the tool, `afterTool`.
    async fn run_tool(
        &self,
        tool: &Rc<dyn Tool>,
        raw_args: Map<String, Value>,
        signal: &AbortSignal,
        tool_call_id: &str,
        on_update: Rc<dyn Fn(ToolResult)>,
    ) -> (OperationStage, ToolResult) {
        let name = tool.name().to_owned();
        let fail = |stage, text: String| (stage, ToolResult::error(text));
        let cancelled = || {
            fail(
                OperationStage::Cancelled,
                "Cancelled before it started".to_owned(),
            )
        };
        if let Some(raw) = raw_args.get("__invalid_json") {
            let shown = match raw {
                Value::String(text) => text.clone(),
                other => other.to_string(),
            };
            let (shown, _) = slice16(&shown, 500);
            return fail(
                OperationStage::Invalid,
                format!("Invalid JSON arguments for {name}: {shown}"),
            );
        }
        let invalid = |args: &Map<String, Value>, what: &str| {
            let errors = ptc::validate_schema(&Value::Object(args.clone()), tool.parameters());
            (!errors.is_empty())
                .then(|| format!("Invalid {what} for {name}: {}", errors.join("; ")))
        };
        if let Some(problem) = invalid(&raw_args, "arguments") {
            return fail(OperationStage::Invalid, problem);
        }
        if signal.aborted() {
            return cancelled();
        }
        let gate = self.hooks.before_tool(&name, raw_args.clone()).await;
        if signal.aborted() {
            return cancelled();
        }
        let args = match gate {
            Ok(args) => args,
            Err(reason) => {
                return fail(OperationStage::Denied, format!("Blocked by hook: {reason}"));
            }
        };
        if args != raw_args
            && let Some(problem) = invalid(&args, "hook-rewritten arguments")
        {
            return fail(OperationStage::Invalid, problem);
        }
        let refusal = match self.auto_mode.gate(self, &name, &args, signal).await {
            Ok(refusal) => refusal,
            Err(error) => {
                if signal.aborted() {
                    return cancelled();
                }
                return fail(OperationStage::Refused, error);
            }
        };
        if signal.aborted() {
            return cancelled();
        }
        if let Some(refusal) = refusal {
            return fail(
                OperationStage::Denied,
                format!("Blocked by auto mode: {refusal}"),
            );
        }
        let ctx = self.tool_context(tool_call_id, signal, on_update);
        let (stage, mut result) = match tool.execute(args.clone(), ctx).await {
            Ok(result) => (OperationStage::Executed, result),
            Err(error) => {
                let (shown, _) = slice16(&format!("tool {name} threw: {error}\n"), 8192);
                eprint!("{shown}");
                (OperationStage::Threw, ToolResult::error(error))
            }
        };
        if self.hooks.has(HookName::AfterTool) {
            let output: String = result
                .content
                .iter()
                .filter_map(|part| match part {
                    UserBlock::Text { text, .. } => Some(text.as_str()),
                    UserBlock::Image { .. } => None,
                })
                .collect();
            let (output, _) = slice16(&output, 65_536);
            let mut data = Map::new();
            data.insert("tool".to_owned(), json!(name));
            data.insert("args".to_owned(), Value::Object(args));
            data.insert("isError".to_owned(), json!(result.is_error));
            data.insert("output".to_owned(), json!(output));
            let hook_output: Vec<String> = self
                .hooks
                .run(HookName::AfterTool, data, Some(&name))
                .await
                .into_iter()
                .filter(|item| item.exit_code == Some(0) && !js_trim(&item.stdout).is_empty())
                .map(|item| js_trim(&item.stdout).to_owned())
                .collect();
            if !hook_output.is_empty() {
                result
                    .content
                    .push(text_block(format!("\n[hook]\n{}", hook_output.join("\n"))));
            }
        }
        (stage, result)
    }

    /// `invokeModelTool`: only the model-facing tools exist at this level.
    async fn invoke_model_tool(
        &self,
        id: &str,
        name: &str,
        arguments: Map<String, Value>,
        signal: &AbortSignal,
        on_update: Rc<dyn Fn(ToolResult)>,
    ) -> ToolResult {
        let wrapper = self.wrappers.borrow().get(name).cloned();
        if let Some(wrapper) = wrapper
            && !self.available_tools().is_empty()
        {
            return self
                .run_tool(&wrapper, arguments, signal, id, on_update)
                .await
                .1;
        }
        let direct = self.direct_tools().iter().any(|tool| tool.name() == name)
            || (DIRECT_CAPABILITIES.contains(&name)
                && self.tools.borrow().contains_key(name)
                && capability_for_tool(name).is_some());
        if direct {
            let args = lenient_args(self.get_tool(name).as_ref(), &arguments);
            let previous = self.current_operation.replace(Some(id.to_owned()));
            let forward = on_update.clone();
            let observed: Rc<dyn Fn(ToolResult)> =
                Rc::new(move |partial: ToolResult| forward(partial.observed()));
            let result = self
                .invoke_operation(name, args, signal, id, observed)
                .await
                .1
                .observed();
            *self.current_operation.borrow_mut() = previous;
            return result;
        }
        let text = if self.get_tool(name).is_some() {
            format!(
                "{name} is not a direct tool: call it from a ptc script, e.g. ptc({{ code: \"return await tools.{name}({{ … }})\" }}). ptc_docs({{ names: [\"{name}\"] }}) shows its arguments."
            )
        } else {
            let names: Vec<String> = self
                .model_tool_list()
                .iter()
                .map(|tool| tool.name().to_owned())
                .collect();
            let listed = if names.is_empty() {
                "none".to_owned()
            } else {
                names.join(", ")
            };
            format!("Unknown tool: {name}. The tools are {listed}.")
        };
        ToolResult::error(text)
    }

    async fn execute_tool(
        &self,
        id: &str,
        name: &str,
        arguments: Map<String, Value>,
        signal: &AbortSignal,
    ) -> Result<Message, String> {
        self.emit(
            json!({ "type": "tool_execution_start", "toolCallId": id, "toolName": name,
            "args": arguments }),
        );
        let last_update = Rc::new(Cell::new(0u64));
        let weak = self.weak.clone();
        let (call_id, tool_name, shown_args) = (id.to_owned(), name.to_owned(), arguments.clone());
        let on_update: Rc<dyn Fn(ToolResult)> = Rc::new(move |partial: ToolResult| {
            let now = now_ms();
            if now.saturating_sub(last_update.get()) < 100 {
                return;
            }
            last_update.set(now);
            if let Some(agent) = weak.upgrade() {
                agent.emit(
                    json!({ "type": "tool_execution_update", "toolCallId": call_id,
                    "toolName": tool_name, "args": shown_args,
                    "partialResult": partial.to_json() }),
                );
            }
        });
        let result = self
            .invoke_model_tool(id, name, arguments, signal, on_update)
            .await;
        self.emit(
            json!({ "type": "tool_execution_end", "toolCallId": id, "toolName": name,
            "result": result.to_json(), "isError": result.is_error }),
        );
        self.record_result(id, name, result)
    }

    /// Every message on the branch (`get_messages`).
    pub fn all_messages(&self) -> Vec<Message> {
        self.store.borrow().all_messages()
    }

    /// The session's context entries (compaction).
    pub fn context_entries(&self) -> Vec<(String, Message)> {
        self.store.borrow().context_entries()
    }

    /// Append a compaction entry; its id.
    pub fn append_compaction(
        &self,
        summary: &str,
        first_kept_entry_id: &str,
        tokens_before: u64,
        details: Option<Value>,
    ) -> Result<String, String> {
        self.append(EntryData::Compaction {
            summary: summary.to_owned(),
            first_kept_entry_id: first_kept_entry_id.to_owned(),
            tokens_before,
            details,
        })
    }

    pub fn ui(&self) -> Rc<dyn Ui> {
        self.ui.clone()
    }

    pub async fn shutdown(self: &Rc<Self>) {
        self.abort();
        self.idle().await;
        for feature in self.features.clone() {
            feature.shutdown(self).await;
        }
        self.closed.set(true);
    }

    /// The role this agent runs in.
    pub fn role(&self) -> Option<AgentRole> {
        self.role.borrow().clone()
    }

    /// A chat project's instructions (the M5 feature reads them).
    pub fn project_instructions(&self) -> Option<&str> {
        self.project_instructions.as_deref()
    }

    /// The current model reference.
    pub fn model_ref(&self) -> Option<(String, String)> {
        self.model_ref.borrow().clone()
    }

    pub fn empty_assistant(&self) -> AssistantMessage {
        AssistantMessage {
            content: Vec::new(),
            api: String::new(),
            provider: String::new(),
            model: String::new(),
            usage: empty_usage(),
            stop_reason: StopReason::Stop,
            error_message: None,
            timestamp: now_ms(),
            completed_at: None,
            canonical_provider: None,
            response_id: None,
            response_model: None,
        }
    }
}

/// `isRetryable`: rate limits, overload, 5xx, dropped connections.
pub fn is_retryable(message: Option<&str>) -> bool {
    use std::sync::LazyLock;
    static PATTERN: LazyLock<regex_lite::Regex> = LazyLock::new(|| {
        regex_lite::Regex::new(
            r"(?i)HTTP (408|409|429|5\d\d)|rate.?limit|overloaded|timeout|timed out|ECONNRESET|ECONNREFUSED|socket|network|fetch failed|terminated|unable to connect",
        )
        .unwrap()
    });
    message.is_some_and(|text| !text.is_empty() && PATTERN.is_match(text))
}

/// No inference configured (a standalone agent; the node always sends one).
struct NoInference;

impl StreamFn for NoInference {
    fn stream<'a>(
        &'a self,
        request: StreamRequest,
        _on_delta: &'a mut dyn FnMut(&pirc_protocol::AssistantDelta),
    ) -> LocalBoxFuture<'a, AssistantMessage> {
        Box::pin(async move {
            AssistantMessage {
                content: Vec::new(),
                api: request
                    .model
                    .api
                    .map_or_else(|| api_name(request.provider.api), api_name)
                    .to_owned(),
                provider: request.provider_name,
                model: request.model.id,
                usage: empty_usage(),
                stop_reason: StopReason::Error,
                error_message: Some("Gateway inference is unavailable".to_owned()),
                timestamp: now_ms(),
                completed_at: None,
                canonical_provider: None,
                response_id: None,
                response_model: None,
            }
        })
    }
}

fn api_name(api: pirc_protocol::ModelApi) -> &'static str {
    use pirc_protocol::ModelApi;
    match api {
        ModelApi::OpenaiChat => "openai-chat",
        ModelApi::AnthropicMessages => "anthropic-messages",
        ModelApi::OpenaiCompletions => "openai-completions",
        ModelApi::OpenaiResponses => "openai-responses",
        ModelApi::OpenaiCodexResponses => "openai-codex-responses",
    }
}

impl AgentHost for Agent {
    fn config(&self) -> Rc<AgentConfig> {
        self.config.clone()
    }
    fn guard(&self) -> Rc<PathGuard> {
        self.guard.clone()
    }
    fn ui(&self) -> Rc<dyn Ui> {
        self.ui.clone()
    }
    fn has_ui(&self) -> bool {
        self.has_ui
    }
    fn session_id(&self) -> String {
        self.store.borrow().session_id()
    }
    fn acquire_write<'a>(
        &'a self,
        file: &'a str,
        signal: &'a AbortSignal,
    ) -> LocalBoxFuture<'a, Result<(), String>> {
        Box::pin(Agent::acquire_write(self, file, signal))
    }
    fn tool_list(&self) -> Vec<Rc<dyn Tool>> {
        self.available_tools()
    }
    fn direct_tool_list(&self) -> Vec<Rc<dyn Tool>> {
        self.direct_tools()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(id: &str) -> AssistantContent {
        AssistantContent::ToolCall {
            id: id.to_owned(),
            name: "read".to_owned(),
            arguments: Map::new(),
            thought_signature: None,
        }
    }

    fn assistant(content: Vec<AssistantContent>, stop: StopReason) -> Message {
        Message::Assistant(AssistantMessage {
            content,
            api: "x".to_owned(),
            provider: "p".to_owned(),
            model: "m".to_owned(),
            usage: empty_usage(),
            stop_reason: stop,
            error_message: None,
            timestamp: 1,
            completed_at: None,
            canonical_provider: None,
            response_id: None,
            response_model: None,
        })
    }

    fn result(id: &str) -> Message {
        Message::ToolResult {
            tool_call_id: id.to_owned(),
            tool_name: "read".to_owned(),
            content: vec![],
            details: None,
            is_error: false,
            timestamp: 2,
        }
    }

    #[test]
    fn sanitizes_orphans_and_missing_results() {
        let user = Message::User {
            content: UserContent::Text("hi".to_owned()),
            timestamp: 0,
        };
        let messages = vec![
            result("orphan"),
            assistant(vec![call("a"), call("b")], StopReason::ToolUse),
            result("b"),
            user.clone(),
            assistant(vec![call("c")], StopReason::Error),
            result("c"),
        ];
        let out = sanitize_history(&messages);
        let shape: Vec<String> = out
            .iter()
            .map(|m| match m {
                Message::ToolResult {
                    tool_call_id,
                    is_error,
                    ..
                } => format!("result {tool_call_id} {is_error}"),
                Message::Assistant(_) => "assistant".to_owned(),
                Message::User { .. } => "user".to_owned(),
                _ => "other".to_owned(),
            })
            .collect();
        assert_eq!(
            shape,
            [
                "assistant",
                "result b false",
                "result a true",
                "user",
                "assistant"
            ]
        );
    }

    #[test]
    fn interrupted_notes_carry_the_partial_text() {
        let message = match assistant(
            vec![AssistantContent::Text {
                text: "  partial  ".to_owned(),
                text_signature: None,
            }],
            StopReason::Aborted,
        ) {
            Message::Assistant(message) => message,
            _ => unreachable!(),
        };
        match interrupted_note(&message) {
            QueueItem::Custom(message) => match *message {
                Message::Custom { content, .. } => assert_eq!(
                    content,
                    "[Your previous response was interrupted by the user.] Partial output:\n\npartial"
                ),
                _ => panic!(),
            },
            _ => panic!(),
        }
    }

    #[test]
    fn parses_slash_commands() {
        let parsed = |text: &str| parse_command(text);
        assert_eq!(
            parsed("  /goal   finish it \n"),
            Some(("goal".to_owned(), "finish it".to_owned()))
        );
        assert_eq!(
            parsed("/om:status"),
            Some(("om:status".to_owned(), String::new()))
        );
        assert_eq!(
            parsed("/Todo\u{3000}a\nb"),
            Some(("Todo".to_owned(), "a\nb".to_owned()))
        );
        for text in ["goal", "/1goal", "/goal!", "/ goal", "/goal\u{85}x"] {
            assert_eq!(parsed(text), None, "{text:?}");
        }
    }

    #[test]
    fn retryable_errors() {
        for text in [
            "Model request failed (HTTP 503)",
            "Inference request timed out",
            "rate limit",
        ] {
            assert!(is_retryable(Some(text)), "{text}");
        }
        for text in ["Gateway inference is unavailable", "HTTP 400", ""] {
            assert!(!is_retryable(Some(text)), "{text}");
        }
        assert!(!is_retryable(None));
    }
}
