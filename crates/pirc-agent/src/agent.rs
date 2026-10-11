//! The agent (`agent/agent.ts`): queues, the run loop, model calls with
//! retries and role fallbacks, tool execution through the policy chain
//! (validation, hooks, auto mode, write lease), and the API the RPC layer
//! drives. Built-in features (todo, goal, …) and PTC script execution are
//! M5's; their hook points in the TS loop are noted where they would run.

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
use crate::hooks::{HookName, HookRunner};
use crate::host::AgentHost;
use crate::messages::empty_usage;
use crate::ptc::{self, CapabilityRegistry, DIRECT_CAPABILITIES, WRAPPER_NAMES};
use crate::roles::{AgentRole, expand_models, read_roles};
use crate::rpc::Write;
use crate::session_store::{EntryData, SessionStore};
use crate::signal::{AbortController, AbortSignal};
use crate::stream::{StreamFn, StreamRequest};
use crate::tools::{AcquireWrite, Tool, ToolContext, ToolResult};
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

/// Runs on the final reply just before its `message_end`.
pub type BeforeEnd = Box<dyn FnMut(&AssistantMessage)>;

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
}

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

/// The UI with dialogs linked to the direct tool call that opens them
/// (`trackDialogs`).
struct TrackingUi {
    inner: Rc<dyn Ui>,
    agent: Weak<Agent>,
}

impl TrackingUi {
    fn link(&self, mut opts: DialogOptions) -> DialogOptions {
        if opts.tool_call_id.is_none()
            && let Some(agent) = self.agent.upgrade()
        {
            opts.tool_call_id = agent.current_operation.borrow().clone();
        }
        opts
    }
}

