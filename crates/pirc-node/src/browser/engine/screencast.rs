//! The page's screencast (`page.screencast.start({size, quality,
//! onFrame})` in `node/browser.ts`): `Page.startScreencast` JPEG frames at
//! most `size` (rounded down to even, as Playwright does), each
//! acknowledged once the sink returned. Playwright's action overlay
//! (`screencast.showActions({duration: 600})`) is part of it.
//!
//! Playwright 1.63.0 (`server/screencast.ts`, `CRPage.startScreencast`,
//! `FrameSession._onScreencastFrame`): `Page.startScreencast {format:
//! 'jpeg', quality, maxWidth, maxHeight}` on the page's main session, each
//! `Page.screencastFrame` (`data` base64, `metadata.deviceWidth` /
//! `deviceHeight`) handed to the client, then `Page.screencastFrameAck
//! {sessionId}` (the frame's number, not a CDP session); stopping sends
//! `Page.stopScreencast`. Errors of start and stop are ignored, as there.
//! pirc has one client per page (the manager fans frames out), so the
//! cached-frame replay for later clients is the manager's.
//!
//! `showActions`: before every input action (`onBeforeInputAction`, see
//! [`announce`]) Playwright shows the action on the page (the injected
//! script's `setScreencastAnnotation`: the point, the element's box, the
//! action's title) for `duration` ms, *waiting that long before the action
//! runs*, then removes it. It does so whether or not a screencast runs:
//! with `node/browser.ts`'s 600 ms, every agent and viewer input waits
//! 600 ms (measured with Playwright 1.63.0: `keyboard.press` 633 ms,
//! `mouse.move` 623 ms, `locator.click` 653 ms). Ported as is. Deviation:
//! the announcement is bounded (`duration` + 2 s; the action goes on after
//! that), where Playwright waits for the main frame's utility world within
//! the action's timeout.
//!
//! Ported from playwright-core 1.63.0 `src/server/screencast.ts`,
//! `src/server/chromium/crPage.ts` (Apache-2.0, see
//! `crates/pirc-node/NOTICE`).

use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine as _;
use serde_json::{Value, json};
use tokio::task::JoinHandle;

use super::Result;
use super::cdp::Session;
use super::frame::Arg;
use super::page::Page;

#[derive(Clone, Copy, Debug)]
pub struct ScreencastOptions {
    pub width: u32,
    pub height: u32,
    pub quality: u8,
}

/// One frame: the JPEG and the page's size it shows (`deviceWidth`,
/// `deviceHeight`).
#[derive(Clone, Debug)]
pub struct ScreencastFrame {
    pub jpeg: Arc<Vec<u8>>,
    pub width: u32,
    pub height: u32,
}

/// `screencast.showActions(options)`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ShowActions {
    /// How long each action is shown (and delayed), Playwright's default
    /// 500 ms.
    pub duration: Duration,
}

/// Per-page screencast state, kept by the page.
#[derive(Default)]
pub struct ScreencastState {
    /// The task handing frames to the sink while a screencast runs.
    running: Mutex<Option<JoinHandle<()>>>,
    actions: Mutex<Option<ShowActions>>,
    /// Screenshots of the page run one at a time (`Screenshotter`'s
    /// queue).
    pub(super) screenshots: tokio::sync::Mutex<()>,
}

impl ScreencastState {
    pub fn show_actions(&self, actions: Option<ShowActions>) {
        *self.actions.lock().unwrap() = actions;
    }

    pub fn actions(&self) -> Option<ShowActions> {
        *self.actions.lock().unwrap()
    }

    pub fn is_running(&self) -> bool {
        self.running.lock().unwrap().is_some()
    }
}

impl Drop for ScreencastState {
    fn drop(&mut self) {
        if let Some(task) = self.running.get_mut().unwrap().take() {
            task.abort();
        }
    }
}

pub async fn start(
    page: &Page,
    options: ScreencastOptions,
    sink: Arc<dyn Fn(ScreencastFrame) + Send + Sync>,
) -> Result<()> {
    start_on(page.session(), page.screencast_state(), options, sink).await
}

pub async fn stop(page: &Page) -> Result<()> {
    stop_on(page.session(), page.screencast_state()).await
}

/// [`start`] on a page's main session and state: a running screencast is
/// stopped first (a restart with the new options).
pub async fn start_on(
    session: &Session,
    state: &ScreencastState,
    options: ScreencastOptions,
    sink: Arc<dyn Fn(ScreencastFrame) + Send + Sync>,
) -> Result<()> {
    stop_on(session, state).await?;
    let mut events = session.listen();
    let acks = session.clone();
    let task = tokio::spawn(async move {
        while let Some(event) = events.recv().await {
            if event.method != "Page.screencastFrame" {
                continue;
            }
            if let Some(frame) = decode_frame(&event.params) {
                sink(frame);
            }
            let _ = acks
                .call(
                    "Page.screencastFrameAck",
                    json!({ "sessionId": event.params["sessionId"] }),
                )
                .await;
        }
    });
    *state.running.lock().unwrap() = Some(task);
    let _ = session
        .call(
            "Page.startScreencast",
            json!({
                "format": "jpeg",
                "quality": options.quality,
                "maxWidth": options.width & !1,
                "maxHeight": options.height & !1,
            }),
        )
        .await;
    Ok(())
}

