//! What viewers see: the state, the action log with its thumbnails, the
//! screencast (`attach`, `view`, `emitState`, `log`, `syncScreencast`,
//! `scheduleFrame` of `browser.ts`), and the agent/user mode.

use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use serde_json::{Value, json};
use tokio::time::Instant;

use super::seam::{FrameSink as CastSink, PageRef};
use super::{
    Detach, FrameSink, Inner, LOG_LIMIT, LastFrame, LogEntry, Mode, Tab, TabState, same, spawn,
};
use crate::browser::engine::screencast::{ScreencastFrame, ScreencastOptions};
use crate::browser::engine::screenshot::ScreenshotOptions;
use crate::error::ApiError;

/// At most one frame per this long to viewers (`FRAME_INTERVAL_MS`).
const FRAME_INTERVAL: Duration = Duration::from_millis(80);

pub(super) fn base64(data: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(data)
}

fn frame_message(frame: &LastFrame) -> Value {
    json!({ "type": "frame", "data": base64(&frame.jpeg), "width": frame.width,
        "height": frame.height })
}

impl Inner {
    /// `attach(sessionId, viewer)`: never launches anything.
    pub(super) fn attach(self: &Arc<Self>, session: &str, send: FrameSink) -> Detach {
        let id = self.next_seq();
        let tab = {
            let mut state = self.lock();
            state
                .viewers
                .entry(session.to_owned())
                .or_default()
                .push((id, send.clone()));
            state.tabs.get(session).cloned()
        };
        let (view, entries, frame) = match &tab {
            Some(tab) => {
                let st = tab.lock();
                (
                    self.view_of(Some(&st)),
                    st.log.iter().map(LogEntry::view).collect::<Vec<_>>(),
                    st.last_frame.clone(),
                )
            }
            None => (self.view_of(None), Vec::new(), None),
        };
        send(json!({ "type": "state", "state": view }));
        send(json!({ "type": "log", "entries": entries }));
        if let Some(tab) = &tab {
            tab.touch();
            self.sync_screencast(tab);
            if let Some(frame) = frame {
                send(frame_message(&frame));
            }
        }
        let inner = self.clone();
        let session = session.to_owned();
        Box::new(move || {
            let current = {
                let mut state = inner.lock();
                if let Some(viewers) = state.viewers.get_mut(&session) {
                    viewers.retain(|(viewer, _)| *viewer != id);
                    if viewers.is_empty() {
                        state.viewers.remove(&session);
                    }
                }
                state.tabs.get(&session).cloned()
            };
            if let Some(tab) = current {
                inner.sync_screencast(&tab);
            }
        })
    }

    pub(super) fn has_viewers(&self, session: &str) -> bool {
        self.lock()
            .viewers
            .get(session)
            .is_some_and(|viewers| !viewers.is_empty())
    }

