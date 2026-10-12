//! Keyboard and mouse: Playwright's `Keyboard`/`Mouse` (`input.ts`, its US
//! layout from `usKeyboardLayout.ts` in [`super::keyboard_layout`],
//! Chromium's `RawKeyboard`/`RawMouse` in `crInput.ts`, with the macOS
//! editing commands, and the drag interception of `crDragDrop.ts`), over
//! the page's session. Coordinates are the main frame's viewport CSS
//! pixels.
//!
//! The methods of [`Keyboard`] and [`Mouse`] are Playwright's page-level
//! API calls (`page.keyboard.press`, `page.mouse.move`, ...): each first
//! announces itself as `onBeforeInputAction` does, which shows the action
//! on the page for the screencast when `showActions` is on (see
//! [`super::screencast::announce`]). Element actions announce themselves
//! with the element's box and then use [`Keyboard::raw`] / [`Mouse::raw`],
//! which do not (Playwright's `keyboard.press` vs `apiPress`).
//!
//! The announcement and the drag interception need the page: the page
//! links its devices with [`attach`] once it exists. Without that link
//! (the devices alone on a session, as in tests) nothing is announced and
//! a move with the left button down is a plain `mouseMoved`.
//!
//! Deviation: when a drag was expected but Chromium reported no
//! `Input.dragIntercepted`, Playwright waits for it until the call's
//! timeout (forever for a viewer's move); this waits a second and treats
//! the move as no drag.
//!
//! Owner: netio.

use std::collections::HashSet;
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::Duration;

use futures_util::future::join_all;
use serde_json::{Value, json};

use super::cdp::Session;
use super::keyboard_layout::{KEYPAD_LOCATION, KeyDescription, mac_commands, us_keyboard_layout};
use super::page::Page;
use super::{Error, MouseButton, Result};

/// Whether Chromium gets the macOS editing commands and `ControlOrMeta` is
/// `Meta` (Playwright: the browser's user agent says `Macintosh`, and
/// `process.platform === 'darwin'`).
const MAC: bool = cfg!(target_os = "macos");

/// Link the page's keyboard and mouse to it (announcements, drags).
pub fn attach(page: &Arc<Page>) {
    let _ = page.keyboard().page.set(Arc::downgrade(page));
    let _ = page.mouse().page.set(Arc::downgrade(page));
}

/// `kModifiers`, with their CDP mask bits (`toModifiersMask`).
const MODIFIERS: [(&str, u32); 4] = [("Alt", 1), ("Control", 2), ("Meta", 4), ("Shift", 8)];

fn modifier_bit(key: &str) -> Option<u32> {
    MODIFIERS
        .iter()
        .find(|(name, _)| *name == key)
        .map(|(_, bit)| *bit)
}

/// `resolveSmartModifierString`.
fn resolve_smart_modifier(key: &str) -> &str {
    if key == "ControlOrMeta" {
        if MAC { "Meta" } else { "Control" }
    } else {
        key
    }
}

/// An API call's error as Playwright's client words it: the method's name
/// first (`press: Unknown key: "Foo"`, as `page.keyboard.press` throws in
/// the TS node: Bun's stack gives the client the bare method name).
fn api<T>(name: &str, result: Result<T>) -> Result<T> {
    result.map_err(|error| Error::new(format!("{name}: {}", error.message)))
}

/// `formatProtocolParam`'s rendering of a string parameter in a title.
fn title_param(value: &str) -> String {
    value.replace('\n', "\\n")
}

#[derive(Default)]
struct KeyboardState {
    /// The CDP mask of the held modifiers (`_pressedModifiers`).
    modifiers: u32,
    /// `_pressedKeys` (codes).
    pressed: HashSet<&'static str>,
}

/// The page's keyboard (pressed keys and modifiers are tracked).
pub struct Keyboard {
    session: Session,
    state: Mutex<KeyboardState>,
    page: OnceLock<Weak<Page>>,
}

impl Keyboard {
    pub fn new(session: Session) -> Self {
        Self {
            session,
            state: Mutex::default(),
            page: OnceLock::new(),
        }
    }

    fn page(&self) -> Option<Arc<Page>> {
        self.page.get().and_then(Weak::upgrade)
    }

    async fn announce(&self, title: String) -> Result<()> {
        match self.page() {
            Some(page) => super::screencast::announce(&page, &title, None, None).await,
            None => Ok(()),
        }
    }

