//! The locators `node/browser.ts` uses: `page.locator('aria-ref=<ref>')`
//! (routed to its frame by the `f<seq>` prefix) and
//! `page.getByText(text).first()`, with Playwright's actions on them
//! (`dom.ts`: actionability checks, scrolling into view, hit-target
//! checks, retries until the timeout) and their error texts.
//!
//! Owner: locator.

use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;

use super::page::Page;
use super::{MouseButton, Result};

/// Visible or hidden (`locator.waitFor({state})`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WaitState {
    Visible,
    Hidden,
}

pub struct Locator {
    _todo: (),
}

impl Locator {
    /// `page.locator('aria-ref=<reference>')`.
    pub fn aria_ref(_page: &Arc<Page>, _reference: &str) -> Self {
        todo!("locator")
    }

    /// `page.getByText(text).first()`.
    pub fn text_first(_page: &Arc<Page>, _text: &str) -> Self {
        todo!("locator")
    }

    /// `locator.click({timeout, button, clickCount})`.
    pub async fn click(
        &self,
        _button: MouseButton,
        _click_count: u32,
        _timeout: Duration,
    ) -> Result<()> {
        todo!("locator")
    }

    /// `locator.hover({timeout})`.
    pub async fn hover(&self, _timeout: Duration) -> Result<()> {
        todo!("locator")
    }

    /// `locator.fill(value, {timeout})`.
    pub async fn fill(&self, _value: &str, _timeout: Duration) -> Result<()> {
        todo!("locator")
    }

    /// `locator.pressSequentially(text, {delay, timeout})`.
    pub async fn press_sequentially(
        &self,
        _text: &str,
        _delay: Duration,
        _timeout: Duration,
    ) -> Result<()> {
        todo!("locator")
    }

    /// `locator.press(key, {timeout})`.
    pub async fn press(&self, _key: &str, _timeout: Duration) -> Result<()> {
        todo!("locator")
    }

    /// `locator.selectOption(values, {timeout})`: the selected values.
    pub async fn select_option(
        &self,
        _values: &[String],
        _timeout: Duration,
    ) -> Result<Vec<String>> {
        todo!("locator")
    }

    /// `locator.evaluate(fn, undefined, {timeout})`: `function` is called
    /// with the element, in its frame's main world.
    pub async fn evaluate(&self, _function: &str, _timeout: Duration) -> Result<Value> {
        todo!("locator")
    }

    /// `locator.waitFor({state, timeout})`; a zero timeout waits forever.
    pub async fn wait_for(&self, _state: WaitState, _timeout: Duration) -> Result<()> {
        todo!("locator")
    }
}
