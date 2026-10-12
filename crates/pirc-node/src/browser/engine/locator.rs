//! The locators `node/browser.ts` uses: `page.locator('aria-ref=<ref>')`
//! (routed to its frame by the `f<seq>` prefix) and
//! `page.getByText(text).first()`, with Playwright's actions on them
//! (`dom.ts`: actionability checks, scrolling into view, hit-target
//! checks, retries until the timeout) and their error texts.
//!
//! Playwright 1.63.0, as ported here (the server half; the in-page half is
//! the injected script's, called as Playwright calls it):
//!
//! - Selector resolution (`FrameSelectors`): a selector whose first part is
//!   `aria-ref=f<seq>e<n>` runs in the page's frame with that sequence
//!   number (`Invalid frame in aria-ref selector "<selector>"` when there is
//!   none), any other in the main frame, through the frame's injected
//!   script (`parseSelector`, `querySelectorAll`, strict mode).
//! - `Frame._retryWithProgressIfNotConnected`: resolve, act, and start over
//!   (after Playwright's backoff `[0, 20, 50, 100, 100, 500]`, shortened
//!   for short timeouts) while the element is not found or got detached.
//! - `ElementHandle._retryAction` / `_retryPointerAction`: retry the action
//!   while the element is not visible, not in the viewport, not in the
//!   required state, or another element would get the pointer event,
//!   waiting `[0, 20, 100, 100, 500]` ms in the page between attempts and
//!   rotating the scroll alignment.
//! - Pointer actions: `checkElementStates`, `DOM.scrollIntoViewIfNeeded`,
//!   `DOM.getContentQuads` (offset by the frame's position for an
//!   out-of-process iframe) clipped to the viewport, the frames' hit-target
//!   checks, `setupHitTargetInterceptor`, the input, and the navigation
//!   barrier of a click (`waitForSignalsCreatedBy`).
//! - The page-level pre-checks (`performActionPreChecks`): wait for the
//!   main frame's pending navigation to commit or fail.
//! - One deadline for the whole call; errors as the production TS node
//!   reports them (`click: Timeout 10000ms exceeded.`, `fill: Error: Input
//!   of type "checkbox" cannot be filled`, see [`Error::api`]).
//!
//! Every attempt shows itself on the page first when the page's action
//! overlay is on ([`screencast::announce`], `onBeforeInputAction`), with
//! Playwright's call title (`Click locator('aria-ref=e5')`).
//!
//! Not ported (`node/browser.ts` does not use them): `force`, `trial`,
//! `position`, modifiers, `noWaitAfter`, locator handlers (no handlers are
//! ever registered, so their checkpoint is a no-op), the call log.
//!
//! Ported from playwright-core 1.63.0 `src/server/frames.ts`,
//! `src/server/frameSelectors.ts`, `src/server/dom.ts` (Apache-2.0, see
//! `crates/pirc-node/NOTICE`).
//!
//! Owner: locator.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};

use super::cdp::CdpError;
use super::frame::{Arg, EvalError, Frame, JsHandle, World, handle_of};
use super::page::{Page, Shared, deadline, protocol_error, within};
use super::screencast::{self, Rect};
use super::{Error, MouseButton, Result};

/// Visible or hidden (`locator.waitFor({state})`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WaitState {
    Visible,
    Hidden,
}

/// A locator of a page: its selector, resolved anew by every action.
pub struct Locator {
    page: Arc<Page>,
    /// The selector as Playwright's client builds it.
    selector: String,
    /// The locator as Playwright describes it in call titles
    /// (`asLocatorDescription`).
    description: String,
}

impl Locator {
    /// `page.locator('aria-ref=<reference>')`.
    pub fn aria_ref(page: &Arc<Page>, reference: &str) -> Self {
        let selector = format!("aria-ref={reference}");
        Self {
            page: page.clone(),
            description: format!("locator({})", escape_with_quotes(&selector)),
            selector,
        }
    }

    /// `page.getByText(text).first()`: `internal:text="<text>"i >> nth=0`.
    pub fn text_first(page: &Arc<Page>, text: &str) -> Self {
        Self {
            page: page.clone(),
            selector: format!("internal:text={}i >> nth=0", json_string(text)),
            description: format!("getByText({}).first()", escape_with_quotes(text)),
        }
    }

    /// The selector (as Playwright's client sends it).
    pub fn selector(&self) -> &str {
        &self.selector
    }

    /// `locator.click({timeout, button, clickCount})`.
    pub async fn click(
        &self,
        button: MouseButton,
        click_count: u32,
        timeout: Duration,
    ) -> Result<()> {
        let action = Action::Click {
            button,
            click_count,
        };
        self.run("click", timeout, self.act_on_element(&action, timeout))
            .await
            .map(drop)
    }

    /// `locator.hover({timeout})`.
    pub async fn hover(&self, timeout: Duration) -> Result<()> {
        self.run(
            "hover",
            timeout,
            self.act_on_element(&Action::Hover, timeout),
        )
        .await
        .map(drop)
    }

    /// `locator.fill(value, {timeout})`.
    pub async fn fill(&self, value: &str, timeout: Duration) -> Result<()> {
        let action = Action::Fill(value);
        self.run("fill", timeout, self.act_on_element(&action, timeout))
            .await
            .map(drop)
    }

    /// `locator.pressSequentially(text, {delay, timeout})`.
    pub async fn press_sequentially(
        &self,
        text: &str,
        delay: Duration,
        timeout: Duration,
    ) -> Result<()> {
        let action = Action::Type { text, delay };
        self.run(
            "pressSequentially",
            timeout,
            self.act_on_element(&action, timeout),
        )
        .await
        .map(drop)
    }

    /// `locator.press(key, {timeout})`.
    pub async fn press(&self, key: &str, timeout: Duration) -> Result<()> {
        let action = Action::Press(key);
        self.run("press", timeout, self.act_on_element(&action, timeout))
            .await
            .map(drop)
    }

