//! `page.screenshot` as `node/browser.ts` calls it: JPEG, `scale: 'css'`,
//! viewport or full page (Playwright's `screenshotter.ts` for Chromium).
//!
//! Playwright 1.63.0 with `{type: 'jpeg', quality, scale: 'css', fullPage,
//! timeout}` (so `caret: 'hide'`, animations allowed, no style, no mask),
//! one screenshot per page at a time, all within `timeout`:
//!
//! 1. the viewport size (the context's `viewport`, emulated);
//! 2. `inPagePrepareForScreenshots(undefined, true, false, false)` in every
//!    frame's utility world (carets of inputs, textareas and
//!    contenteditables made transparent), then `document.fonts.ready` in
//!    the main frame's;
//! 3. full page: the document's size from the main frame's utility world
//!    (polled until it has a body), clip `{0, 0, w, h, scale: 1}`,
//!    `captureBeyondViewport` unless it fits the viewport; viewport:
//!    `Page.getLayoutMetrics`, clip at the visual viewport's page offset,
//!    the viewport divided by its scale, `scale: visualViewport.scale`,
//!    `captureBeyondViewport: false`; `scale: 'css'` divides the clip's
//!    scale by the device scale factor (the viewport emulation's, 1);
//! 4. `Page.captureScreenshot {format: 'jpeg', quality, clip,
//!    captureBeyondViewport}`;
//! 5. `window.__pwCleanupScreenshot()` in every frame's utility world,
//!    also after a failure or timeout.
//!
//! Errors start with `screenshot: `, as the TS node's (Bun's) Playwright
//! client words them (a timeout is `screenshot: Timeout <n>ms exceeded.`).
//! Deviation: the utility worlds are reached through the frames' injected
//! scripts, so a frame without one gets it (Playwright evaluates only in
//! existing contexts).
//!
//! Ported from playwright-core 1.63.0 `src/server/screenshotter.ts`
//! (Apache-2.0, see `crates/pirc-node/NOTICE`).
//!
//! Owner: netio.

use std::time::Duration;

use base64::Engine as _;
use serde_json::{Value, json};

use super::cdp::{CdpError, Session};
use super::page::Page;
use super::{Error, Result};
use crate::browser::BoxFuture;

#[derive(Clone, Copy, Debug)]
pub struct ScreenshotOptions {
    /// JPEG quality (`browser.ts`: 70 for the agent, 45 for log
    /// thumbnails, 60 for a recording's first frame).
    pub quality: u8,
    pub full_page: bool,
    pub timeout: Duration,
}

/// What a screenshot needs from a page (the page itself, or a bare session
/// in tests).
pub trait Surface: Send + Sync {
    /// The main frame's session.
    fn session(&self) -> &Session;
    /// The emulated viewport, if any (`page.emulatedSize()?.viewport`).
    fn viewport(&self) -> Option<(u32, u32)>;
    /// The viewport emulation's device scale factor, if any
    /// (`_metricsOverride.deviceScaleFactor`).
    fn device_scale_factor(&self) -> Option<f64>;
    /// Call `function` (a JS function's source, no arguments) in every
    /// frame's utility world, ignoring failures
    /// (`safeNonStallingEvaluateInAllFrames`).
    fn in_all_frames<'a>(&'a self, function: &'a str) -> BoxFuture<'a, ()>;
    /// Call `function` in the main frame's utility world, by value.
    fn in_main_frame<'a>(&'a self, function: &'a str) -> BoxFuture<'a, Result<Value>>;
}

impl Surface for Page {
    fn session(&self) -> &Session {
        Page::session(self)
    }

    fn viewport(&self) -> Option<(u32, u32)> {
        Some(Page::viewport(self))
    }

    fn device_scale_factor(&self) -> Option<f64> {
        // `launchPersistentContext({viewport})` emulates it with 1.
        Some(1.0)
    }

    fn in_all_frames<'a>(&'a self, function: &'a str) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            futures_util::future::join_all(self.frames().into_iter().map(|frame| async move {
                if let Ok(injected) = frame.injected().await {
                    let _ = injected.call(function, Vec::new()).await;
                }
            }))
            .await;
        })
    }

    fn in_main_frame<'a>(&'a self, function: &'a str) -> BoxFuture<'a, Result<Value>> {
        Box::pin(async move {
            self.main_frame()
                .injected()
                .await?
                .call(function, Vec::new())
                .await
        })
    }
}

