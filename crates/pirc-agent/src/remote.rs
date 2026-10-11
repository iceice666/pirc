//! The gateway's inference through the node's authenticated Unix socket
//! (`agent/providers/remote.ts`): `GET /models`, `POST /inference` (NDJSON
//! `model_delta`/`model_end`/`model_error`), with the wire limits of
//! `inference-wire.ts`.

use pirc_protocol::{InferenceConfig, Models};

use crate::LocalBoxFuture;
use crate::stream::{StreamFn, StreamRequest};

/// `fetchRemoteModels`: the current public catalog.
pub async fn fetch_remote_models(config: &InferenceConfig) -> Result<Models, String> {
    let _ = config;
    todo!("M4 rpc: fetchRemoteModels")
}

/// `createRemoteStream(config)`.
pub struct RemoteStream {
    pub config: InferenceConfig,
}

impl StreamFn for RemoteStream {
    fn stream<'a>(
        &'a self,
        request: StreamRequest,
        on_delta: &'a mut dyn FnMut(&pirc_protocol::AssistantDelta),
    ) -> LocalBoxFuture<'a, pirc_protocol::AssistantMessage> {
        let _ = (request, on_delta);
        todo!("M4 rpc: RemoteStream::stream")
    }
}