    /// The same keyboard without announcements (for element actions).
    pub fn raw(&self) -> RawKeyboard<'_> {
        RawKeyboard(self)
    }

    /// `keyboard.press(key, {delay})`: `Shift+Tab`, `Control+a`, `Enter`, a
    /// character... Unknown keys fail as Playwright's
    /// (`press: Unknown key: "<key>"`; the API methods' errors start with
    /// their name as Playwright's client words them, [`Keyboard::raw`]'s
    /// are bare: `Unknown key: "<key>"`).
    pub async fn press(&self, key: &str, delay: Duration) -> Result<()> {
        api(
            "press",
            async {
                self.announce(format!("Press \"{}\"", title_param(key)))
                    .await?;
                self.raw().press(key, delay).await
            }
            .await,
        )
    }

    pub async fn down(&self, key: &str) -> Result<()> {
        api(
            "down",
            async {
                self.announce(format!("Key down \"{}\"", title_param(key)))
                    .await?;
                self.raw().down(key).await
            }
            .await,
        )
    }

    pub async fn up(&self, key: &str) -> Result<()> {
        api(
            "up",
            async {
                self.announce(format!("Key up \"{}\"", title_param(key)))
                    .await?;
                self.raw().up(key).await
            }
            .await,
        )
    }

    /// `keyboard.type(text, {delay})`: a key press per character the layout
    /// has, `insertText` for the others.
    pub async fn type_text(&self, text: &str, delay: Duration) -> Result<()> {
        api(
            "type",
            async {
                self.announce(format!("Type \"{}\"", title_param(text)))
                    .await?;
                self.raw().type_text(text, delay).await
            }
            .await,
        )
    }

    /// `keyboard.insertText(text)`.
    pub async fn insert_text(&self, text: &str) -> Result<()> {
        api(
            "insertText",
            async {
                self.announce(format!("Insert \"{}\"", title_param(text)))
                    .await?;
                self.raw().insert_text(text).await
            }
            .await,
        )
    }

    /// The CDP modifiers bitmask of the keys held now (for mouse events).
    pub fn modifiers(&self) -> u32 {
        self.state.lock().unwrap().modifiers
    }

    /// `_keyDescriptionForString`.
    fn describe(&self, key: &str) -> Result<KeyDescription> {
        let key = resolve_smart_modifier(key);
        let Some(description) = us_keyboard_layout().get(key) else {
            return Err(Error::new(format!("Unknown key: \"{key}\"")));
        };
        let modifiers = self.modifiers();
        let shift = modifiers & 8 != 0;
        let mut description = match (&description.shifted, shift) {
            (Some(shifted), true) => (**shifted).clone(),
            _ => description.clone(),
        };
        let held = modifiers.count_ones();
        if held > 1 || (!shift && held == 1) {
            description.text = "";
        }
        Ok(description)
    }
}

/// `toModifiersMask` as the set `_commandsForCode` reads.
fn modifier_names(mask: u32) -> Vec<&'static str> {
    MODIFIERS
        .iter()
        .filter(|(_, bit)| mask & bit != 0)
        .map(|(name, _)| *name)
        .collect()
}

/// [`Keyboard`] without announcements.
pub struct RawKeyboard<'a>(&'a Keyboard);