    /// `locator.selectOption(values, {timeout})`: the selected values.
    pub async fn select_option(&self, values: &[String], timeout: Duration) -> Result<Vec<String>> {
        let action = Action::Select(values);
        self.run(
            "selectOption",
            timeout,
            self.act_on_element(&action, timeout),
        )
        .await
    }

    /// `locator.evaluate(fn, undefined, {timeout})`: `function` is called
    /// with the element (and `undefined`), in its frame's main world. The
    /// timeout bounds finding the element, not the evaluation (as
    /// Playwright's).
    pub async fn evaluate(&self, function: &str, timeout: Duration) -> Result<Value> {
        let api = "evaluate";
        let element = self
            .run(api, timeout, self.wait_for_attached(timeout))
            .await?;
        let declaration =
            format!("function(element) {{\n  return (\n{function}\n)(element, undefined);\n}}");
        let main = self.page.main_frame();
        let evaluation = element.call(&declaration, vec![Arg::Handle(element.clone())]);
        let result = tokio::select! {
            result = evaluation => result,
            error = main.gone("") => Err(error),
        };
        element.release().await;
        result.map_err(|error| Error::api(api, error.message))
    }

    /// `locator.waitFor({state, timeout})`; a zero timeout waits forever.
    pub async fn wait_for(&self, state: WaitState, timeout: Duration) -> Result<()> {
        self.run("waitFor", timeout, self.wait_for_state(state, timeout))
            .await
    }
}

// ---------------------------------------------------------------------------
// Shared with the snapshot.

/// A failed step: the error, and whether the operation may retry
/// (Playwright's `isNonRetriableError` of the frame that retries).
pub(super) struct Failure {
    pub(super) error: Error,
    pub(super) retriable: bool,
}

impl Failure {
    pub(super) fn fatal(error: Error) -> Self {
        Self {
            error,
            retriable: false,
        }
    }

    /// An error of a step of an operation retried by `owner`: retriable
    /// unless `owner` (or the page) is gone.
    pub(super) fn of(owner: &Frame, error: Error) -> Self {
        Self {
            error,
            retriable: !owner.is_detached(),
        }
    }

    /// The same for an evaluation (an exception thrown by the page's code is
    /// never retriable).
    pub(super) fn of_eval(owner: &Frame, error: EvalError) -> Self {
        Self {
            retriable: !error.non_retriable && !owner.is_detached(),
            error: error.error,
        }
    }
}

/// The frame a selector runs in (`_jumpToAriaRefFrameIfNeeded`): for an
/// `aria-ref=f<seq>e<n>` selector the page's frame `<seq>`, else `frame`.
pub(super) fn jump_to_aria_ref_frame(
    page: &Page,
    frame: Frame,
    selector: &str,
) -> std::result::Result<Frame, Failure> {
    let Some(reference) = selector.strip_prefix("aria-ref=") else {
        return Ok(frame);
    };
    let reference = reference.split(">>").next().unwrap_or_default().trim();
    let Some(seq) = aria_ref_frame(reference) else {
        return Ok(frame);
    };
    seq.and_then(|seq| page.frame_by_seq(seq)).ok_or_else(|| {
        Failure::fatal(Error::new(format!(
            "Invalid frame in aria-ref selector \"{selector}\""
        )))
    })
}

/// `/^f(\d+)e\d+$/` on a ref: `Some(seq)` when it names a frame (`None`
/// inside when the number is too large to be any frame's).
fn aria_ref_frame(reference: &str) -> Option<Option<u64>> {
    let rest = reference.strip_prefix('f')?;
    let (seq, element) = rest.split_once('e')?;
    let digits = |text: &str| !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit());
    (digits(seq) && digits(element)).then(|| seq.parse().ok())
}

/// The frame an `<iframe>` element shows (`getContentFrame`).
pub(super) async fn content_frame(
    page: &Page,
    owner: &Frame,
    element: &JsHandle,
) -> std::result::Result<Option<Frame>, Failure> {
    let node = element
        .session
        .call("DOM.describeNode", json!({ "objectId": element.object_id }))
        .await
        .map_err(|e| Failure::of(owner, protocol_error("", "DOM.describeNode", e)))?;
    let Some(id) = node["node"]["frameId"].as_str() else {
        return Ok(None);
    };
    Ok(page.frames().into_iter().find(|frame| frame.id() == id))
}

/// Sleep `duration`, failing when `owner` detaches or the page closes
/// (the retry waits of `retryWithProgressAndTimeouts`).
pub(super) async fn retry_wait(owner: &Frame, duration: Duration) -> Result<()> {
    tokio::select! {
        () = tokio::time::sleep(duration) => Ok(()),
        error = owner.gone("") => Err(error),
    }
}

/// `JSON.stringify` of a string.
fn json_string(text: &str) -> String {
    serde_json::to_string(text).expect("a string serializes")
}

/// `escapeWithQuotes(text, "'")` (the JS locator generator's quoting).
fn escape_with_quotes(text: &str) -> String {
    let stringified = json_string(text);
    let inner = stringified[1..stringified.len() - 1].replace("\\\"", "\"");
    format!("'{}'", inner.replace('\'', "\\'"))
}

// ---------------------------------------------------------------------------
// Element actions.

