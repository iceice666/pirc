//! Explicit, memory-strategy-independent request-context rewriting.
//! No storage, retrieval, summarization, authorization or automatic repair.

use std::collections::HashMap;
use std::fmt;
use std::ops::Range;
use std::sync::Arc;

use pirc_llm_types::{AssistantContent, Message, StopReason};

/// A failed rewrite never changes the loop or its history.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RewriteError {
    WrongState,
    StaleSnapshot,
    InvalidRange,
    InvalidHistory,
    SplitToolGroup,
    Resume(crate::ResumeError),
}

impl fmt::Display for RewriteError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self:?}")
    }
}

impl std::error::Error for RewriteError {}

/// A replacement of one range in an immutable history snapshot.
///
/// Replacement messages may carry summaries, retrieval results, or any other
/// host-selected memory representation. They are context, not new authority.
/// Endpoints must preserve complete tool batches (including every result).
#[derive(Clone, Debug)]
pub struct Rewrite {
    base: Arc<Vec<Message>>,
    range: Range<usize>,
    replacement: Vec<Message>,
}

impl Rewrite {
    pub fn new(base: Arc<Vec<Message>>, range: Range<usize>, replacement: Vec<Message>) -> Self {
        Self {
            base,
            range,
            replacement,
        }
    }

    /// Validate and materialize the candidate without mutating its source.
    /// This is strict validation, not [`super::project`] recovery.
    pub fn apply(&self) -> Result<Vec<Message>, RewriteError> {
        if self.range.start > self.range.end || self.range.end > self.base.len() {
            return Err(RewriteError::InvalidRange);
        }
        let safe = safe_boundaries(&self.base)?;
        if !safe[self.range.start] || !safe[self.range.end] {
            return Err(RewriteError::SplitToolGroup);
        }
        let mut next =
            Vec::with_capacity(self.base.len() - self.range.len() + self.replacement.len());
        next.extend_from_slice(&self.base[..self.range.start]);
        next.extend_from_slice(&self.replacement);
        next.extend_from_slice(&self.base[self.range.end..]);
        safe_boundaries(&next)?;
        Ok(next)
    }

    pub(crate) fn apply_to(
        &self,
        current: &Arc<Vec<Message>>,
    ) -> Result<Vec<Message>, RewriteError> {
        if !Arc::ptr_eq(&self.base, current) {
            return Err(RewriteError::StaleSnapshot);
        }
        self.apply()
    }
}

/// Safe cut positions of a complete, well-paired message history.
///
/// A multi-call assistant reply and all of its results form one indivisible
/// span, even when results arrive out of order or other messages intervene.
/// IDs may be reused after their previous occurrence completes. Orphans,
/// pending calls, duplicate active IDs and calls outside ToolUse are refused.
pub fn safe_boundaries(messages: &[Message]) -> Result<Vec<bool>, RewriteError> {
    let mut active = HashMap::new();
    let mut groups: HashMap<usize, (usize, usize)> = HashMap::new();
    for (at, message) in messages.iter().enumerate() {
        match message {
            Message::Assistant(reply) => {
                let mut count = 0;
                for part in &reply.content {
                    if let AssistantContent::ToolCall { id, name, .. } = part {
                        if reply.stop_reason != StopReason::ToolUse
                            || id.is_empty()
                            || active.insert(id.as_str(), (at, name.as_str())).is_some()
                        {
                            return Err(RewriteError::InvalidHistory);
                        }
                        count += 1;
                    }
                }
                if reply.stop_reason == StopReason::ToolUse {
                    if count == 0 {
                        return Err(RewriteError::InvalidHistory);
                    }
                    groups.insert(at, (count, at));
                }
            }
            Message::ToolResult {
                tool_call_id,
                tool_name,
                ..
            } => {
                let Some((from, name)) = active.remove(tool_call_id.as_str()) else {
                    return Err(RewriteError::InvalidHistory);
                };
                if name != tool_name {
                    return Err(RewriteError::InvalidHistory);
                }
                let (remaining, last) = groups.get_mut(&from).expect("issued group");
                *remaining -= 1;
                *last = at;
            }
            _ => {}
        }
    }
    if !active.is_empty() {
        return Err(RewriteError::InvalidHistory);
    }
    // Mark interval endpoints rather than filling each span: overlapping
    // batches must not turn this validation into quadratic work.
    let mut starts = vec![0usize; messages.len() + 1];
    let mut ends = vec![0usize; messages.len() + 1];
    for (from, (_, last)) in groups {
        starts[from + 1] += 1;
        ends[last + 1] += 1;
    }
    let mut open = 0;
    Ok(starts
        .into_iter()
        .zip(ends)
        .map(|(start, end)| {
            open += start;
            open -= end;
            open == 0
        })
        .collect())
}

/// Mechanical prefix replacement for a host-owned projection with metadata.
///
/// Unlike [`Rewrite`], this deliberately does not validate tool pairing: a
/// richer journal must select its own safe boundary and validate its evidence.
/// It preserves retained entries and IDs verbatim; it neither mutates storage
/// nor fabricates results. A host may still use [`super::project`] afterwards
/// for its existing provider-facing recovery.
pub fn replace_prefix<T>(
    source: impl ExactSizeIterator<Item = T>,
    retain_from: usize,
    prefix: impl IntoIterator<Item = T>,
) -> Result<impl Iterator<Item = T>, RewriteError> {
    if retain_from > source.len() {
        return Err(RewriteError::InvalidRange);
    }
    Ok(prefix.into_iter().chain(source.skip(retain_from)))
}
