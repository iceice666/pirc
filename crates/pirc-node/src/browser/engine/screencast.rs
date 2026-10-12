//! The page's screencast (`page.screencast.start({size, quality,
//! onFrame})` in `node/browser.ts`): `Page.startScreencast` JPEG frames at
//! most `size` (rounded down to even, as Playwright does), each
//! acknowledged once the sink returned. Playwright's action overlay
//! (`screencast.showActions({duration: 600})`) is part of it.
//!
//! Owner: netio.

use std::sync::Arc;

use super::Result;
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

/// Per-page screencast state, kept by the page.
#[derive(Default)]
pub struct ScreencastState {
    _todo: (),
}

pub async fn start(
    _page: &Page,
    _options: ScreencastOptions,
    _sink: Arc<dyn Fn(ScreencastFrame) + Send + Sync>,
) -> Result<()> {
    todo!("netio")
}

pub async fn stop(_page: &Page) -> Result<()> {
    todo!("netio")
}