/// [`stop`] on a page's main session and state; nothing when none runs.
pub async fn stop_on(session: &Session, state: &ScreencastState) -> Result<()> {
    let running = state.running.lock().unwrap().take();
    if let Some(task) = running {
        task.abort();
        let _ = session.call("Page.stopScreencast", json!({})).await;
    }
    Ok(())
}

fn decode_frame(params: &Value) -> Option<ScreencastFrame> {
    let jpeg = base64::engine::general_purpose::STANDARD
        .decode(params["data"].as_str()?)
        .ok()?;
    let size = |name: &str| params["metadata"][name].as_f64().unwrap_or(0.0).round() as u32;
    Some(ScreencastFrame {
        jpeg: Arc::new(jpeg),
        width: size("deviceWidth"),
        height: size("deviceHeight"),
    })
}

/// `page.screencast.showActions({duration})` (`None`: `hideActions`).
pub fn show_actions(page: &Page, actions: Option<ShowActions>) {
    page.screencast_state().show_actions(actions);
}

/// An element's box in the main frame's viewport (`box` of
/// `onBeforeInputAction`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// What `Screencast.onBeforeInputAction` evaluates in the main frame's
/// utility world (`this` is the injected script).
const ANNOTATE: &str = "async function(options) {
  const injected = this;
  injected.setScreencastAnnotation(options);
  await new Promise((f) => injected.utils.builtins.setTimeout(f, options.duration));
  injected.setScreencastAnnotation(null);
}";

/// The annotation's options (`setScreencastAnnotation`'s argument).
pub fn annotation(
    actions: ShowActions,
    title: &str,
    point: Option<(f64, f64)>,
    rect: Option<Rect>,
) -> Value {
    let mut options = json!({
        "duration": actions.duration.as_millis() as u64,
        "actionTitle": title,
        "cursor": "pointer",
    });
    if let Some((x, y)) = point {
        options["point"] = json!({ "x": x, "y": y });
    }
    if let Some(rect) = rect {
        options["box"] =
            json!({ "x": rect.x, "y": rect.y, "width": rect.width, "height": rect.height });
    }
    options
}

/// `onBeforeInputAction`: with `showActions` on, show the action `title`
/// (Playwright's rendered call title, e.g. `Press "Enter"`, `Mouse move`,
/// `Click`) at `point` / around `rect` and wait out the duration. Element
/// actions pass their element's box.
///
/// As Playwright's, the action fails when the main frame's injected script
/// cannot be had (its context destroyed while it is created, the page
/// closed), while a failure of the annotation itself is ignored (a
/// navigation ends its wait at once).
pub async fn announce(
    page: &Page,
    title: &str,
    point: Option<(f64, f64)>,
    rect: Option<Rect>,
) -> Result<()> {
    let Some(actions) = page.screencast_state().actions() else {
        return Ok(());
    };
    let options = annotation(actions, title, point, rect);
    let deadline = tokio::time::Instant::now() + actions.duration + Duration::from_secs(2);
    let main = page.main_frame();
    let (injected, uid) = match tokio::time::timeout_at(deadline, main.injected_in_context()).await
    {
        Ok(found) => found?,
        Err(_) => return Ok(()),
    };
    let shown = main.call_in_context(uid, &injected, ANNOTATE, vec![Arg::Value(options)], true);
    let _ = tokio::time::timeout_at(deadline, shown).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shapes_the_annotation_as_playwright() {
        let actions = ShowActions {
            duration: Duration::from_millis(600),
        };
        assert_eq!(
            annotation(actions, "Mouse move", Some((10.0, 20.5)), None),
            json!({ "duration": 600, "actionTitle": "Mouse move", "cursor": "pointer",
                "point": { "x": 10.0, "y": 20.5 } })
        );
        assert_eq!(
            annotation(
                actions,
                "Click",
                Some((1.0, 2.0)),
                Some(Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 4.0,
                    height: 3.0
                })
            )["box"],
            json!({ "x": 0.0, "y": 0.0, "width": 4.0, "height": 3.0 })
        );
    }

    #[test]
    fn decodes_frames() {
        let frame = decode_frame(&json!({ "data": "/9j/", "sessionId": 3,
            "metadata": { "deviceWidth": 1280.0, "deviceHeight": 799.6 } }))
        .unwrap();
        assert_eq!(*frame.jpeg, vec![0xff, 0xd8, 0xff]);
        assert_eq!((frame.width, frame.height), (1280, 800));
    }
}