/// What [`Locator::act_on_element`] does with the element.
enum Action<'a> {
    Click {
        button: MouseButton,
        click_count: u32,
    },
    Hover,
    Fill(&'a str),
    Type {
        text: &'a str,
        delay: Duration,
    },
    Press(&'a str),
    Select(&'a [String]),
}

impl Action<'_> {
    /// `renderTitleForCall`'s title (`formatProtocolParam` escapes line
    /// breaks).
    fn title(&self, locator: &str) -> String {
        let param = |value: &str| value.replace('\n', "\\n");
        let title = match self {
            Self::Click { .. } => "Click".to_owned(),
            Self::Hover => "Hover".to_owned(),
            Self::Fill(value) => format!("Fill \"{}\"", param(value)),
            Self::Type { text, .. } => format!("Type \"{}\"", param(text)),
            Self::Press(key) => format!("Press \"{}\"", param(key)),
            Self::Select(_) => "Select option".to_owned(),
        };
        format!("{title} {}", param(locator))
    }
}

/// What an attempt of an action ended with (the injected script's
/// `error:*` strings and state objects).
#[derive(Clone, Debug, PartialEq)]
enum Outcome {
    Done,
    NotConnected,
    NotVisible,
    NotInViewport,
    OptionsNotFound,
    OptionNotEnabled,
    HitTarget(String),
    MissingState(String),
}

impl Outcome {
    /// An injected call's result: `undefined`/`"done"` are done.
    fn of(value: &Value) -> Self {
        match value {
            Value::String(text) => match text.as_str() {
                "error:notconnected" => Self::NotConnected,
                "error:notvisible" => Self::NotVisible,
                "error:notinviewport" => Self::NotInViewport,
                "error:optionsnotfound" => Self::OptionsNotFound,
                "error:optionnotenabled" => Self::OptionNotEnabled,
                _ => Self::Done,
            },
            Value::Object(object) => {
                if let Some(state) = object.get("missingState") {
                    Self::MissingState(state.as_str().unwrap_or_default().to_owned())
                } else if let Some(description) = object.get("hitTargetDescription") {
                    Self::HitTarget(description.as_str().unwrap_or_default().to_owned())
                } else {
                    Self::Done
                }
            }
            _ => Self::Done,
        }
    }

    /// What `_retryAction` retries.
    fn retries(&self) -> bool {
        !matches!(self, Self::Done | Self::NotConnected)
    }
}

/// An element found by a selector: a handle in its frame's utility world.
struct Element {
    frame: Frame,
    handle: JsHandle,
    /// Its `getBoundingClientRect()` when it was found (for the action
    /// overlay; only taken while the overlay is on).
    rect: Option<Rect>,
}

/// An `evaluateInUtility` result.
enum Eval {
    Value(Value),
    /// The evaluation failed in a way a retry can fix (Playwright's
    /// `'error:notconnected'`).
    NotConnected,
}

impl Element {
    /// `evaluateInUtility`: `function(node, arg)` called on the frame's
    /// current injected script.
    async fn eval(&self, function: &str, arg: Value) -> std::result::Result<Eval, Failure> {
        self.eval_raw(function, arg, true)
            .await
            .map(|eval| match eval {
                Eval::Value(object) => Eval::Value(object["value"].clone()),
                other => other,
            })
    }

    /// The same, with the result's `RemoteObject` (`_evaluateHandleInUtility`
    /// when not `by_value`).
    async fn eval_raw(
        &self,
        function: &str,
        arg: Value,
        by_value: bool,
    ) -> std::result::Result<Eval, Failure> {
        let call = async {
            let (injected, uid) =
                self.frame
                    .injected_in_context()
                    .await
                    .map_err(|error| EvalError {
                        error,
                        non_retriable: false,
                    })?;
            self.frame
                .call_in_context(
                    uid,
                    &injected,
                    function,
                    vec![Arg::Handle(self.handle.clone()), Arg::Value(arg)],
                    by_value,
                )
                .await
        };
        match call.await {
            Ok(object) => Ok(Eval::Value(object)),
            Err(error) if error.non_retriable || self.frame.is_detached() => {
                Err(Failure::fatal(error.error))
            }
            Err(_) => Ok(Eval::NotConnected),
        }
    }

    async fn release(self) {
        self.handle.release().await;
    }
}

/// Resolve the selector: the first element (`elements[0]`), strict.
const RESOLVE: &str = "function(selector, strict, markTargets) {
  const parsed = this.parseSelector(selector);
  const elements = this.querySelectorAll(parsed, document);
  if (markTargets)
    this.markTargetElements(new Set(elements));
  if (strict && elements.length > 1)
    throw this.strictModeViolationError(parsed, elements);
  return elements.length ? elements[0] : null;
}";

/// `waitForSelector`'s probe: `null` without a match, else its visibility.
const PROBE: &str = "function(selector, strict) {
  const parsed = this.parseSelector(selector);
  const elements = this.querySelectorAll(parsed, document);
  if (strict && elements.length > 1)
    throw this.strictModeViolationError(parsed, elements);
  if (!elements.length)
    return null;
  return { visible: this.utils.isElementVisible(elements[0]) };
}";

const RECT: &str = "function(node) {
  const rect = node.getBoundingClientRect();
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}";

const CHECK_STATES: &str = "async function(node, states) {
  return await this.checkElementStates(node, states);
}";

const RETRY_WAIT: &str = "function(node, timeout) {
  return new Promise((f) => setTimeout(f, timeout));
}";

const SCROLL_INTO_VIEW: &str = "function(node, options) {
  if (node.nodeType === 1)
    node.scrollIntoView(options);
  return 'done';
}";

const SETUP_HIT_TARGET: &str = "function(node, args) {
  return this.setupHitTargetInterceptor(node, args.actionType, args.hitPoint ?? undefined, args.trial);
}";

const EXPECT_HIT_TARGET: &str = "function(element, hitPoint) {
  return this.expectHitTarget(hitPoint, element);
}";

const DESCRIBE_IFRAME_STYLE: &str = "function(iframe) {
  return this.describeIFrameStyle(iframe);
}";

const FILL: &str = "async function(node, value) {
  const checkResult = await this.checkElementStates(node, ['visible', 'enabled', 'editable']);
  if (checkResult)
    return checkResult;
  return this.fill(node, value);
}";

const SELECT: &str = "async function(node, optionsToSelect) {
  const checkResult = await this.checkElementStates(node, ['visible', 'enabled']);
  if (checkResult)
    return checkResult;
  return this.selectOptions(node, optionsToSelect);
}";

const FOCUS: &str = "function(node, resetSelectionIfNotFocused) {
  return this.focusNode(node, resetSelectionIfNotFocused);
}";

/// `scrollIntoView` alignments `_retryPointerAction` rotates through
/// (`None`: `DOM.scrollIntoViewIfNeeded`).
const SCROLLS: [Option<(&str, &str)>; 4] = [
    None,
    Some(("end", "end")),
    Some(("center", "center")),
    Some(("start", "start")),
];

