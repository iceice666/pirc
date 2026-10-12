//! `page.ariaSnapshot({mode: 'ai'})`: Playwright's
//! `ariaSnapshotJSONForFrame` (the injected script's JSON per frame, child
//! frames snapshotted through their `<iframe>` refs and merged in, rendered
//! once as YAML by the injected script's renderer) with Playwright's
//! retries.
//!
//! Owner: locator.

use std::time::Duration;

use super::Result;
use super::page::Page;

/// The page's AI-mode snapshot, refs `e<n>` in the main frame and
/// `f<seq>e<n>` in child frames.
pub async fn aria_snapshot(_page: &Page, _timeout: Duration) -> Result<String> {
    todo!("locator")
}
