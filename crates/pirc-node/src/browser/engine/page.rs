//! A page: Playwright's `Page` with its `FrameManager` and `CRPage`
//! (`crPage.ts`, `frames.ts`, `page.ts`): the frame tree across sessions
//! (out-of-process iframes are child sessions whose frame keeps its
//! sequence number), navigation and history with Playwright's waits, load
//! states and `networkidle`, popups, title, content, and the input devices,
//! screenshot and screencast of [`super::input`], [`super::screenshot`] and
//! [`super::screencast`].
//!
//! Owner: core.

use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use tokio::sync::mpsc;

use super::cdp::Session;
use super::frame::Frame;
use super::input::{Keyboard, Mouse};
use super::screencast::{ScreencastFrame, ScreencastOptions, ScreencastState};
use super::screenshot::ScreenshotOptions;
use super::{LoadState, Result};

/// What a page reports to its subscribers.
#[derive(Clone)]
pub enum PageEvent {
    /// A page this page opened (`page.on('popup')`), already initialized.
    Popup(Arc<Page>),
    /// The main frame navigated (`framenavigated` for the main frame).
    MainFrameNavigated,
    /// `load`.
    Load,
    /// The page closed (`close`); the last event.
    Closed,
}

/// The main frame's response to a navigation (`response.status()`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Response {
    pub status: u16,
}

pub struct Page {
    _todo: (),
}

impl Page {
    /// The CDP target id (stable for the page's life).
    pub fn target_id(&self) -> &str {
        todo!("core")
    }

    /// The page's own session (the main frame's).
    pub fn session(&self) -> &Session {
        todo!("core")
    }

    /// Events from now on, until [`PageEvent::Closed`].
    pub fn subscribe(&self) -> mpsc::UnboundedReceiver<PageEvent> {
        todo!("core")
    }

    /// The main frame's URL (`page.url()`).
    pub fn url(&self) -> String {
        todo!("core")
    }

    /// `page.title()`.
    pub async fn title(&self) -> Result<String> {
        todo!("core")
    }

    /// `page.content()`: the main frame's serialized HTML.
    pub async fn content(&self) -> Result<String> {
        todo!("core")
    }

    pub fn main_frame(&self) -> Frame {
        todo!("core")
    }

    /// Every attached frame, main frame first, in document order
    /// (`page.frames()`).
    pub fn frames(&self) -> Vec<Frame> {
        todo!("core")
    }

    /// The frame with Playwright sequence number `seq` (`f<seq>e<n>` refs).
    pub fn frame_by_seq(&self, _seq: u64) -> Option<Frame> {
        todo!("core")
    }

    /// `page.goto(url, {waitUntil, timeout})`: the main frame's response,
    /// `None` for same-document or `about:` navigations. Errors as
    /// Playwright's (`page.goto: net::ERR_… at <url>`, timeouts).
    pub async fn goto(
        &self,
        _url: &str,
        _wait_until: LoadState,
        _timeout: Duration,
    ) -> Result<Option<Response>> {
        todo!("core")
    }

    /// `page.goBack({waitUntil, timeout})`; no history entry is not an error.
    pub async fn go_back(&self, _wait_until: LoadState, _timeout: Duration) -> Result<()> {
        todo!("core")
    }

    /// `page.goForward({timeout})` (waits for `load`).
    pub async fn go_forward(&self, _timeout: Duration) -> Result<()> {
        todo!("core")
    }

    /// `page.reload({timeout})` (waits for `load`).
    pub async fn reload(&self, _timeout: Duration) -> Result<()> {
        todo!("core")
    }

    /// `page.waitForLoadState(state, {timeout})` for the main frame.
    pub async fn wait_for_load_state(&self, _state: LoadState, _timeout: Duration) -> Result<()> {
        todo!("core")
    }

    /// `page.evaluate(fn, arg)` in the main frame's main world.
    pub async fn evaluate(&self, function: &str, arg: Value) -> Result<Value> {
        self.main_frame().evaluate(function, arg).await
    }

    pub fn viewport(&self) -> (u32, u32) {
        todo!("core")
    }

    pub fn keyboard(&self) -> &Keyboard {
        todo!("core")
    }

    pub fn mouse(&self) -> &Mouse {
        todo!("core")
    }

    /// The screencast's state, kept with the page for [`super::screencast`].
    pub fn screencast_state(&self) -> &ScreencastState {
        todo!("core")
    }

    /// `page.screenshot(options)`: the encoded image.
    pub async fn screenshot(&self, options: ScreenshotOptions) -> Result<Vec<u8>> {
        super::screenshot::capture(self, options).await
    }

    /// Start (or restart with new options) the page's screencast; frames go
    /// to `sink` until [`Page::stop_screencast`] or the page closes.
    pub async fn start_screencast(
        &self,
        options: ScreencastOptions,
        sink: Arc<dyn Fn(ScreencastFrame) + Send + Sync>,
    ) -> Result<()> {
        super::screencast::start(self, options, sink).await
    }

    pub async fn stop_screencast(&self) -> Result<()> {
        super::screencast::stop(self).await
    }

    /// `page.bringToFront()`.
    pub async fn bring_to_front(&self) -> Result<()> {
        todo!("core")
    }

    /// `page.close()`.
    pub async fn close(&self) -> Result<()> {
        todo!("core")
    }

    pub fn is_closed(&self) -> bool {
        todo!("core")
    }
}
