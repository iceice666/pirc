//! Optional main-agent file observations through the node. No blob bytes or
//! identity supplied by the agent; unsupported children remain uncovered.
use super::ToolContext;
use crate::channels::{NodeChannels, process_gateway};
use crate::ui::NotifyLevel;
use serde_json::json;
use std::rc::Rc;

pub(super) struct Capture {
    channel: Rc<NodeChannels>,
    operation: String,
}

impl Capture {
    pub async fn begin(
        ctx: &ToolContext,
        path: &str,
        tool: &str,
        expected: Option<&str>,
    ) -> Result<Option<Self>, String> {
        if std::env::var("PIRC_CHECKPOINT_CAPTURE").as_deref() != Ok("1") {
            return Ok(None);
        }
        let Some(channel) = process_gateway() else {
            return Ok(None);
        };
        Self::begin_on(channel, ctx, path, tool, expected).await
    }

    async fn begin_on(
        channel: Rc<NodeChannels>,
        ctx: &ToolContext,
        path: &str,
        tool: &str,
        expected: Option<&str>,
    ) -> Result<Option<Self>, String> {
        use sha2::{Digest, Sha256};
        let expected = expected.map(|text| format!("{:x}", Sha256::digest(text.as_bytes())));
        let request = channel.gateway.request(
            "checkpoint.begin",
            json!({"path":path,"tool":tool,"expected":expected})
                .as_object()
                .unwrap()
                .clone(),
            Some(&ctx.signal),
        );
        let result = request
            .await
            .map_err(|e| format!("No file write attempted: {}", e.message()))?;
        if result.get("excluded").and_then(|v| v.as_str()) == Some("outside_workspace") {
            ctx.ui.notify("This allowed file operation is outside the checkpoint workspace and will not be captured.",NotifyLevel::Warning);
            return Ok(None);
        }
        let operation = result
            .get("operation")
            .and_then(|v| v.as_str())
            .ok_or("No file write attempted: invalid checkpoint response")?
            .to_owned();
        Ok(Some(Self { channel, operation }))
    }

