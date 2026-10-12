//! `page.ariaSnapshot({mode: 'ai'})`: Playwright's
//! `ariaSnapshotJSONForFrame` (the injected script's JSON per frame, child
//! frames snapshotted through their `<iframe>` refs and merged in, rendered
//! once as YAML by the injected script's renderer) with Playwright's
//! retries.
//!
//! Playwright 1.63.0 (`Frame.ariaSnapshot`, `ariaSnapshotJSONForFrame` in
//! `server/page.ts`):
//!
//! 1. In the frame, `injected.ariaSnapshotJSON(<first body,frameset>,
//!    {mode: 'ai'})` (refs `e<n>`, `f<seq>e<n>` in other frames than the
//!    first main frame), retried after `[0, 1000, 2000, 4000, 8000, 8000,
//!    …]` ms while the frame has no body or its document goes away.
//! 2. Each `<iframe>` ref the snapshot rendered (`iframeRefs` that are in
//!    `iframeDepths`) is snapshotted the same way, concurrently, through
//!    `aria-ref=<ref> >> internal:control=enter-frame >> body,frameset`
//!    (the `<iframe>` element, its content frame by `DOM.describeNode`, its
//!    body); a child that fails is left out.
//! 3. A child's nodes become its `iframe` node's children (when it has
//!    any), and the merged JSON is rendered as YAML once.
//!
//! Playwright renders on its server with `renderAriaSnapshotAsYaml`; the
//! injected script holds the same function (byte for byte but for minified
//! names), reachable through `InjectedScript.ariaSnapshot`, which renders
//! what its `this.ariaSnapshotJSON` returns: the merged JSON goes through
//! it in the main frame's utility world, so the YAML (quoting, escaping,
//! property order) is Playwright's own. Deviation: should that world go
//! away between the snapshot and the rendering, the rendering waits for
//! the next one (Playwright cannot fail there).
//!
//! Ported from playwright-core 1.63.0 `src/server/page.ts`,
//! `src/server/frames.ts` (Apache-2.0, see `crates/pirc-node/NOTICE`).
//!
//! Owner: locator.

use std::time::Duration;

use futures_util::future::{BoxFuture, join_all};
use serde_json::{Value, json};

use super::frame::{Arg, Frame, handle_of};
use super::locator::{Failure, content_frame, jump_to_aria_ref_frame, retry_wait};
use super::page::{Page, deadline, within};
use super::{Error, Result};

const API: &str = "ariaSnapshot";

/// `ariaSnapshotJSONForFrame`'s retry waits (ms).
const RETRY: [u64; 5] = [0, 1000, 2000, 4000, 8000];

/// `callOnSelector(selector, …, ({injected, elements}) =>
/// injected.ariaSnapshotJSON(elements[0], options))`: `null` without a
/// match.
const SNAPSHOT: &str = "function(selector, strict, options) {
  const parsed = this.parseSelector(selector);
  const elements = this.querySelectorAll(parsed, document);
  if (strict && elements.length > 1)
    throw this.strictModeViolationError(parsed, elements);
  if (!elements.length)
    return null;
  return this.ariaSnapshotJSON(elements[0], options);
}";

/// The `<iframe>` of an enter-frame chunk (`_resolveChainedSelector`).
const FRAME_ELEMENT: &str = "function(selector, strict) {
  const element = this.querySelector(this.parseSelector(selector), document, strict);
  if (element && element.nodeName !== 'IFRAME' && element.nodeName !== 'FRAME')
    throw this.createStacklessError(`Selector \"${selector}\" resolved to ${this.previewNode(element)}, <iframe> was expected`);
  return element;
}";

/// `renderAriaSnapshotAsYaml(json)` through `InjectedScript.ariaSnapshot`.
const RENDER: &str = "function(json) {
  return this.ariaSnapshot.call({ ariaSnapshotJSON: () => ({ json }) }, null, { mode: 'ai' });
}";

/// The page's AI-mode snapshot, refs `e<n>` in the main frame and
/// `f<seq>e<n>` in child frames.
pub async fn aria_snapshot(page: &Page, timeout: Duration) -> Result<String> {
    let main = page.main_frame();
    let work = async {
        let json = frame_json(page, main.clone(), None).await?;
        render(&main, json).await
    };
    let raced = async {
        tokio::select! {
            result = work => result,
            error = main.gone("") => Err(error),
        }
    };
    match within(deadline(timeout), raced).await {
        Some(result) => result.map_err(|error| Error::api(API, error.message)),
        None => Err(Error::timeout(API, timeout)),
    }
}