/// `_retryAction`'s waits between attempts.
const ACTION_WAITS: [u64; 5] = [0, 20, 100, 100, 500];

/// `retryWithProgressAndBackoff`'s waits for `timeout`: `[0, 20, 50, 100,
/// 100, 500]` without the long ones a short timeout cannot use.
fn backoff(timeout: Duration) -> Vec<u64> {
    let mut scale = vec![20u64, 50, 100, 100, 500];
    if !timeout.is_zero() {
        let limit = timeout.as_secs_f64() * 1000.0 / 5.0;
        while scale.last().is_some_and(|last| *last as f64 > limit) {
            scale.pop();
        }
    }
    scale.insert(0, 0);
    scale
}

/// `roundPoint`: truncated to hundredths.
fn round_point((x, y): (f64, f64)) -> (f64, f64) {
    let round = |value: f64| f64::from((value * 100.0) as i32) / 100.0;
    (round(x), round(y))
}

fn rect_of(value: &Value) -> Option<Rect> {
    Some(Rect {
        x: value["x"].as_f64()?,
        y: value["y"].as_f64()?,
        width: value["width"].as_f64()?,
        height: value["height"].as_f64()?,
    })
}

/// Removes a signal barrier when the action ends (however it ends).
struct BarrierGuard {
    shared: Arc<Shared>,
    id: u64,
}

impl Drop for BarrierGuard {
    fn drop(&mut self) {
        self.shared.remove_signal_barrier(self.id);
    }
}

/// The hit-target interceptor of an action, stopped and released when the
/// action ends (in the background when it was cut short).
struct Interceptor(Option<JsHandle>);

const STOP_INTERCEPTOR: &str = "function() { return this.stop(); }";

impl Interceptor {
    /// `stop()`: `"done"` or the element that got the events instead.
    async fn stop(&mut self) -> Outcome {
        let Some(handle) = self.0.take() else {
            return Outcome::Done;
        };
        let result = handle.call(STOP_INTERCEPTOR, Vec::new()).await;
        handle.release().await;
        result.map_or(Outcome::Done, |value| Outcome::of(&value))
    }
}

impl Drop for Interceptor {
    fn drop(&mut self) {
        if let Some(handle) = self.0.take()
            && let Ok(runtime) = tokio::runtime::Handle::try_current()
        {
            runtime.spawn(async move {
                let _ = handle.call(STOP_INTERCEPTOR, Vec::new()).await;
                handle.release().await;
            });
        }
    }
}

/// What `_checkFrameIsHitTarget` found.
enum FrameCheck {
    Outcome(Outcome),
    /// The point in the element's frame (`None` in a transformed iframe).
    Point(Option<(f64, f64)>),
}

impl Locator {
    /// Run an API call: under `timeout` (none when zero), failing when the
    /// page closes, its errors prefixed with `api`.
    async fn run<T>(
        &self,
        api: &str,
        timeout: Duration,
        work: impl std::future::Future<Output = Result<T>>,
    ) -> Result<T> {
        let main = self.page.main_frame();
        let raced = async {
            tokio::select! {
                result = work => result,
                error = main.gone("") => Err(error),
            }
        };
        match within(deadline(timeout), raced).await {
            Some(result) => result.map_err(|error| Error::api(api, error.message)),
            None => Err(Error::timeout(api, timeout)),
        }
    }

    /// `performActionPreChecks`: wait for the main frame's pending
    /// navigation (twice, around the no-op locator handlers' checkpoint).
    async fn pre_checks(&self) -> Result<()> {
        self.wait_for_navigation_check().await?;
        self.wait_for_navigation_check().await
    }

    /// `_performWaitForNavigationCheck`.
    async fn wait_for_navigation_check(&self) -> Result<()> {
        let main = self.page.main_frame();
        let mut navigations = main.subscribe_navigations();
        let pending = {
            let state = self.page.shared.state.lock().unwrap();
            state
                .frames
                .get(&main.key)
                .is_some_and(|frame| frame.pending.is_some())
        };
        if !pending {
            return Ok(());
        }
        tokio::select! {
            _ = navigations.recv() => Ok(()),
            error = main.gone("") => Err(error),
        }
    }

    /// The frame the selector runs in.
    fn target_frame(&self, main: &Frame) -> std::result::Result<Frame, Failure> {
        jump_to_aria_ref_frame(&self.page, main.clone(), &self.selector)
    }

    /// `callOnSelectorHandle` returning the first element, strict.
    async fn resolve(&self, mark_targets: bool) -> std::result::Result<Option<Element>, Failure> {
        let main = self.page.main_frame();
        let frame = self.target_frame(&main)?;
        let injected = frame
            .injected()
            .await
            .map_err(|error| Failure::of(&main, error))?;
        let object = injected
            .call_raw(
                RESOLVE,
                vec![
                    Arg::Value(json!(self.selector)),
                    Arg::Value(json!(true)),
                    Arg::Value(json!(mark_targets)),
                ],
                false,
            )
            .await
            .map_err(|error| Failure::of_eval(&main, error))?;
        let Some(handle) = handle_of(&injected.session, &object) else {
            return Ok(None);
        };
        let mut element = Element {
            frame,
            handle,
            rect: None,
        };
        if self.page.screencast_state().actions().is_some()
            && let Eval::Value(rect) = element.eval(RECT, Value::Null).await?
        {
            element.rect = rect_of(&rect);
        }
        Ok(Some(element))
    }

    /// `Frame._retryWithProgressIfNotConnected` with an element action.
    async fn act_on_element(&self, action: &Action<'_>, timeout: Duration) -> Result<Vec<String>> {
        let main = self.page.main_frame();
        let waits = backoff(timeout);
        let mut attempt = 0;
        loop {
            let wait = waits[attempt.min(waits.len() - 1)];
            attempt += 1;
            if wait > 0 {
                retry_wait(&main, Duration::from_millis(wait)).await?;
            }
            self.pre_checks().await?;
            let element = match self.resolve(true).await {
                Ok(Some(element)) => element,
                Ok(None) => continue,
                Err(failure) if failure.retriable => continue,
                Err(failure) => return Err(failure.error),
            };
            let mut values = Vec::new();
            let result = self.act(&element, action, &mut values).await;
            element.release().await;
            match result {
                Ok(Outcome::NotConnected) => continue,
                Ok(_) => return Ok(values),
                Err(failure) if failure.retriable => continue,
                Err(failure) => return Err(failure.error),
            }
        }
    }