/// The JPEG bytes.
pub async fn capture(page: &Page, options: ScreenshotOptions) -> Result<Vec<u8>> {
    let started = std::time::Instant::now();
    let Ok(_queue) =
        tokio::time::timeout(options.timeout, page.screencast_state().screenshots.lock()).await
    else {
        return Err(Error::timeout("screenshot", options.timeout));
    };
    let remaining = options.timeout.saturating_sub(started.elapsed());
    let shot = capture_on(
        page,
        ScreenshotOptions {
            timeout: remaining,
            ..options
        },
    )
    .await;
    // The message names the whole timeout.
    shot.map_err(|error| {
        if error == Error::timeout("screenshot", remaining) {
            Error::timeout("screenshot", options.timeout)
        } else {
            error
        }
    })
}

/// `inPagePrepareForScreenshots` of `screenshotter.ts`, verbatim.
const PREPARE: &str = r#"function inPagePrepareForScreenshots(screenshotStyle, hideCaret, disableAnimations, syncAnimations) {
  if (syncAnimations) {
    const style = document.createElement("style");
    style.textContent = "body {}";
    document.head.appendChild(style);
    document.documentElement.getBoundingClientRect();
    style.remove();
  }
  if (!screenshotStyle && !hideCaret && !disableAnimations)
    return;
  const collectRoots = (root, roots2 = []) => {
    roots2.push(root);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    do {
      const node = walker.currentNode;
      const shadowRoot = node instanceof Element ? node.shadowRoot : null;
      if (shadowRoot)
        collectRoots(shadowRoot, roots2);
    } while (walker.nextNode());
    return roots2;
  };
  const roots = collectRoots(document);
  const cleanupCallbacks = [];
  if (screenshotStyle) {
    for (const root of roots) {
      const styleTag = document.createElement("style");
      styleTag.textContent = screenshotStyle;
      if (root === document)
        document.documentElement.append(styleTag);
      else
        root.append(styleTag);
      cleanupCallbacks.push(() => {
        styleTag.remove();
      });
    }
  }
  if (hideCaret) {
    const elements = /* @__PURE__ */ new Map();
    for (const root of roots) {
      root.querySelectorAll("input,textarea,[contenteditable]").forEach((element3) => {
        elements.set(element3, {
          value: element3.style.getPropertyValue("caret-color"),
          priority: element3.style.getPropertyPriority("caret-color")
        });
        element3.style.setProperty("caret-color", "transparent", "important");
      });
    }
    cleanupCallbacks.push(() => {
      for (const [element3, value2] of elements)
        element3.style.setProperty("caret-color", value2.value, value2.priority);
    });
  }
  if (disableAnimations) {
    const infiniteAnimationsToResume = /* @__PURE__ */ new Set();
    const handleAnimations = (root) => {
      for (const animation of root.getAnimations()) {
        if (!animation.effect || animation.playbackRate === 0 || infiniteAnimationsToResume.has(animation))
          continue;
        const endTime = animation.effect.getComputedTiming().endTime;
        if (Number.isFinite(endTime)) {
          try {
            animation.finish();
          } catch (e) {
          }
        } else {
          try {
            animation.cancel();
            infiniteAnimationsToResume.add(animation);
          } catch (e) {
          }
        }
      }
    };
    for (const root of roots) {
      const handleRootAnimations = handleAnimations.bind(null, root);
      handleRootAnimations();
      root.addEventListener("transitionrun", handleRootAnimations);
      root.addEventListener("animationstart", handleRootAnimations);
      cleanupCallbacks.push(() => {
        root.removeEventListener("transitionrun", handleRootAnimations);
        root.removeEventListener("animationstart", handleRootAnimations);
      });
    }
    cleanupCallbacks.push(() => {
      for (const animation of infiniteAnimationsToResume) {
        try {
          animation.play();
        } catch (e) {
        }
      }
    });
  }
  window.__pwCleanupScreenshot = () => {
    for (const cleanupCallback of cleanupCallbacks)
      cleanupCallback();
    delete window.__pwCleanupScreenshot;
  };
}"#;

/// The prepare call `page.screenshot` makes for pirc's options.
pub fn prepare_function() -> String {
    format!("function() {{ ({PREPARE})(undefined, true, false, false); }}")
}

/// `_restorePageAfterScreenshot`.
pub const RESTORE: &str =
    "function() { window.__pwCleanupScreenshot && window.__pwCleanupScreenshot(); }";

/// `document.fonts.ready` (its value is not needed).
const FONTS_READY: &str = "function() { return document.fonts.ready.then(() => undefined); }";

/// `_fullPageSize`'s function, as `waitForFunctionValueInUtility` wraps it.
const FULL_PAGE_SIZE: &str = "function() {
  if (!document.body || !document.documentElement)
    return null;
  return {
    width: Math.max(
      document.body.scrollWidth,
      document.documentElement.scrollWidth,
      document.body.offsetWidth,
      document.documentElement.offsetWidth,
      document.body.clientWidth,
      document.documentElement.clientWidth
    ),
    height: Math.max(
      document.body.scrollHeight,
      document.documentElement.scrollHeight,
      document.body.offsetHeight,
      document.documentElement.offsetHeight,
      document.body.clientHeight,
      document.documentElement.clientHeight
    )
  };
}";