    pub async fn finish(capture: Option<Self>, ctx: &ToolContext, succeeded: bool) {
        let Some(capture) = capture else { return };
        // Report a postimage even if cancellation arrived after a partial write.
        // Failure here must not turn a completed write into a retryable error.
        let request = capture.channel.gateway.request(
            "checkpoint.finish",
            json!({"operation":capture.operation,"succeeded":succeeded})
                .as_object()
                .unwrap()
                .clone(),
            None,
        );
        if request.await.is_err() {
            ctx.ui.notify("The file operation finished, but its checkpoint is incomplete. Do not rely on it for recovery.",NotifyLevel::Warning);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::signal::AbortController;
    use crate::tools::testing;
    use sha2::{Digest, Sha256};
    use std::cell::RefCell;
    async fn poll_once<F: std::future::Future>(
        mut future: std::pin::Pin<&mut F>,
    ) -> std::task::Poll<F::Output> {
        std::future::poll_fn(|cx| std::task::Poll::Ready(future.as_mut().poll(cx))).await
    }

    #[tokio::test]
    async fn file_capture_handshake_uses_digest_and_reports_a_failed_postimage_without_retrying() {
        let dir = tempfile::tempdir().unwrap();
        let mut ctx = testing::context(
            testing::config(dir.path().to_str().unwrap(), json!({})),
            AbortController::new().signal(),
        )
        .ctx;
        let ui = Rc::new(testing::TestUi::default());
        ctx.ui = ui.clone();
        let lines = Rc::new(RefCell::new(Vec::new()));
        let sink = lines.clone();
        let channels = Rc::new(NodeChannels::new(Rc::new(move |line| {
            sink.borrow_mut().push(line)
        })));
        let mut begin = Box::pin(Capture::begin_on(
            channels.clone(),
            &ctx,
            "/workspace/main",
            "edit",
            Some("dirty preimage"),
        ));
        assert!(poll_once(begin.as_mut()).await.is_pending());
        let request = lines.borrow()[0].clone();
        assert_eq!(request["op"], "checkpoint.begin");
        assert_eq!(
            request["args"]["expected"],
            format!("{:x}", Sha256::digest(b"dirty preimage"))
        );
        assert!(!request.to_string().contains("dirty preimage"));
        assert!(request["args"].get("owner").is_none());
        channels
            .gateway
            .respond(&json!({"id":request["id"],"ok":true,"result":{"operation":"node-issued"}}));
        let capture = begin.await.unwrap().unwrap();
        let mut finish = Box::pin(Capture::finish(Some(capture), &ctx, true));
        assert!(poll_once(finish.as_mut()).await.is_pending());
        let request = lines.borrow()[1].clone();
        assert_eq!(request["args"]["operation"], "node-issued");
        assert!(request["args"].get("path").is_none());
        channels
            .gateway
            .respond(&json!({"id":request["id"],"ok":false,"error":{"message":"quota exhausted"}}));
        finish.await;
        assert_eq!(ui.notes.borrow().len(), 1);
        assert!(ui.notes.borrow()[0].contains("incomplete"));
        assert_eq!(
            lines.borrow().len(),
            2,
            "a completed write must not be retried"
        );
    }

    #[tokio::test]
    async fn stale_begin_and_cancelled_capture_do_not_allow_a_file_write() {
        let dir = tempfile::tempdir().unwrap();
        let controller = AbortController::new();
        let ctx = testing::context(
            testing::config(dir.path().to_str().unwrap(), json!({})),
            controller.signal(),
        )
        .ctx;
        let lines = Rc::new(RefCell::new(Vec::new()));
        let sink = lines.clone();
        let channels = Rc::new(NodeChannels::new(Rc::new(move |line| {
            sink.borrow_mut().push(line)
        })));
        let mut begin = Box::pin(Capture::begin_on(
            channels.clone(),
            &ctx,
            "/workspace/main",
            "edit",
            Some("old"),
        ));
        assert!(poll_once(begin.as_mut()).await.is_pending());
        let request = lines.borrow()[0].clone();
        channels.gateway.respond(
            &json!({"id":request["id"],"ok":false,"error":{"message":"stale edit preimage"}}),
        );
        assert!(
            begin
                .await
                .err()
                .unwrap()
                .contains("No file write attempted")
        );
        controller.abort();
        assert!(
            Capture::begin_on(channels, &ctx, "/workspace/main", "write", None)
                .await
                .is_err()
        );
        assert_eq!(lines.borrow().len(), 1);
    }

    #[tokio::test]
    async fn allowed_external_file_is_explicitly_uncovered_instead_of_blocked() {
        let dir = tempfile::tempdir().unwrap();
        let mut ctx = testing::context(
            testing::config(dir.path().to_str().unwrap(), json!({})),
            AbortController::new().signal(),
        )
        .ctx;
        let ui = Rc::new(testing::TestUi::default());
        ctx.ui = ui.clone();
        let lines = Rc::new(RefCell::new(Vec::new()));
        let sink = lines.clone();
        let channels = Rc::new(NodeChannels::new(Rc::new(move |line| {
            sink.borrow_mut().push(line)
        })));
        let mut begin = Box::pin(Capture::begin_on(
            channels.clone(),
            &ctx,
            "/allowed-external/main",
            "write",
            None,
        ));
        assert!(poll_once(begin.as_mut()).await.is_pending());
        let request = lines.borrow()[0].clone();
        channels.gateway.respond(&json!({"id":request["id"],"ok":true,"result":{"excluded":"outside_workspace","operation":null}}));
        let capture = begin.await.unwrap();
        assert!(capture.is_none());
        Capture::finish(capture, &ctx, true).await;
        assert_eq!(lines.borrow().len(), 1);
        assert!(ui.notes.borrow()[0].contains("will not be captured"));
    }
}
