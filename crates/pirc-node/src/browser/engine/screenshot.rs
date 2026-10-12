//! `page.screenshot` as `node/browser.ts` calls it: JPEG, `scale: 'css'`,
//! viewport or full page (Playwright's `screenshotter.ts` for Chromium).
//!
//! Owner: netio.

use std::time::Duration;

use super::Result;
use super::page::Page;

#[derive(Clone, Copy, Debug)]
pub struct ScreenshotOptions {
    /// JPEG quality (`browser.ts`: 70 for the agent, 45 for log
    /// thumbnails, 60 for a recording's first frame).
    pub quality: u8,
    pub full_page: bool,
    pub timeout: Duration,
}

/// The JPEG bytes.
pub async fn capture(_page: &Page, _options: ScreenshotOptions) -> Result<Vec<u8>> {
    todo!("netio")
}