impl RawKeyboard<'_> {
    /// `Keyboard.press`: split on `+` (a `+` right after another or at the
    /// start is the key itself), modifiers down left to right, the key, the
    /// delay, then all up in reverse.
    pub async fn press(&self, key: &str, delay: Duration) -> Result<()> {
        let tokens = split_combo(key);
        let (key, modifiers) = tokens.split_last().expect("at least one token");
        for modifier in modifiers {
            self.down(modifier).await?;
        }
        self.down(key).await?;
        if !delay.is_zero() {
            tokio::time::sleep(delay).await;
        }
        self.up(key).await?;
        for modifier in modifiers.iter().rev() {
            self.up(modifier).await?;
        }
        Ok(())
    }

    /// `Keyboard.down` and `RawKeyboardImpl.keydown`.
    pub async fn down(&self, key: &str) -> Result<()> {
        let keyboard = self.0;
        let description = keyboard.describe(key)?;
        let (auto_repeat, modifiers) = {
            let mut state = keyboard.state.lock().unwrap();
            let auto_repeat = !state.pressed.insert(description.code);
            if let Some(bit) = modifier_bit(description.key) {
                state.modifiers |= bit;
            }
            (auto_repeat, state.modifiers)
        };
        if description.code == "Escape"
            && let Some(page) = keyboard.page()
            && page.mouse().cancel_drag().await?
        {
            return Ok(());
        }
        let commands = if MAC {
            mac_commands(description.code, &modifier_names(modifiers))
        } else {
            Vec::new()
        };
        let text = description.text;
        keyboard
            .session
            .call(
                "Input.dispatchKeyEvent",
                json!({
                    "type": if text.is_empty() { "rawKeyDown" } else { "keyDown" },
                    "modifiers": modifiers,
                    "windowsVirtualKeyCode": description.key_code_without_location,
                    "code": description.code,
                    "commands": commands,
                    "key": description.key,
                    "text": text,
                    "unmodifiedText": text,
                    "autoRepeat": auto_repeat,
                    "location": description.location,
                    "isKeypad": description.location == KEYPAD_LOCATION,
                }),
            )
            .await?;
        Ok(())
    }

    /// `Keyboard.up` and `RawKeyboardImpl.keyup`.
    pub async fn up(&self, key: &str) -> Result<()> {
        let keyboard = self.0;
        let description = keyboard.describe(key)?;
        let modifiers = {
            let mut state = keyboard.state.lock().unwrap();
            if let Some(bit) = modifier_bit(description.key) {
                state.modifiers &= !bit;
            }
            state.pressed.remove(description.code);
            state.modifiers
        };
        keyboard
            .session
            .call(
                "Input.dispatchKeyEvent",
                json!({
                    "type": "keyUp",
                    "modifiers": modifiers,
                    "key": description.key,
                    "windowsVirtualKeyCode": description.key_code_without_location,
                    "code": description.code,
                    "location": description.location,
                }),
            )
            .await?;
        Ok(())
    }

    /// `Keyboard.type`: per code point, a press when the layout has it,
    /// else (after the delay) `insertText`.
    pub async fn type_text(&self, text: &str, delay: Duration) -> Result<()> {
        let layout = us_keyboard_layout();
        let mut buffer = [0u8; 4];
        for char in text.chars() {
            let char = char.encode_utf8(&mut buffer);
            if layout.contains_key(&*char) {
                self.press(char, delay).await?;
            } else {
                if !delay.is_zero() {
                    tokio::time::sleep(delay).await;
                }
                self.insert_text(char).await?;
            }
        }
        Ok(())
    }

    /// `Input.insertText`.
    pub async fn insert_text(&self, text: &str) -> Result<()> {
        self.0
            .session
            .call("Input.insertText", json!({ "text": text }))
            .await?;
        Ok(())
    }
}

/// `press`'s `split`.
fn split_combo(key: &str) -> Vec<String> {
    let mut keys = Vec::new();
    let mut building = String::new();
    for char in key.chars() {
        if char == '+' && !building.is_empty() {
            keys.push(std::mem::take(&mut building));
        } else {
            building.push(char);
        }
    }
    keys.push(building);
    keys
}

fn button_name(button: MouseButton) -> &'static str {
    match button {
        MouseButton::Left => "left",
        MouseButton::Right => "right",
        MouseButton::Middle => "middle",
    }
}

/// `toButtonsMask`.
fn button_bit(button: MouseButton) -> u32 {
    match button {
        MouseButton::Left => 1,
        MouseButton::Right => 2,
        MouseButton::Middle => 4,
    }
}

/// `force: buttons.size > 0 ? 0.5 : 0`.
fn force(buttons: u32) -> Value {
    if buttons == 0 { json!(0) } else { json!(0.5) }
}

struct MouseState {
    x: f64,
    y: f64,
    /// `_lastButton` (`"none"` when no button is down).
    last_button: &'static str,
    /// `_buttons` as their mask.
    buttons: u32,
}

/// `DragManager`'s state.
#[derive(Default)]
struct DragState {
    /// The intercepted drag's data while dragging.
    data: Option<Value>,
    last: (f64, f64),
}

/// The page's mouse.
pub struct Mouse {
    session: Session,
    state: Mutex<MouseState>,
    drag: Mutex<DragState>,
    page: OnceLock<Weak<Page>>,
}

