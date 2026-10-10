//! The gateway's end of the node link, played by the test, so a real node's
//! frames can be recorded. Every frame either way must round-trip through
//! `pirc-protocol`: these are the frames the Rust types are checked against.

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
use tokio_tungstenite::{WebSocketStream, accept_hdr_async};

use crate::client::TIMEOUT;

/// Check a frame a gateway sent against `pirc_protocol::GatewayMessage`.
pub fn assert_gateway_frame(frame: &Value) {
    if let Err(error) = pirc_protocol::round_trip::<pirc_protocol::GatewayMessage>(frame) {
        panic!("gateway frame does not round-trip: {error}");
    }
}

/// Check a frame a node sent against `pirc_protocol::NodeMessage`.
pub fn assert_node_frame(frame: &Value) {
    if let Err(error) = pirc_protocol::round_trip::<pirc_protocol::NodeMessage>(frame) {
        panic!("node frame does not round-trip: {error}");
    }
}

pub struct FakeGateway {
    listener: TcpListener,
}

impl FakeGateway {
    pub async fn bind() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        Self { listener }
    }

    pub fn port(&self) -> u16 {
        self.listener.local_addr().unwrap().port()
    }

    /// Accept the next node connection, keeping its handshake headers.
    // The callback's error type is tungstenite's HTTP response.
    #[allow(clippy::result_large_err)]
    pub async fn accept(&self) -> NodeLink {
        let (stream, _) = tokio::time::timeout(TIMEOUT, self.listener.accept())
            .await
            .expect("timed out waiting for the node to connect")
            .expect("accept");
        let mut headers = Vec::new();
        let socket = accept_hdr_async(stream, |request: &Request, response: Response| {
            headers = request
                .headers()
                .iter()
                .map(|(name, value)| {
                    let value = value.to_str().unwrap_or_default().to_owned();
                    (name.as_str().to_owned(), value)
                })
                .collect();
            Ok(response)
        })
        .await
        .expect("WebSocket handshake");
        NodeLink {
            socket,
            headers,
            skipped: Vec::new(),
        }
    }
}

/// One node's connection.
pub struct NodeLink {
    socket: WebSocketStream<TcpStream>,
    /// The node's handshake headers (lowercase names).
    pub headers: Vec<(String, String)>,
    /// Frames `recv_where` passed over, in arrival order.
    pub skipped: Vec<Value>,
}

impl NodeLink {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(header, _)| header == name)
            .map(|(_, value)| value.as_str())
    }

    /// The next frame from the node.
    pub async fn recv(&mut self) -> Value {
        loop {
            let message = tokio::time::timeout(TIMEOUT, self.socket.next())
                .await
                .expect("timed out waiting for a node frame")
                .expect("node closed the link")
                .expect("node link error");
            if let Message::Text(text) = message {
                let frame: Value = serde_json::from_str(&text).expect("JSON frame");
                assert_node_frame(&frame);
                return frame;
            }
        }
    }

    /// The next frame satisfying `wanted`; earlier ones go to `skipped`.
    pub async fn recv_where(&mut self, wanted: impl Fn(&Value) -> bool) -> Value {
        loop {
            let frame = self.recv().await;
            if wanted(&frame) {
                return frame;
            }
            self.skipped.push(frame);
        }
    }

    pub async fn send(&mut self, frame: &Value) {
        assert_gateway_frame(frame);
        self.socket
            .send(Message::text(frame.to_string()))
            .await
            .expect("send to node");
    }

    /// Send `request` frame `id` and wait for the node's response to it.
    pub async fn request(&mut self, id: &str, data: Value) -> Value {
        self.send(&serde_json::json!({ "type": "request", "requestId": id, "data": data }))
            .await;
        self.recv_where(|frame| frame["type"] == "response" && frame["requestId"] == id)
            .await
    }

    /// Give the node a moment, collecting whatever it sends meanwhile.
    pub async fn drain(&mut self, quiet: Duration) {
        while let Ok(Some(Ok(message))) = tokio::time::timeout(quiet, self.socket.next()).await {
            if let Message::Text(text) = message {
                let frame: Value = serde_json::from_str(&text).expect("JSON frame");
                assert_node_frame(&frame);
                self.skipped.push(frame);
            }
        }
    }
}
