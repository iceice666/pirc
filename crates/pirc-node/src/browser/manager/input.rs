//! A viewer's messages (`input`/`handleInput` of `browser.ts`): control
//! (takeover, release), recording, and the user's navigation, mouse and
//! keyboard while they hold control.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};

use super::ops::saved;
use super::{Inner, Mode, OpError, closing_error};
use crate::browser::BrowserTarget;
use crate::browser::engine::{LoadState, MouseButton};
use crate::browser::util::{arg, check_url, int_arg, js_string, num_arg};
use crate::error::ApiResult;

/// JS's `Number.MAX_SAFE_INTEGER`.
const MAX_SAFE_INTEGER: i64 = (1 << 53) - 1;

fn error_frame(code: &str, message: &str) -> Option<Value> {
    Some(json!({ "type": "error", "code": code, "message": message }))
}

/// `Math.max(1, num(clickCount))` as the engine's count (a fraction is
/// cut, where Playwright would have sent it to Chromium as is).
fn click_count(value: Option<&Value>) -> u32 {
    num_arg(value).max(1.0).min(f64::from(u32::MAX)) as u32
}

impl Inner {
    /// `input(target, message)`: the caller checked the control lease
    /// (except for `log_image`); a frame to answer with, if any.
    pub(super) async fn input(
        self: Arc<Self>,
        target: BrowserTarget,
        message: Value,
    ) -> ApiResult<Option<Value>> {
        if message.get("type").and_then(Value::as_str) == Some("log_image") {
            let index = int_arg(arg(&message, "index"), -1, -1, MAX_SAFE_INTEGER);
            return Ok(Some(self.log_image(&target.session_id, index)));
        }
        let _lease = self.begin_operation(&target.session_id)?;
        self.handle_input(&target, &message).await
    }

    async fn handle_input(
        self: &Arc<Self>,
        target: &BrowserTarget,
        message: &Value,
    ) -> ApiResult<Option<Value>> {
        let kind = message.get("type");
        let kind_str = kind.and_then(Value::as_str);
        let creates = matches!(kind_str, Some("takeover" | "navigate"));
        let tab = self.tab(target, creates).await.map_err(OpError::into_api)?;
        if self.session_closing(&target.session_id) {
            return Err(closing_error());
        }
        let Some(tab) = tab else {
            return Ok(error_frame(
                "not_found",
                "No browser is open for this session",
            ));
        };
        tab.touch();
        match kind_str {
            Some("takeover") => {
                if tab.lock().mode != Mode::User {
                    self.set_mode(&tab, Mode::User, None);
                    self.log(&tab, "user", "User took control", None);
                }
                return Ok(None);
            }
            Some("release") => {
                if tab.lock().mode == Mode::User {
                    self.set_mode(&tab, Mode::Agent, None);
                    let jpeg = self.thumbnail(tab.active()).await;
                    self.log(&tab, "user", "User returned control", jpeg);
                }
                return Ok(None);
            }
            Some("record") => {
                let action = message.get("action").and_then(Value::as_str);
                // A tab that records (or starts to) ignores a start.
                if action == Some("start") {
                    if let Some(reservation) = self.reserve_recording(&tab) {
                        self.start_recording(&tab, reservation, "recording").await?;
                        self.log(&tab, "user", "Started recording", None);
                    }
                } else if action == Some("stop")
                    && let Some(stopping) = self.stop_recording(&tab)
                {
                    let result = stopping.await?;
                    self.log(&tab, "user", &saved(&result), None);
                }
                return Ok(None);
            }
            _ => {}
        }
        if tab.lock().mode != Mode::User {
            return Ok(error_frame(
                "agent_in_control",
                "Take over the browser first",
            ));
        }
        let page = match tab.active() {
            Some(page) => page,
            None => self.new_page(&tab).await.map_err(OpError::into_api)?,
        };
        let engine = |error: crate::browser::engine::Error| OpError::from(error).into_api();
        match kind_str {
            Some("navigate") => {
                let url = check_url(message.get("url"))?;
                self.log(&tab, "user", &format!("Navigate to {url}"), None);
                self.goto(&page, &url).await.map_err(OpError::into_api)?;
            }
            Some("back") => {
                let _ = page.go_back(LoadState::Load, Duration::from_secs(15)).await;
            }
            Some("forward") => {
                let _ = page.go_forward(Duration::from_secs(15)).await;
            }
            Some("reload") => {
                let _ = page.reload(Duration::from_secs(30)).await;
            }
            Some("tab") => {
                let index = num_arg(message.get("index"));
                let chosen = (index >= 0.0 && index.fract() == 0.0)
                    .then(|| tab.lock().pages.get(index as usize).cloned())
                    .flatten();
                if let Some(chosen) = chosen {
                    tab.lock().active = Some(chosen);
                    self.sync_screencast(&tab);
                    self.emit_state(&tab);
                }
            }
            Some("mouse") => {
                let x = num_arg(message.get("x"));
                let y = num_arg(message.get("y"));
                let button = MouseButton::parse(message.get("button").and_then(Value::as_str));
                let count = click_count(message.get("clickCount"));
                match message.get("action").and_then(Value::as_str) {
                    Some("move") => page.mouse_move(x, y).await.map_err(engine)?,
                    Some("down") => {
                        page.mouse_move(x, y).await.map_err(engine)?;
                        page.mouse_down(button, count).await.map_err(engine)?;
                    }
                    Some("up") => page.mouse_up(button, count).await.map_err(engine)?,
                    _ => {}
                }
            }
            Some("wheel") => {
                page.mouse_move(num_arg(message.get("x")), num_arg(message.get("y")))
                    .await
                    .map_err(engine)?;
                page.mouse_wheel(num_arg(message.get("dx")), num_arg(message.get("dy")))
                    .await
                    .map_err(engine)?;
            }
            Some("key") => {
                let key = message
                    .get("key")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let key = crate::util::head16(key, 60);
                if !key.is_empty() {
                    let _ = page.press(key).await;
                }
            }
            Some("text") => {
                let text = message
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let text = crate::util::head16(text, 10_000);
                if !text.is_empty() {
                    page.insert_text(text).await.map_err(engine)?;
                }
            }
            _ => {
                return Ok(error_frame(
                    "invalid_input",
                    &format!("Unknown message {}", js_string(kind)),
                ));
            }
        }
        Ok(None)
    }
}