impl Ui for TrackingUi {
    fn select<'a>(
        &'a self,
        title: &'a str,
        options: &'a [String],
        opts: DialogOptions,
    ) -> LocalBoxFuture<'a, Option<String>> {
        self.inner.select(title, options, self.link(opts))
    }
    fn choose<'a>(
        &'a self,
        title: &'a str,
        options: &'a [Choice],
        multiple: bool,
        opts: DialogOptions,
    ) -> LocalBoxFuture<'a, Option<Vec<String>>> {
        self.inner.choose(title, options, multiple, self.link(opts))
    }
    fn confirm<'a>(
        &'a self,
        title: &'a str,
        message: &'a str,
        opts: DialogOptions,
    ) -> LocalBoxFuture<'a, Option<bool>> {
        self.inner.confirm(title, message, self.link(opts))
    }
    fn input<'a>(
        &'a self,
        title: &'a str,
        placeholder: Option<&'a str>,
        opts: DialogOptions,
    ) -> LocalBoxFuture<'a, Option<String>> {
        self.inner.input(title, placeholder, self.link(opts))
    }
    fn editor<'a>(
        &'a self,
        title: &'a str,
        prefill: Option<&'a str>,
        opts: DialogOptions,
    ) -> LocalBoxFuture<'a, Option<String>> {
        self.inner.editor(title, prefill, self.link(opts))
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
            }
        });
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

    /// `init`: the `sessionStart` hooks.
    pub async fn init(self: &Rc<Self>) {
        let extra = self.hooks.collect(HookName::SessionStart, Map::new()).await;
        *self.extra_system_prompt.borrow_mut() = extra;
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

    fn pending_count(&self) -> usize {
        self.steering.borrow().len() + self.follow_ups.borrow().len()
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
            "completionWaiting": [],
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

    /// `fallBack`: switch to the next fallback model; false when none.
    fn fall_back(&self, reason: &str) -> bool {
        let Some((provider, id)) = self.next_fallback() else {
            return false;
        };
        let from = self
            .model_ref
            .borrow()
            .as_ref()
            .map_or_else(|| "none".to_owned(), |(p, m)| format!("{p}/{m}"));
        if self.set_model(&provider, &id).is_err() {
            return false;
        }
        let (reason, _) = slice16(reason, 200);
        self.ui.notify(
            &format!("Model {from} failed ({reason}); switching to {provider}/{id}"),
            NotifyLevel::Warning,
        );
        true
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
    pub fn clear_queue(&self) -> Value {
        let cleared = json!({ "steering": Self::queue_texts(&self.steering.borrow()),
            "followUp": Self::queue_texts(&self.follow_ups.borrow()) });
        // `notificationsCleared` (features, M5) would get the custom messages.
        self.steering.borrow_mut().clear();
        self.follow_ups.borrow_mut().clear();
        self.emit_queue();
        cleared
    }

    /// Slash commands come from features (M5): none run here yet.
    fn try_command(&self, _text: &str) -> bool {
        false
    }

    /// `panelState`: merged across features (M5).
    pub fn panel_state(&self) -> Value {
        json!({})
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

    /// `commandList`: feature commands (M5).
    pub fn command_list(&self) -> Vec<Value> {
        Vec::new()
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
        self.start_run(vec![Self::user_item(text, images)]);
        Ok(())
    }

    pub fn steer(self: &Rc<Self>, text: String, images: Vec<UserBlock>) {
        if self.try_command(&text) {
            return;
        }
        let item = Self::user_item(text, images);
        if !self.running.get() {
            return self.start_run(vec![item]);
        }
        self.steering.borrow_mut().push(item);
        self.emit_queue();
    }

    pub fn follow_up(self: &Rc<Self>, text: String, images: Vec<UserBlock>) {
        if self.try_command(&text) {
            return;
        }
        let item = Self::user_item(text, images);
        if !self.running.get() {
            return self.start_run(vec![item]);
        }
        self.follow_ups.borrow_mut().push(item);
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
            return Ok(());
        }
        if trigger_turn {
            self.start_run(vec![item]);
        } else {
            self.append_message(message)?;
        }
        Ok(())
    }

    pub fn abort(&self) {
        // `abort` hooks of features (M5).
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
        // `beforeAgentStart` of features (M5) runs here.
        let pending = if self.hooks.has(HookName::BeforePrompt) {
            Some(initial)
        } else {
            if let Err(error) = self.admit_now(initial) {
                self.start_failed(&error);
            }
            None
        };
        let agent = self.clone();
        tokio::task::spawn_local(async move {
            let run = agent.clone();
            let signal = controller.signal();
            // A panic is a bug; it ends the run like a crash.
            let outcome =
                tokio::task::spawn_local(async move { run.run(signal, pending).await }).await;
            let error = match outcome {
                Ok(Ok(())) => None,
                Ok(Err(error)) => Some(error),
                Err(panic) => Some(
                    panic
                        .try_into_panic()
                        .ok()
                        .and_then(|panic| {
                            panic
                                .downcast_ref::<String>()
                                .cloned()
                                .or_else(|| panic.downcast_ref::<&str>().map(|s| (*s).to_owned()))
                        })
                        .unwrap_or_else(|| "unknown error".to_owned()),
                ),
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
        // `agentSettled` of features (M5) may queue work.
        if !self.running.get() && self.pending_count() > 0 {
            let mut next = std::mem::take(&mut *self.steering.borrow_mut());
            next.append(&mut self.follow_ups.borrow_mut());
            self.emit_queue();
            self.start_run(next);
        }
    }

    /// One queued item into the session, without hooks.
    fn admit_item(&self, item: QueueItem) -> Result<(), String> {
        match item {
            QueueItem::Custom(message) => {
                self.append_message(*message)?;
                // `messageAdmitted` of features (M5).
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
    fn stream_function(&self) -> Rc<dyn StreamFn> {
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
                if options.no_retries || !self.fall_back(&error) {
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
            if retryable && self.fall_back(message.error_message.as_deref().unwrap_or("error")) {
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
                if let Some(before_end) = options.before_end.as_mut() {
                    before_end(&message);
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
    ) -> Result<(), String> {
        if let Some(items) = pending
            && let Err(error) = self.admit(items).await
        {
            self.start_failed(&error);
        }
        *self.run_prompt.borrow_mut() = trim_sections(&[]);
        let max_turns = self.config.limits.max_turns;
        let mut turns: u64 = 0;
        let mut overflow_retried = false;
        while !signal.aborted() {
            turns += 1;
            if turns > max_turns {
                self.ui.notify(
                    &format!("Stopped after {max_turns} turns"),
                    NotifyLevel::Warning,
                );
                break;
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
            let failure: Rc<RefCell<Option<String>>> = Rc::new(RefCell::new(None));
            let (marker, failed) = (persisted.clone(), failure.clone());
            let agent = self.clone();
            let retried = overflow_retried;
            let settings_enabled = settings.enabled;
            let before_end: BeforeEnd = Box::new(move |reply| {
                if compaction::is_context_overflow(reply) && !retried && settings_enabled {
                    return;
                }
                match agent.append(EntryData::Message(Message::Assistant(reply.clone()))) {
                    Ok(_) => marker.set(true),
                    Err(error) => *failed.borrow_mut() = Some(error),
                }
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
            if let Some(error) = failure.borrow_mut().take() {
                return Err(error);
            }
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
            // `turnEnd` of features (M5).
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
            // Team completion waits and `agentEnd` hooks are features (M5).
            if signal.aborted() {
                break;
            }
            if self.pending_count() > 0 {
                let mut items = std::mem::take(&mut *self.steering.borrow_mut());
                if !self.follow_ups.borrow().is_empty() {
                    items.push(self.follow_ups.borrow_mut().remove(0));
                }
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

    pub async fn shutdown(&self) {
        self.abort();
        self.idle().await;
        // `shutdown` of features (M5).
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