    async fn act(
        &self,
        element: &Element,
        action: &Action<'_>,
        values: &mut Vec<String>,
    ) -> std::result::Result<Outcome, Failure> {
        match action {
            Action::Click { .. } | Action::Hover | Action::Fill(_) | Action::Select(_) => {
                self.retry_action(element, action, values).await
            }
            Action::Type { text, delay } => {
                self.announce(action, None, element.rect).await?;
                match self.focus(element).await? {
                    Outcome::Done => {}
                    other => return Ok(other),
                }
                self.page
                    .keyboard()
                    .raw()
                    .type_text(text, *delay)
                    .await
                    .map_err(|error| self.input_failure(error))?;
                Ok(Outcome::Done)
            }
            Action::Press(key) => {
                self.announce(action, None, element.rect).await?;
                self.with_signal_barrier(true, async {
                    match self.focus(element).await? {
                        Outcome::Done => {}
                        other => return Ok(other),
                    }
                    self.page
                        .keyboard()
                        .raw()
                        .press(key, Duration::ZERO)
                        .await
                        .map_err(|error| self.input_failure(error))?;
                    Ok(Outcome::Done)
                })
                .await
            }
        }
    }

    /// `_focus(progress, resetSelectionIfNotFocused = true)`.
    async fn focus(&self, element: &Element) -> std::result::Result<Outcome, Failure> {
        Ok(match element.eval(FOCUS, json!(true)).await? {
            Eval::Value(value) => Outcome::of(&value),
            Eval::NotConnected => Outcome::NotConnected,
        })
    }

    /// A keyboard or mouse error: an unknown key is final, a protocol error
    /// retriable while the page lives.
    fn input_failure(&self, error: Error) -> Failure {
        let retriable = !error.message.starts_with("Unknown key: ") && !self.page.is_closed();
        Failure { error, retriable }
    }

    /// `onBeforeInputAction` for an attempt (its failure is retriable).
    async fn announce(
        &self,
        action: &Action<'_>,
        point: Option<(f64, f64)>,
        rect: Option<Rect>,
    ) -> std::result::Result<(), Failure> {
        if self.page.screencast_state().actions().is_none() {
            return Ok(());
        }
        let title = action.title(&self.description);
        screencast::announce(&self.page, &title, point, rect)
            .await
            .map_err(|error| Failure::of(&self.page.main_frame(), error))
    }

    /// `ElementHandle._retryAction`.
    async fn retry_action(
        &self,
        element: &Element,
        action: &Action<'_>,
        values: &mut Vec<String>,
    ) -> std::result::Result<Outcome, Failure> {
        let mut retry = 0usize;
        loop {
            if retry > 0 {
                let wait = ACTION_WAITS[(retry - 1).min(ACTION_WAITS.len() - 1)];
                if wait > 0
                    && let Eval::NotConnected = element.eval(RETRY_WAIT, json!(wait)).await?
                {
                    return Ok(Outcome::NotConnected);
                }
            }
            self.pre_checks().await.map_err(Failure::fatal)?;
            let outcome = self.attempt(element, action, retry, values).await?;
            retry += 1;
            if !outcome.retries() {
                return Ok(outcome);
            }
        }
    }

    async fn attempt(
        &self,
        element: &Element,
        action: &Action<'_>,
        retry: usize,
        values: &mut Vec<String>,
    ) -> std::result::Result<Outcome, Failure> {
        match action {
            Action::Fill(value) => {
                self.announce(action, None, element.rect).await?;
                let result = match element.eval(FILL, json!(value)).await? {
                    Eval::Value(result) => result,
                    Eval::NotConnected => return Ok(Outcome::NotConnected),
                };
                if result != "needsinput" {
                    return Ok(Outcome::of(&result));
                }
                let keyboard = self.page.keyboard().raw();
                let typed = if value.is_empty() {
                    keyboard.press("Delete", Duration::ZERO).await
                } else {
                    keyboard.insert_text(value).await
                };
                typed.map_err(|error| self.input_failure(error))?;
                Ok(Outcome::Done)
            }
            Action::Select(options) => {
                self.announce(action, None, element.rect).await?;
                let options: Vec<Value> = options
                    .iter()
                    .map(|value| json!({ "valueOrLabel": value }))
                    .collect();
                match element.eval(SELECT, json!(options)).await? {
                    Eval::Value(Value::Array(selected)) => {
                        *values = selected
                            .iter()
                            .map(|value| value.as_str().unwrap_or_default().to_owned())
                            .collect();
                        Ok(Outcome::Done)
                    }
                    Eval::Value(result) => Ok(Outcome::of(&result)),
                    Eval::NotConnected => Ok(Outcome::NotConnected),
                }
            }
            _ => {
                self.pointer_action(element, action, SCROLLS[retry % SCROLLS.len()])
                    .await
            }
        }
    }

