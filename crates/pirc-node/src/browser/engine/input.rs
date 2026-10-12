//! Keyboard and mouse: Playwright's `Keyboard`/`Mouse` (`input.ts`, its US
//! layout from `usKeyboardLayout.ts`, Chromium's `RawKeyboard`/`RawMouse`
//! in `crInput.ts`, with the macOS editing commands), over the page's
//! session. Coordinates are the main frame's viewport CSS pixels.
//!
//! Owner: netio.

use std::time::Duration;

use super::cdp::Session;
use super::{MouseButton, Result};

/// The page's keyboard (pressed keys and modifiers are tracked).
pub struct Keyboard {
    _todo: (),
}

impl Keyboard {
    pub fn new(_session: Session) -> Self {
        todo!("netio")
    }

    /// `keyboard.press(key, {delay})`: `Shift+Tab`, `Control+a`, `Enter`, a
    /// character... Unknown keys fail as Playwright's
    /// (`Unknown key: "<key>"`).
    pub async fn press(&self, _key: &str, _delay: Duration) -> Result<()> {
        todo!("netio")
    }

    pub async fn down(&self, _key: &str) -> Result<()> {
        todo!("netio")
    }

    pub async fn up(&self, _key: &str) -> Result<()> {
        todo!("netio")
    }

    /// `keyboard.type(text, {delay})`: a key press per character the layout
    /// has, `insertText` for the others.
    pub async fn type_text(&self, _text: &str, _delay: Duration) -> Result<()> {
        todo!("netio")
    }

    /// `keyboard.insertText(text)`.
    pub async fn insert_text(&self, _text: &str) -> Result<()> {
        todo!("netio")
    }

    /// The CDP modifiers bitmask of the keys held now (for mouse events).
    pub fn modifiers(&self) -> u32 {
        todo!("netio")
    }
}

/// The page's mouse.
pub struct Mouse {
    _todo: (),
}

impl Mouse {
    pub fn new(_session: Session) -> Self {
        todo!("netio")
    }

    /// `mouse.move(x, y)`; `modifiers` from the page's keyboard.
    pub async fn move_to(&self, _x: f64, _y: f64, _modifiers: u32) -> Result<()> {
        todo!("netio")
    }

    /// `mouse.down({button, clickCount})`.
    pub async fn down(
        &self,
        _button: MouseButton,
        _click_count: u32,
        _modifiers: u32,
    ) -> Result<()> {
        todo!("netio")
    }

    /// `mouse.up({button, clickCount})`.
    pub async fn up(&self, _button: MouseButton, _click_count: u32, _modifiers: u32) -> Result<()> {
        todo!("netio")
    }

    /// `mouse.click(x, y, {button, clickCount})`: move, then a down/up per
    /// click.
    pub async fn click(
        &self,
        _x: f64,
        _y: f64,
        _button: MouseButton,
        _click_count: u32,
        _modifiers: u32,
    ) -> Result<()> {
        todo!("netio")
    }

    /// `mouse.wheel(dx, dy)` at the current position.
    pub async fn wheel(&self, _dx: f64, _dy: f64, _modifiers: u32) -> Result<()> {
        todo!("netio")
    }
}
