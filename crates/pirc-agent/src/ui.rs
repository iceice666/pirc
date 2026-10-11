//! What tools and features may ask of the human (`UiApi` in
//! `agent/tools/types.ts`). Under a node it is the RPC peer
//! (`rpc::RpcUi`): dialogs are `extension_ui_request`s.

use crate::LocalBoxFuture;
use crate::signal::AbortSignal;

/// `DialogOptions`.
#[derive(Clone, Default)]
pub struct DialogOptions {
    pub signal: Option<AbortSignal>,
    pub timeout_ms: Option<u64>,
    /// The `ptc` operation this dialog belongs to.
    pub tool_call_id: Option<String>,
}

/// One option of a rich choice dialog.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Choice {
    pub label: String,
    pub description: Option<String>,
}

/// `notify` levels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NotifyLevel {
    Info,
    Warning,
    Error,
}

impl NotifyLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Info => "info",
            Self::Warning => "warning",
            Self::Error => "error",
        }
    }
}

/// `UiApi`. Dialogs resolve to `None` when cancelled.
pub trait Ui {
    fn select<'a>(
        &'a self,
        title: &'a str,
        options: &'a [String],
        opts: DialogOptions,
    ) -> LocalBoxFuture<'a, Option<String>>;
    fn choose<'a>(
        &'a self,
        title: &'a str,
        options: &'a [Choice],
        multiple: bool,
        opts: DialogOptions,
    ) -> LocalBoxFuture<'a, Option<Vec<String>>>;
    fn confirm<'a>(
        &'a self,
        title: &'a str,
        message: &'a str,
        opts: DialogOptions,
    ) -> LocalBoxFuture<'a, Option<bool>>;
    fn input<'a>(
        &'a self,
        title: &'a str,
        placeholder: Option<&'a str>,
        opts: DialogOptions,
    ) -> LocalBoxFuture<'a, Option<String>>;
    fn editor<'a>(
        &'a self,
        title: &'a str,
        prefill: Option<&'a str>,
        opts: DialogOptions,
    ) -> LocalBoxFuture<'a, Option<String>>;
    fn notify(&self, message: &str, level: NotifyLevel);
    fn set_status(&self, key: &str, text: Option<&str>);
    fn set_widget(&self, key: &str, lines: Option<&[String]>);
}