    /// `_performPointerAction` (no `force`, `position` or `trial`).
    async fn pointer_action(
        &self,
        element: &Element,
        action: &Action<'_>,
        force_scroll: Option<(&str, &str)>,
    ) -> std::result::Result<Outcome, Failure> {
        let click = matches!(action, Action::Click { .. });
        if element.frame.parent().is_some() {
            let _ = self.scroll_into_view(element, force_scroll).await;
        }
        let states: &[&str] = if click {
            &["visible", "enabled", "stable"]
        } else {
            &["visible", "stable"]
        };
        match element.eval(CHECK_STATES, json!(states)).await? {
            Eval::NotConnected => return Ok(Outcome::NotConnected),
            Eval::Value(Value::Null) => {}
            Eval::Value(result) => return Ok(Outcome::of(&result)),
        }
        match self.scroll_into_view(element, force_scroll).await? {
            Outcome::Done => {}
            other => return Ok(other),
        }
        let (point, rect) = match self.clickable_point(element).await? {
            Ok(found) => found,
            Err(outcome) => return Ok(outcome),
        };
        let point = round_point(point);
        self.announce(action, Some(point), Some(rect)).await?;
        let hit_point = match self.check_frame_is_hit_target(element, point).await? {
            FrameCheck::Outcome(outcome) => return Ok(outcome),
            FrameCheck::Point(point) => point,
        };
        let args = json!({
            "actionType": if click { "mouse" } else { "hover" },
            "hitPoint": hit_point.map(|(x, y)| json!({ "x": x, "y": y })),
            "trial": false,
        });
        let mut interceptor = match element.eval_raw(SETUP_HIT_TARGET, args, false).await? {
            Eval::NotConnected => return Ok(Outcome::NotConnected),
            Eval::Value(object) => match handle_of(&element.handle.session, &object) {
                Some(handle) => Interceptor(Some(handle)),
                None => {
                    let error = object["value"].as_str().unwrap_or_default();
                    return Ok(if error == "error:notconnected" {
                        Outcome::NotConnected
                    } else {
                        Outcome::HitTarget(error.to_owned())
                    });
                }
            },
        };
        self.with_signal_barrier(click, async {
            let modifiers = self.page.keyboard().modifiers();
            let mouse = self.page.mouse().raw();
            let input = match action {
                Action::Click {
                    button,
                    click_count,
                } => {
                    mouse
                        .click(point.0, point.1, *button, *click_count, modifiers)
                        .await
                }
                _ => mouse.move_to(point.0, point.1, 1, false, modifiers).await,
            };
            input.map_err(|error| self.input_failure(error))?;
            Ok(interceptor.stop().await)
        })
        .await
    }

    /// `waitForSignalsCreatedBy`: with `wait_after`, also wait for the
    /// navigations the main frame requested meanwhile to commit or fail.
    async fn with_signal_barrier<T>(
        &self,
        wait_after: bool,
        action: impl std::future::Future<Output = std::result::Result<T, Failure>>,
    ) -> std::result::Result<T, Failure> {
        if !wait_after {
            return action.await;
        }
        let shared = self.page.shared.clone();
        let guard = BarrierGuard {
            id: shared.add_signal_barrier(),
            shared,
        };
        let result = action.await?;
        // `inputActionEpilogue`.
        let _ = self.page.session().call("Page.enable", json!({})).await;
        guard.shared.barrier().await;
        guard.shared.wait_signal_barrier(guard.id).await;
        tokio::task::yield_now().await;
        Ok(result)
    }

    /// `doScrollIntoView`.
    async fn scroll_into_view(
        &self,
        element: &Element,
        force: Option<(&str, &str)>,
    ) -> std::result::Result<Outcome, Failure> {
        if let Some((block, inline)) = force {
            let options = json!({ "block": block, "inline": inline });
            return Ok(match element.eval(SCROLL_INTO_VIEW, options).await? {
                Eval::NotConnected => Outcome::NotConnected,
                Eval::Value(_) => Outcome::Done,
            });
        }
        let scrolled = element
            .handle
            .session
            .call(
                "DOM.scrollIntoViewIfNeeded",
                json!({ "objectId": element.handle.object_id }),
            )
            .await;
        match scrolled {
            Ok(_) => Ok(Outcome::Done),
            Err(error) if error.message.contains("Node does not have a layout object") => {
                Ok(Outcome::NotVisible)
            }
            Err(error) if error.message.contains("Node is detached from document") => {
                Ok(Outcome::NotConnected)
            }
            Err(error) => Err(self.protocol_failure("DOM.scrollIntoViewIfNeeded", error)),
        }
    }

    fn protocol_failure(&self, method: &str, error: CdpError) -> Failure {
        Failure::of(&self.page.main_frame(), protocol_error("", method, error))
    }

    /// `_clickablePoint`: the middle of the element's first content quad
    /// with some area in the viewport, and that quad's box.
    async fn clickable_point(
        &self,
        element: &Element,
    ) -> std::result::Result<std::result::Result<((f64, f64), Rect), Outcome>, Failure> {
        let main = self.page.main_frame();
        let quads = async {
            let quads = element
                .handle
                .session
                .call(
                    "DOM.getContentQuads",
                    json!({ "objectId": element.handle.object_id }),
                )
                .await
                .ok();
            let Some(quads) = quads else {
                return Ok(None);
            };
            let Some((dx, dy)) = self.frame_position(&element.frame).await? else {
                return Ok(None);
            };
            let quads: Vec<[(f64, f64); 4]> = quads["quads"]
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or_default()
                .iter()
                .map(|quad| {
                    let at = |i: usize| quad[i].as_f64().unwrap_or_default();
                    [
                        (at(0) + dx, at(1) + dy),
                        (at(2) + dx, at(3) + dy),
                        (at(4) + dx, at(5) + dy),
                        (at(6) + dx, at(7) + dy),
                    ]
                })
                .collect();
            Ok(Some(quads))
        };
        let metrics = async {
            main.evaluate_in(
                World::Utility,
                "",
                "() => ({ width: innerWidth, height: innerHeight })",
                Value::Null,
            )
            .await
            .map_err(|error| Failure::of_eval(&main, error))
        };
        let (quads, metrics) = tokio::join!(quads, metrics);
        let (quads, metrics) = (quads?, metrics?);
        let Some(quads) = quads.filter(|quads| !quads.is_empty()) else {
            return Ok(Err(Outcome::NotVisible));
        };
        let width = metrics["width"].as_f64().unwrap_or_default();
        let height = metrics["height"].as_f64().unwrap_or_default();
        let clipped = quads
            .iter()
            .map(|quad| quad.map(|(x, y)| (x.max(0.0).min(width), y.max(0.0).min(height))));
        let Some(quad) = clipped.into_iter().find(|quad| quad_area(quad) > 0.99) else {
            return Ok(Err(Outcome::NotInViewport));
        };
        let (mut min_x, mut min_y) = (f64::INFINITY, f64::INFINITY);
        let (mut max_x, mut max_y) = (f64::NEG_INFINITY, f64::NEG_INFINITY);
        let (mut mid_x, mut mid_y) = (0.0, 0.0);
        for (x, y) in quad {
            min_x = min_x.min(x);
            min_y = min_y.min(y);
            max_x = max_x.max(x);
            max_y = max_y.max(y);
            mid_x += x / 4.0;
            mid_y += y / 4.0;
        }
        let rect = Rect {
            x: min_x,
            y: min_y,
            width: max_x - min_x,
            height: max_y - min_y,
        };
        Ok(Ok(((mid_x, mid_y), rect)))
    }