/// `ariaSnapshotJSONForFrame(frame, selector)`: `child` is the ref of the
/// `<iframe>` (in `frame`) whose frame to snapshot, `None` for `frame`
/// itself.
fn frame_json<'a>(
    page: &'a Page,
    frame: Frame,
    child: Option<String>,
) -> BoxFuture<'a, Result<Vec<Value>>> {
    Box::pin(async move {
        let mut attempt = 0;
        let (snapshot, resolved) = loop {
            let wait = RETRY[attempt.min(RETRY.len() - 1)];
            attempt += 1;
            if wait > 0 {
                retry_wait(&frame, Duration::from_millis(wait)).await?;
            }
            match snapshot_once(page, &frame, child.as_deref()).await {
                Ok(Some(found)) => break found,
                Ok(None) => {
                    if let Some(reference) = &child {
                        return Err(Error::new(format!(
                            "Selector \"{}\" does not match any element",
                            child_selector(reference)
                        )));
                    }
                }
                Err(failure) if failure.retriable => {}
                Err(failure) => return Err(failure.error),
            }
        };
        let depths = snapshot["iframeDepths"].as_object();
        let refs: Vec<String> = snapshot["iframeRefs"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_default()
            .iter()
            .filter_map(Value::as_str)
            .filter(|reference| depths.is_some_and(|depths| depths.contains_key(*reference)))
            .map(str::to_owned)
            .collect();
        let children = join_all(refs.iter().map(|reference| {
            let resolved = resolved.clone();
            async move {
                frame_json(page, resolved, Some(reference.clone()))
                    .await
                    .unwrap_or_default()
            }
        }))
        .await;
        let mut json = match snapshot.get("json") {
            Some(Value::Array(nodes)) => nodes.clone(),
            _ => Vec::new(),
        };
        for node in &mut json {
            merge_iframe_children(node, &refs, &children);
        }
        Ok(json)
    })
}

fn child_selector(reference: &str) -> String {
    format!("aria-ref={reference} >> internal:control=enter-frame >> body,frameset")
}

/// One try: the snapshot JSON and the frame it was taken in, `None` when
/// the selector matched nothing.
async fn snapshot_once(
    page: &Page,
    frame: &Frame,
    child: Option<&str>,
) -> std::result::Result<Option<(Value, Frame)>, Failure> {
    let target = match child {
        None => frame.clone(),
        Some(reference) => {
            let selector = format!("aria-ref={reference}");
            let owner = jump_to_aria_ref_frame(page, frame.clone(), &selector)?;
            let injected = owner
                .injected()
                .await
                .map_err(|error| Failure::of(frame, error))?;
            let element = injected
                .call_raw(
                    FRAME_ELEMENT,
                    vec![Arg::Value(json!(selector)), Arg::Value(json!(false))],
                    false,
                )
                .await
                .map_err(|error| Failure::of_eval(frame, error))?;
            let Some(element) = handle_of(&injected.session, &element) else {
                return Ok(None);
            };
            let content = content_frame(page, frame, &element).await;
            element.release().await;
            match content? {
                Some(content) => content,
                None => return Ok(None),
            }
        }
    };
    let injected = target
        .injected()
        .await
        .map_err(|error| Failure::of(frame, error))?;
    let result = injected
        .call_raw(
            SNAPSHOT,
            vec![
                Arg::Value(json!("body,frameset")),
                Arg::Value(json!(false)),
                Arg::Value(json!({ "mode": "ai" })),
            ],
            true,
        )
        .await
        .map_err(|error| Failure::of_eval(frame, error))?["value"]
        .clone();
    if result.is_null() {
        return Ok(None);
    }
    Ok(Some((result, target)))
}

/// `mergeIframeChildren`.
fn merge_iframe_children(node: &mut Value, refs: &[String], children: &[Vec<Value>]) {
    let Value::Object(object) = node else {
        return;
    };
    if object.get("role").and_then(Value::as_str) == Some("iframe")
        && let Some(reference) = object.get("ref").and_then(Value::as_str)
    {
        let child = refs
            .iter()
            .position(|candidate| candidate == reference)
            .and_then(|index| children.get(index));
        if let Some(child) = child.filter(|child| !child.is_empty()) {
            object.insert("children".to_owned(), Value::Array(child.clone()));
        }
        return;
    }
    if let Some(Value::Array(nodes)) = object.get_mut("children") {
        for node in nodes {
            merge_iframe_children(node, refs, children);
        }
    }
}

/// The merged JSON as YAML, by the injected script's renderer in the main
/// frame.
async fn render(main: &Frame, json: Vec<Value>) -> Result<String> {
    let json = Value::Array(json);
    loop {
        let rendered = async {
            let injected = main
                .injected()
                .await
                .map_err(|error| Failure::of(main, error))?;
            injected
                .call_raw(RENDER, vec![Arg::Value(json.clone())], true)
                .await
                .map_err(|error| Failure::of_eval(main, error))
        };
        match rendered.await {
            Ok(object) => return Ok(object["value"].as_str().unwrap_or_default().to_owned()),
            Err(failure) if failure.retriable => {
                retry_wait(main, Duration::from_millis(20)).await?;
            }
            Err(failure) => return Err(failure.error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merges_children_under_their_iframe() {
        let mut node = json!({ "role": "generic", "children": [
            "text",
            { "role": "iframe", "ref": "e2" },
            { "role": "iframe", "ref": "e3" },
            { "role": "list", "children": [{ "role": "iframe", "ref": "e4", "children": ["kept"] }] },
        ] });
        let refs = ["e2".to_owned(), "e3".to_owned(), "e4".to_owned()];
        let children = [
            vec![json!({ "role": "button" })],
            Vec::new(),
            vec![json!("x")],
        ];
        merge_iframe_children(&mut node, &refs, &children);
        assert_eq!(
            node,
            json!({ "role": "generic", "children": [
                "text",
                { "role": "iframe", "ref": "e2", "children": [{ "role": "button" }] },
                { "role": "iframe", "ref": "e3" },
                { "role": "list", "children": [{ "role": "iframe", "ref": "e4", "children": ["x"] }] },
            ] })
        );
    }
}