    /// Send `frame` to the session's viewers; a failing (panicking) viewer
    /// does not stop the others.
    pub(super) fn broadcast(&self, session: &str, frame: &Value) {
        let sinks: Vec<FrameSink> = self
            .lock()
            .viewers
            .get(session)
            .map(|viewers| viewers.iter().map(|(_, sink)| sink.clone()).collect())
            .unwrap_or_default();
        for sink in sinks {
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| sink(frame.clone())));
        }
    }

    pub(super) fn view(&self, tab: Option<&Tab>) -> Value {
        match tab {
            Some(tab) => self.view_of(Some(&tab.lock())),
            None => self.view_of(None),
        }
    }

    /// `view(tab)`: `BrowserViewState` with empty titles.
    pub(super) fn view_of(&self, st: Option<&TabState>) -> Value {
        let active = st.and_then(|st| st.active.clone());
        let (width, height) = self.viewport();
        let tabs: Vec<Value> = st
            .map(|st| {
                st.pages
                    .iter()
                    .enumerate()
                    .map(|(index, page)| {
                        json!({ "index": index, "url": page.url(), "title": "",
                            "active": active.as_ref().is_some_and(|active| same(active, page)) })
                    })
                    .collect()
            })
            .unwrap_or_default();
        json!({
            "active": st.is_some_and(|st| !st.closed && st.active.is_some()),
            "url": active.as_ref().map(|page| page.url()).unwrap_or_default(),
            "title": "",
            "mode": st.map_or(Mode::Agent, |st| st.mode).as_str(),
            "handoff": st.and_then(|st| st.handoff.clone()),
            "agentWaiting": st.is_some_and(|st| st.waiting > 0),
            "action": st.and_then(|st| st.action.clone()),
            "recording": st.and_then(|st| st.recording.as_ref()).map(|active| json!({
                "path": active.recording.relative,
                "startedAt": active.recording.started_at,
            })),
            "tabs": tabs,
            "viewport": { "width": width, "height": height },
        })
    }

    pub(super) fn emit_state(self: &Arc<Self>, tab: &Arc<Tab>) {
        let st = tab.lock();
        self.emit_state_with(tab, &st);
    }

    /// `emitState(tab)` with the tab already locked: the state now, its
    /// titles filled in without blocking (so a state may arrive after a
    /// later one, as in TS).
    pub(super) fn emit_state_with(self: &Arc<Self>, tab: &Tab, st: &TabState) {
        let mut state = self.view_of(Some(st));
        let pages = st.pages.clone();
        let session = tab.session().to_owned();
        let inner = self.clone();
        spawn(async move {
            if !inner.has_viewers(&session) {
                return;
            }
            let titles = futures_util::future::join_all(
                pages
                    .iter()
                    .map(|page| async move { page.title().await.unwrap_or_default() }),
            )
            .await;
            let mut active_title = String::new();
            if let Some(tabs) = state["tabs"].as_array_mut() {
                for (tab, title) in tabs.iter_mut().zip(titles) {
                    if tab["active"] == true {
                        active_title.clone_from(&title);
                    }
                    tab["title"] = Value::String(title);
                }
            }
            state["title"] = Value::String(active_title);
            inner.broadcast(&session, &json!({ "type": "state", "state": state }));
        });
    }

    /// `log(tab, actor, action, jpeg)`: an action log entry (at most 300
    /// UTF-16 code units of text; typed text is never logged).
    pub(super) fn log(&self, tab: &Tab, actor: &'static str, action: &str, jpeg: Option<Vec<u8>>) {
        let view = {
            let mut st = tab.lock();
            let entry = LogEntry {
                index: st.log_count,
                at: crate::util::now_ms(),
                actor,
                action: crate::util::head16(action, 300).to_owned(),
                url: st
                    .active
                    .as_ref()
                    .map(|page| page.url())
                    .unwrap_or_default(),
                jpeg: jpeg.map(Arc::new),
            };
            st.log_count += 1;
            let view = entry.view();
            st.log.push_back(entry);
            while st.log.len() > LOG_LIMIT {
                st.log.pop_front();
            }
            view
        };
        self.broadcast(
            tab.session(),
            &json!({ "type": "log_entry", "entry": view }),
        );
    }

    /// `log_image`: a retained entry's thumbnail.
    pub(super) fn log_image(&self, session: &str, index: i64) -> Value {
        let tab = self.lock().tabs.get(session).cloned();
        let data = tab.and_then(|tab| {
            let st = tab.lock();
            st.log
                .iter()
                .find(|entry| entry.index as i64 == index)
                .and_then(|entry| entry.jpeg.as_ref().map(|jpeg| base64(jpeg)))
        });
        json!({ "type": "log_image", "index": index, "data": data })
    }

    /// `thumbnail(page)`: a JPEG (quality 45) of the page for the log, or
    /// none.
    pub(super) async fn thumbnail(&self, page: Option<PageRef>) -> Option<Vec<u8>> {
        let page = page?;
        page.screenshot(ScreenshotOptions {
            quality: 45,
            full_page: false,
            timeout: Duration::from_secs(3),
        })
        .await
        .ok()
    }

    // ---- screencast ---------------------------------------------------------

    /// `syncScreencast(tab)`: the active page is cast while the tab has
    /// viewers or records; changes run one at a time.
    pub(super) fn sync_screencast(self: &Arc<Self>, tab: &Arc<Tab>) {
        let inner = self.clone();
        let tab = tab.clone();
        spawn(async move {
            let _chain = tab.cast.lock().await;
            let watched = inner.has_viewers(tab.session());
            let old = {
                let mut st = tab.lock();
                let want = if !st.closed && (watched || st.recording.is_some()) {
                    st.active.clone()
                } else {
                    None
                };
                match (&st.screencast, &want) {
                    (None, None) => return,
                    (Some(current), Some(want)) if same(current, want) => return,
                    _ => {}
                }
                let old = st.screencast.take();
                (old, want)
            };
            let (old, want) = old;
            if let Some(old) = old {
                let _ = old.stop_screencast().await;
            }
            let Some(want) = want else { return };
            tab.lock().screencast = Some(want.clone());
            let (width, height) = inner.viewport();
            let options = ScreencastOptions {
                width,
                height,
                quality: 60,
            };
            let sink = frame_sink(Arc::downgrade(&inner), Arc::downgrade(&tab), &want);
            if want.start_screencast(options, sink).await.is_err() {
                let mut st = tab.lock();
                if st.screencast.as_ref().is_some_and(|cast| same(cast, &want)) {
                    st.screencast = None;
                }
            }
        });
    }

    /// `scheduleFrame(tab)`: at most one frame per [`FRAME_INTERVAL`] to
    /// viewers; the latest always goes out.
    fn schedule_frame(self: &Arc<Self>, tab: &Arc<Tab>, st: &mut TabState) {
        if st.frame_timer.is_some() {
            return;
        }
        let now = Instant::now();
        let wait = st.last_sent.map_or(Duration::ZERO, |sent| {
            (sent + FRAME_INTERVAL).saturating_duration_since(now)
        });
        let inner = self.clone();
        let tab = tab.clone();
        st.frame_timer = spawn(async move {
            tokio::time::sleep(wait).await;
            let frame = {
                let mut st = tab.lock();
                st.frame_timer = None;
                st.last_sent = Some(Instant::now());
                st.last_frame.clone()
            };
            let Some(frame) = frame else { return };
            if inner.has_viewers(tab.session()) {
                inner.broadcast(tab.session(), &frame_message(&frame));
            }
        });
    }

    // ---- control ------------------------------------------------------------

    /// Wake the tab's mode waiters (each `done` of `waitForAgentMode`, run
    /// by the waker so the state changes at once as in TS).
    pub(super) fn wake_waiters(
        self: &Arc<Self>,
        tab: &Tab,
        st: &mut TabState,
        error: Option<ApiError>,
    ) {
        for (_, wake) in std::mem::take(&mut st.waiters) {
            st.waiting = st.waiting.saturating_sub(1);
            self.emit_state_with(tab, st);
            let _ = wake.send(error.clone());
        }
    }

    /// `setMode(tab, mode, handoff)`.
    pub(super) fn set_mode(self: &Arc<Self>, tab: &Arc<Tab>, mode: Mode, handoff: Option<String>) {
        let mut st = tab.lock();
        st.mode = mode;
        st.handoff = if mode == Mode::User { handoff } else { None };
        if mode == Mode::Agent {
            self.wake_waiters(tab, &mut st, None);
        }
        self.emit_state_with(tab, &st);
    }
}

/// The screencast's `onFrame`: the latest frame of the page being cast.
fn frame_sink(
    inner: std::sync::Weak<Inner>,
    tab: std::sync::Weak<Tab>,
    page: &PageRef,
) -> CastSink {
    let page = Arc::downgrade(page);
    Arc::new(move |frame: ScreencastFrame| {
        let (Some(inner), Some(tab), Some(page)) = (inner.upgrade(), tab.upgrade(), page.upgrade())
        else {
            return;
        };
        let mut st = tab.lock();
        if !st.screencast.as_ref().is_some_and(|cast| same(cast, &page)) {
            return;
        }
        st.last_frame = Some(LastFrame {
            jpeg: frame.jpeg,
            width: frame.width,
            height: frame.height,
        });
        inner.schedule_frame(&tab, &mut st);
    })
}