    /// `_framePosition` of the session that owns `frame`: the origin of
    /// its local root (an out-of-process iframe) in the main frame's
    /// viewport; `(0, 0)` for the page's own session.
    fn frame_position<'a>(
        &'a self,
        frame: &'a Frame,
    ) -> futures_util::future::BoxFuture<'a, std::result::Result<Option<(f64, f64)>, Failure>> {
        Box::pin(async move {
            let session = frame.session();
            if session.id() == self.page.session().id() {
                return Ok(Some((0.0, 0.0)));
            }
            let mut root = frame.clone();
            while let Some(parent) = root.parent() {
                if parent.session().id() != session.id() {
                    break;
                }
                root = parent;
            }
            let Some(parent) = root.parent() else {
                return Ok(Some((0.0, 0.0)));
            };
            let main = self.page.main_frame();
            let Some(owner) = root
                .owner()
                .await
                .map_err(|error| Failure::of(&main, error))?
            else {
                return Ok(None);
            };
            let rect = self.bounding_box(&owner, &parent).await;
            owner.release().await;
            Ok(rect?.map(|rect| (rect.x, rect.y)))
        })
    }

    /// `boundingBox` of an element of `frame` in the main frame's
    /// viewport (`DOM.getBoxModel`'s border box).
    async fn bounding_box(
        &self,
        element: &JsHandle,
        frame: &Frame,
    ) -> std::result::Result<Option<Rect>, Failure> {
        let model = element
            .session
            .call("DOM.getBoxModel", json!({ "objectId": element.object_id }))
            .await;
        let Ok(model) = model else {
            return Ok(None);
        };
        let quad: Vec<f64> = model["model"]["border"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_default()
            .iter()
            .map(|value| value.as_f64().unwrap_or_default())
            .collect();
        if quad.len() < 8 {
            return Ok(None);
        }
        let xs = [quad[0], quad[2], quad[4], quad[6]];
        let ys = [quad[1], quad[3], quad[5], quad[7]];
        let x = xs.iter().copied().fold(f64::INFINITY, f64::min);
        let y = ys.iter().copied().fold(f64::INFINITY, f64::min);
        let width = xs.iter().copied().fold(f64::NEG_INFINITY, f64::max) - x;
        let height = ys.iter().copied().fold(f64::NEG_INFINITY, f64::max) - y;
        let Some((dx, dy)) = self.frame_position(frame).await? else {
            return Ok(None);
        };
        Ok(Some(Rect {
            x: x + dx,
            y: y + dy,
            width,
            height,
        }))
    }

    /// `_checkFrameIsHitTarget`: the point must hit each `<iframe>` on the
    /// way from the main frame to the element's frame.
    async fn check_frame_is_hit_target(
        &self,
        element: &Element,
        point: (f64, f64),
    ) -> std::result::Result<FrameCheck, Failure> {
        let main = self.page.main_frame();
        // (the frame, its <iframe> in the parent's utility world, the point
        // in the frame).
        let mut data: Vec<(Frame, Option<JsHandle>, (f64, f64))> = Vec::new();
        let release = |data: Vec<(Frame, Option<JsHandle>, (f64, f64))>| async move {
            for (_, owner, _) in data {
                if let Some(owner) = owner {
                    owner.release().await;
                }
            }
        };
        let mut frame = element.frame.clone();
        while let Some(parent) = frame.parent() {
            let owner = match frame.owner().await {
                Ok(Some(owner)) => owner,
                Ok(None) => {
                    release(data).await;
                    return Ok(FrameCheck::Outcome(Outcome::NotConnected));
                }
                Err(error) => {
                    release(data).await;
                    return Err(Failure::of(&main, error));
                }
            };
            let rect = match self.bounding_box(&owner, &parent).await {
                Ok(rect) => rect,
                Err(failure) => {
                    owner.release().await;
                    release(data).await;
                    return Err(failure);
                }
            };
            let style = async {
                let injected = parent.injected().await.ok()?;
                injected
                    .call(DESCRIBE_IFRAME_STYLE, vec![Arg::Handle(owner.clone())])
                    .await
                    .ok()
            }
            .await;
            let (Some(rect), Some(style)) = (rect, style) else {
                owner.release().await;
                release(data).await;
                return Ok(FrameCheck::Outcome(Outcome::NotConnected));
            };
            if style == "error:notconnected" {
                owner.release().await;
                release(data).await;
                return Ok(FrameCheck::Outcome(Outcome::NotConnected));
            }
            if style == "transformed" {
                owner.release().await;
                release(data).await;
                return Ok(FrameCheck::Point(None));
            }
            let left = style["left"].as_f64().unwrap_or(f64::NAN);
            let top = style["top"].as_f64().unwrap_or(f64::NAN);
            let in_frame = (point.0 - rect.x - left, point.1 - rect.y - top);
            data.push((frame, Some(owner), in_frame));
            frame = parent;
        }
        data.push((frame, None, point));
        for i in (1..data.len()).rev() {
            let (parent, _, parent_point) = &data[i];
            let owner = data[i - 1].1.clone().expect("a child frame has an owner");
            let hit = async {
                let injected = parent.injected().await.map_err(|error| EvalError {
                    error,
                    non_retriable: false,
                })?;
                injected
                    .call_raw(
                        EXPECT_HIT_TARGET,
                        vec![
                            Arg::Handle(owner),
                            Arg::Value(json!({ "x": parent_point.0, "y": parent_point.1 })),
                        ],
                        true,
                    )
                    .await
            }
            .await;
            let outcome = match hit {
                Ok(object) => Outcome::of(&object["value"]),
                Err(error) if error.non_retriable || parent.is_detached() => {
                    release(data).await;
                    return Err(Failure::fatal(error.error));
                }
                Err(_) => Outcome::NotConnected,
            };
            if outcome != Outcome::Done {
                release(data).await;
                return Ok(FrameCheck::Outcome(outcome));
            }
        }
        let point = data[0].2;
        release(data).await;
        Ok(FrameCheck::Point(Some(point)))
    }

    /// `Frame.waitForSelector(selector, {strict: true, state})` with
    /// `omitReturnValue`.
    async fn wait_for_state(&self, state: WaitState, timeout: Duration) -> Result<()> {
        let main = self.page.main_frame();
        let waits = backoff(timeout);
        let mut attempt = 0;
        loop {
            let wait = waits[attempt.min(waits.len() - 1)];
            attempt += 1;
            if wait > 0 {
                retry_wait(&main, Duration::from_millis(wait)).await?;
            }
            self.pre_checks().await?;
            let probe = async {
                let frame = self.target_frame(&main)?;
                let injected = frame
                    .injected()
                    .await
                    .map_err(|error| Failure::of(&main, error))?;
                injected
                    .call_raw(
                        PROBE,
                        vec![Arg::Value(json!(self.selector)), Arg::Value(json!(true))],
                        true,
                    )
                    .await
                    .map_err(|error| Failure::of_eval(&main, error))
            };
            let found = match probe.await {
                Ok(found) => found["value"].clone(),
                Err(failure) if failure.retriable => continue,
                Err(failure) => return Err(failure.error),
            };
            let done = match (&found, state) {
                (Value::Null, WaitState::Hidden) => true,
                (Value::Null, WaitState::Visible) => false,
                (found, WaitState::Visible) => found["visible"] == true,
                (found, WaitState::Hidden) => found["visible"] != true,
            };
            if done {
                return Ok(());
            }
        }
    }

    /// `Frame.waitForSelector(selector, {strict: true, state: 'attached'})`:
    /// the element, in its frame's main world.
    async fn wait_for_attached(&self, timeout: Duration) -> Result<JsHandle> {
        let main = self.page.main_frame();
        let waits = backoff(timeout);
        let mut attempt = 0;
        loop {
            let wait = waits[attempt.min(waits.len() - 1)];
            attempt += 1;
            if wait > 0 {
                retry_wait(&main, Duration::from_millis(wait)).await?;
            }
            self.pre_checks().await?;
            let element = match self.resolve(false).await {
                Ok(Some(element)) => element,
                Ok(None) => continue,
                Err(failure) if failure.retriable => continue,
                Err(failure) => return Err(failure.error),
            };
            let adopted = element.frame.adopt(&element.handle, false).await;
            element.release().await;
            if let Ok(handle) = adopted {
                return Ok(handle);
            }
        }
    }
}