/// `window.innerWidth/innerHeight` (`_originalViewportSize` without
/// emulation).
const INNER_SIZE: &str =
    "function() { return { width: window.innerWidth, height: window.innerHeight }; }";

fn api_error(method: &str, error: CdpError) -> Error {
    if error == CdpError::closed() {
        Error::new(format!("screenshot: {}", error.message))
    } else {
        Error::new(format!(
            "screenshot: Protocol error ({method}): {}",
            error.message
        ))
    }
}

/// `waitForFunctionValueInUtility`: poll until the value is truthy.
async fn poll_value(surface: &dyn Surface, function: &str) -> Result<Value> {
    loop {
        let value = surface.in_main_frame(function).await;
        match value {
            Ok(value) if !value.is_null() && value != json!(false) => return Ok(value),
            // A navigation may destroy the context meanwhile: retry.
            _ => tokio::time::sleep(Duration::from_millis(16)).await,
        }
    }
}

fn size_of(value: &Value) -> (f64, f64) {
    (
        value["width"].as_f64().unwrap_or(0.0),
        value["height"].as_f64().unwrap_or(0.0),
    )
}

/// `screenshotPage` on any [`Surface`] (the caller serializes).
pub async fn capture_on(surface: &dyn Surface, options: ScreenshotOptions) -> Result<Vec<u8>> {
    let prepared = std::sync::atomic::AtomicBool::new(false);
    let result = tokio::time::timeout(options.timeout, async {
        let viewport = match surface.viewport() {
            Some((width, height)) => (f64::from(width), f64::from(height)),
            None => size_of(&poll_value(surface, INNER_SIZE).await?),
        };
        prepared.store(true, std::sync::atomic::Ordering::SeqCst);
        surface.in_all_frames(&prepare_function()).await;
        let _ = surface.in_main_frame(FONTS_READY).await;
        let shot = take(surface, options, viewport).await;
        surface.in_all_frames(RESTORE).await;
        shot
    })
    .await;
    match result {
        Ok(shot) => shot,
        Err(_) => {
            if prepared.load(std::sync::atomic::Ordering::SeqCst) {
                // Playwright's cleanup still runs after its timeout.
                surface.in_all_frames(RESTORE).await;
            }
            Err(Error::timeout("screenshot", options.timeout))
        }
    }
}

/// `_screenshot` and `CRPage.takeScreenshot`.
async fn take(
    surface: &dyn Surface,
    options: ScreenshotOptions,
    viewport: (f64, f64),
) -> Result<Vec<u8>> {
    let session = surface.session();
    let (document, viewport_rect, fits) = if options.full_page {
        let (width, height) = size_of(&poll_value(surface, FULL_PAGE_SIZE).await?);
        let fits = width <= viewport.0 && height <= viewport.1;
        (Some((0.0, 0.0, width, height)), false, fits)
    } else {
        (None, true, true)
    };
    let metrics = session
        .call("Page.getLayoutMetrics", json!({}))
        .await
        .map_err(|e| api_error("Page.getLayoutMetrics", e))?;
    let visual = &metrics["visualViewport"];
    let scale = visual["scale"].as_f64().unwrap_or(1.0);
    let (x, y, width, height) = document.unwrap_or_else(|| {
        (
            visual["pageX"].as_f64().unwrap_or(0.0),
            visual["pageY"].as_f64().unwrap_or(0.0),
            // `helper.enclosingIntSize`
            (viewport.0 / scale + 1e-3).floor(),
            (viewport.1 / scale + 1e-3).floor(),
        )
    });
    let mut clip_scale = if viewport_rect { scale } else { 1.0 };
    // `scale: 'css'`
    let device_scale_factor = surface
        .device_scale_factor()
        .filter(|factor| *factor != 0.0)
        .or_else(|| {
            let content = metrics["contentSize"]["width"].as_f64()?;
            let css = metrics["cssContentSize"]["width"].as_f64()?;
            Some(content / css).filter(|factor| factor.is_finite() && *factor != 0.0)
        })
        .unwrap_or(1.0);
    clip_scale /= device_scale_factor;
    let result = session
        .call(
            "Page.captureScreenshot",
            json!({
                "format": "jpeg",
                "quality": options.quality,
                "clip": { "x": x, "y": y, "width": width, "height": height, "scale": clip_scale },
                "captureBeyondViewport": !fits,
            }),
        )
        .await
        .map_err(|e| api_error("Page.captureScreenshot", e))?;
    base64::engine::general_purpose::STANDARD
        .decode(result["data"].as_str().unwrap_or_default())
        .map_err(|e| Error::new(format!("screenshot: {e}")))
}
