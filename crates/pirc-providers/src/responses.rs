//! pi-ai 0.73.1's `streamOpenAIResponses` (`openai-responses`, with `openai-responses-shared`) behind pi-adapter, with the `openai` SDK client it uses.
//!
//! Not ported yet (M3 transports): answers as the unported route did.

use pirc_protocol::AssistantMessage;

use crate::completions::PiRun;
use crate::stream::{Cancelled, Emitter, StreamRequest};

pub struct ResponsesRun {
    shell: PiRun,
}

impl ResponsesRun {
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
        _long_cache_retention: bool,
        _emit: &mut Emitter<'_>,
    ) -> Result<AssistantMessage, Cancelled> {
        Ok(self
            .shell
            .error_without_request("Model provider request failed."))
    }
}