/// `setupDragListeners` of `crDragDrop.ts`, run in every frame's utility
/// world before a move with the left button down.
const SETUP_DRAG_LISTENERS: &str = r#"function setupDragListeners() {
          let didStartDrag = Promise.resolve(false);
          let dragEvent = null;
          const dragListener = (event) => dragEvent = event;
          const mouseListener = () => {
            didStartDrag = new Promise((callback) => {
              window.addEventListener("dragstart", dragListener, { once: true, capture: true });
              setTimeout(() => callback(dragEvent ? !dragEvent.defaultPrevented : false), 0);
            });
          };
          window.addEventListener("mousemove", mouseListener, { once: true, capture: true });
          window.__cleanupDrag = async () => {
            const val = await didStartDrag;
            window.removeEventListener("mousemove", mouseListener, { capture: true });
            window.removeEventListener("dragstart", dragListener, { capture: true });
            delete window.__cleanupDrag;
            return val;
          };
        }"#;

impl Mouse {
    pub fn new(session: Session) -> Self {
        Self {
            session,
            state: Mutex::new(MouseState {
                x: 0.0,
                y: 0.0,
                last_button: "none",
                buttons: 0,
            }),
            drag: Mutex::default(),
            page: OnceLock::new(),
        }
    }

    fn page(&self) -> Option<Arc<Page>> {
        self.page.get().and_then(Weak::upgrade)
    }

    async fn announce(&self, title: &str, point: Option<(f64, f64)>) -> Result<()> {
        match self.page() {
            Some(page) => super::screencast::announce(&page, title, point, None).await,
            None => Ok(()),
        }
    }

    fn current_point(&self) -> (f64, f64) {
        let state = self.state.lock().unwrap();
        (state.x, state.y)
    }

    /// The same mouse without announcements (for element actions).
    pub fn raw(&self) -> RawMouse<'_> {
        RawMouse(self)
    }

    /// `mouse.move(x, y)`; `modifiers` from the page's keyboard.
    pub async fn move_to(&self, x: f64, y: f64, modifiers: u32) -> Result<()> {
        api(
            "move",
            async {
                self.announce("Mouse move", Some((x, y))).await?;
                self.raw().move_to(x, y, 1, false, modifiers).await
            }
            .await,
        )
    }

    /// `mouse.down({button, clickCount})`.
    pub async fn down(&self, button: MouseButton, click_count: u32, modifiers: u32) -> Result<()> {
        api(
            "down",
            async {
                self.announce("Mouse down", Some(self.current_point()))
                    .await?;
                self.raw().down(button, click_count, modifiers).await
            }
            .await,
        )
    }

    /// `mouse.up({button, clickCount})`.
    pub async fn up(&self, button: MouseButton, click_count: u32, modifiers: u32) -> Result<()> {
        api(
            "up",
            async {
                self.announce("Mouse up", Some(self.current_point()))
                    .await?;
                self.raw().up(button, click_count, modifiers).await
            }
            .await,
        )
    }

    /// `mouse.click(x, y, {button, clickCount})`: move, then a down/up per
    /// click.
    pub async fn click(
        &self,
        x: f64,
        y: f64,
        button: MouseButton,
        click_count: u32,
        modifiers: u32,
    ) -> Result<()> {
        api(
            "click",
            async {
                self.announce("Click", Some((x, y))).await?;
                self.raw().click(x, y, button, click_count, modifiers).await
            }
            .await,
        )
    }

    /// `mouse.wheel(dx, dy)` at the current position.
    pub async fn wheel(&self, dx: f64, dy: f64, modifiers: u32) -> Result<()> {
        api(
            "wheel",
            async {
                self.announce("Mouse wheel", None).await?;
                self.raw().wheel(dx, dy, modifiers).await
            }
            .await,
        )
    }

    /// Whether a drag is in progress (`DragManager.isDragging`).
    pub fn is_dragging(&self) -> bool {
        self.drag.lock().unwrap().data.is_some()
    }

    /// `DragManager.cancelDrag`: whether there was a drag to cancel.
    pub async fn cancel_drag(&self) -> Result<bool> {
        let (data, (x, y)) = {
            let drag = self.drag.lock().unwrap();
            (drag.data.clone(), drag.last)
        };
        if data.is_none() {
            return Ok(false);
        }
        self.session
            .call(
                "Input.dispatchDragEvent",
                json!({ "type": "dragCancel", "x": x, "y": y,
                    "data": { "items": [], "dragOperationsMask": 65535 } }),
            )
            .await?;
        self.drag.lock().unwrap().data = None;
        Ok(true)
    }

    /// `DragManager.interceptDragCausedByMove` around a move.
    async fn intercept_drag(
        &self,
        x: f64,
        y: f64,
        button: &str,
        modifiers: u32,
        params: Value,
    ) -> Result<()> {
        let dragging = {
            let mut drag = self.drag.lock().unwrap();
            drag.last = (x, y);
            drag.data.clone()
        };
        if let Some(data) = dragging {
            self.session
                .call(
                    "Input.dispatchDragEvent",
                    json!({ "type": "dragOver", "x": x, "y": y, "data": data, "modifiers": modifiers }),
                )
                .await?;
            return Ok(());
        }
        let page = self.page();
        let Some(page) = page.filter(|_| button == "left") else {
            self.session
                .call("Input.dispatchMouseEvent", params)
                .await?;
            return Ok(());
        };
        let frames = page.frames();
        join_all(frames.iter().map(|frame| async move {
            if let Ok(injected) = frame.injected().await {
                let _ = injected
                    .call(
                        &format!("function() {{ ({SETUP_DRAG_LISTENERS})(); }}"),
                        Vec::new(),
                    )
                    .await;
            }
        }))
        .await;
        let mut events = self.session.listen();
        self.session
            .call("Input.setInterceptDrags", json!({ "enabled": true }))
            .await?;
        let moved = self.session.call("Input.dispatchMouseEvent", params).await;
        let expecting = match moved {
            Ok(_) => join_all(page.frames().iter().map(|frame| async move {
                let Ok(injected) = frame.injected().await else {
                    return false;
                };
                injected
                    .call(
                        "function() { return window.__cleanupDrag?.(); }",
                        Vec::new(),
                    )
                    .await
                    .is_ok_and(|value| value.as_bool() == Some(true))
            }))
            .await
            .into_iter()
            .any(|started| started),
            Err(_) => false,
        };
        let _ = self
            .session
            .call("Input.setInterceptDrags", json!({ "enabled": false }))
            .await;
        moved?;
        let data = if expecting {
            tokio::time::timeout(Duration::from_secs(1), async {
                while let Some(event) = events.recv().await {
                    if event.method == "Input.dragIntercepted" {
                        return Some(event.params["data"].clone());
                    }
                }
                None
            })
            .await
            .ok()
            .flatten()
        } else {
            None
        };
        self.drag.lock().unwrap().data = data.clone();
        if let Some(data) = data {
            self.session
                .call(
                    "Input.dispatchDragEvent",
                    json!({ "type": "dragEnter", "x": x, "y": y, "data": data, "modifiers": modifiers }),
                )
                .await?;
        }
        Ok(())
    }
}

