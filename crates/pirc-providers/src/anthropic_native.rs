//! The native `anthropic-messages` transport (`agent/providers/anthropic.ts`), used for plain `anthropic-messages` providers.
//!
//! Not ported yet (M3 transports): answers as the unported route did.

use pirc_protocol::AssistantMessage;

use crate::completions::PiRun;
use crate::stream::{Cancelled, Emitter, StreamRequest};

pub struct NativeAnthropicRun {
    shell: PiRun,
}

impl NativeAnthropicRun {
    pub fn new(request: &StreamRequest<'_>) -> Self {
        Self {
            shell: PiRun::new(request),
        }
    }

    /// The result when the run is cancelled.
    pub fn aborted(&self) -> AssistantMessage {
        self.shell.aborted()
    }

    pub async fn run(
        &mut self,
        _client: &reqwest::Client,
        _request: &StreamRequest<'_>,
        _emit: &mut Emitter<'_>,
    ) -> Result<AssistantMessage, Cancelled> {
        Ok(self
            .shell
            .error_without_request("Model provider request failed."))
    }
}