/// `computeQuadArea`.
fn quad_area(quad: &[(f64, f64); 4]) -> f64 {
    let mut area = 0.0;
    for i in 0..4 {
        let (x1, y1) = quad[i];
        let (x2, y2) = quad[(i + 1) % 4];
        area += (x1 * y2 - x2 * y1) / 2.0;
    }
    f64::abs(area)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_frame_refs_as_playwright() {
        assert_eq!(aria_ref_frame("e5"), None);
        assert_eq!(aria_ref_frame("f1e5"), Some(Some(1)));
        assert_eq!(aria_ref_frame("f99e1"), Some(Some(99)));
        assert_eq!(aria_ref_frame("fe1"), None);
        assert_eq!(aria_ref_frame("f1e"), None);
        assert_eq!(aria_ref_frame("f1x2"), None);
        assert_eq!(aria_ref_frame("f99999999999999999999999e1"), Some(None));
    }

    #[test]
    fn builds_selectors_and_titles_as_playwright() {
        assert_eq!(escape_with_quotes("aria-ref=e5"), "'aria-ref=e5'");
        assert_eq!(escape_with_quotes("it's \"x\"\n"), "'it\\'s \"x\"\\n'");
        assert_eq!(json_string("a \"b\"\n"), "\"a \\\"b\\\"\\n\"");
        assert_eq!(
            Action::Fill("a\nb").title("locator('aria-ref=e5')"),
            "Fill \"a\\nb\" locator('aria-ref=e5')"
        );
        assert_eq!(
            Action::Hover.title("locator('aria-ref=f1e2')"),
            "Hover locator('aria-ref=f1e2')"
        );
    }

    #[test]
    fn backs_off_as_playwright() {
        assert_eq!(backoff(Duration::from_secs(10)), [0, 20, 50, 100, 100, 500]);
        assert_eq!(backoff(Duration::from_secs(1)), [0, 20, 50, 100, 100]);
        assert_eq!(backoff(Duration::from_millis(500)), [0, 20, 50, 100, 100]);
        assert_eq!(backoff(Duration::from_millis(100)), [0, 20]);
        assert_eq!(backoff(Duration::ZERO), [0, 20, 50, 100, 100, 500]);
    }

    #[test]
    fn rounds_and_measures_as_playwright() {
        assert_eq!(round_point((10.456, -3.019)), (10.45, -3.01));
        assert_eq!(
            quad_area(&[(0.0, 0.0), (2.0, 0.0), (2.0, 3.0), (0.0, 3.0)]),
            6.0
        );
        assert_eq!(
            Outcome::of(&json!({ "missingState": "enabled" })),
            Outcome::MissingState("enabled".into())
        );
        assert_eq!(Outcome::of(&Value::Null), Outcome::Done);
        assert_eq!(
            Outcome::of(&json!("error:notconnected")),
            Outcome::NotConnected
        );
    }
}