/// [`Mouse`] without announcements.
pub struct RawMouse<'a>(&'a Mouse);

impl RawMouse<'_> {
    /// `Mouse.move` with `steps`; `for_click` skips the drag interception.
    pub async fn move_to(
        &self,
        x: f64,
        y: f64,
        steps: u32,
        for_click: bool,
        modifiers: u32,
    ) -> Result<()> {
        let mouse = self.0;
        let steps = steps.max(1);
        let (from_x, from_y) = {
            let mut state = mouse.state.lock().unwrap();
            let from = (state.x, state.y);
            state.x = x;
            state.y = y;
            from
        };
        for i in 1..=steps {
            let fraction = f64::from(i) / f64::from(steps);
            let middle_x = from_x + (x - from_x) * fraction;
            let middle_y = from_y + (y - from_y) * fraction;
            let (button, buttons) = {
                let state = mouse.state.lock().unwrap();
                (state.last_button, state.buttons)
            };
            let params = json!({
                "type": "mouseMoved",
                "button": button,
                "buttons": buttons,
                "x": middle_x,
                "y": middle_y,
                "modifiers": modifiers,
                "force": force(buttons),
            });
            if for_click {
                mouse
                    .session
                    .call("Input.dispatchMouseEvent", params)
                    .await?;
            } else {
                mouse
                    .intercept_drag(middle_x, middle_y, button, modifiers, params)
                    .await?;
            }
        }
        Ok(())
    }

    /// `Mouse.down`'s state change and its `mousePressed` (none while
    /// dragging).
    fn down_params(&self, button: MouseButton, click_count: u32, modifiers: u32) -> Option<Value> {
        let mouse = self.0;
        let mut state = mouse.state.lock().unwrap();
        state.last_button = button_name(button);
        state.buttons |= button_bit(button);
        if mouse.is_dragging() {
            return None;
        }
        Some(json!({
            "type": "mousePressed",
            "button": state.last_button,
            "buttons": state.buttons,
            "x": state.x,
            "y": state.y,
            "modifiers": modifiers,
            "clickCount": click_count,
            "force": force(state.buttons),
        }))
    }

    /// `Mouse.up`'s state change and its `mouseReleased`, or the drop.
    fn up_params(
        &self,
        button: MouseButton,
        click_count: u32,
        modifiers: u32,
    ) -> (&'static str, Value) {
        let mouse = self.0;
        let mut state = mouse.state.lock().unwrap();
        state.last_button = "none";
        state.buttons &= !button_bit(button);
        let mut drag = mouse.drag.lock().unwrap();
        if let Some(data) = drag.data.take() {
            return (
                "Input.dispatchDragEvent",
                json!({ "type": "drop", "x": state.x, "y": state.y, "data": data, "modifiers": modifiers }),
            );
        }
        (
            "Input.dispatchMouseEvent",
            json!({
                "type": "mouseReleased",
                "button": button_name(button),
                "buttons": state.buttons,
                "x": state.x,
                "y": state.y,
                "modifiers": modifiers,
                "clickCount": click_count,
            }),
        )
    }

    pub async fn down(&self, button: MouseButton, click_count: u32, modifiers: u32) -> Result<()> {
        if let Some(params) = self.down_params(button, click_count, modifiers) {
            self.0
                .session
                .call("Input.dispatchMouseEvent", params)
                .await?;
        }
        Ok(())
    }

    pub async fn up(&self, button: MouseButton, click_count: u32, modifiers: u32) -> Result<()> {
        let (method, params) = self.up_params(button, click_count, modifiers);
        self.0.session.call(method, params).await?;
        Ok(())
    }

    /// `Mouse.click` without a delay: the move and every down/up are sent
    /// in order and awaited together.
    pub async fn click(
        &self,
        x: f64,
        y: f64,
        button: MouseButton,
        click_count: u32,
        modifiers: u32,
    ) -> Result<()> {
        let mouse = self.0;
        let mut calls = Vec::new();
        {
            let mut state = mouse.state.lock().unwrap();
            state.x = x;
            state.y = y;
            calls.push((
                "Input.dispatchMouseEvent",
                json!({
                    "type": "mouseMoved",
                    "button": state.last_button,
                    "buttons": state.buttons,
                    "x": x,
                    "y": y,
                    "modifiers": modifiers,
                    "force": force(state.buttons),
                }),
            ));
        }
        for count in 1..=click_count {
            if let Some(params) = self.down_params(button, count, modifiers) {
                calls.push(("Input.dispatchMouseEvent", params));
            }
            calls.push(self.up_params(button, count, modifiers));
        }
        for result in join_all(
            calls
                .into_iter()
                .map(|(method, params)| mouse.session.call(method, params)),
        )
        .await
        {
            result?;
        }
        Ok(())
    }

    /// `RawMouseImpl.wheel` at the current position.
    pub async fn wheel(&self, dx: f64, dy: f64, modifiers: u32) -> Result<()> {
        let (x, y) = self.0.current_point();
        self.0
            .session
            .call(
                "Input.dispatchMouseEvent",
                json!({ "type": "mouseWheel", "x": x, "y": y, "modifiers": modifiers,
                    "deltaX": dx, "deltaY": dy }),
            )
            .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_combos_as_playwright() {
        assert_eq!(split_combo("Shift+Tab"), ["Shift", "Tab"]);
        assert_eq!(split_combo("+"), ["+"]);
        assert_eq!(split_combo("Shift++"), ["Shift", "+"]);
        assert_eq!(split_combo("Control+Shift+a"), ["Control", "Shift", "a"]);
        assert_eq!(split_combo("a+"), ["a", ""]);
        assert_eq!(split_combo(""), [""]);
    }

    #[test]
    fn renders_titles_as_playwright() {
        assert_eq!(title_param("a\nb"), "a\\nb");
        assert_eq!(
            resolve_smart_modifier("ControlOrMeta"),
            if MAC { "Meta" } else { "Control" }
        );
        assert_eq!(modifier_names(8 | 2), ["Control", "Shift"]);
    }
}
