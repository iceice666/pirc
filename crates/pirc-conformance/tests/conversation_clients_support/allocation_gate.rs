//! Transparent fixture-only Node link. Lose one successful allocation/upload
//! response after the real Node committed it, without fabricating any outcome.
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio::task::{JoinHandle, JoinSet};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
use tokio_tungstenite::{accept_hdr_async, connect_async};

pub struct AllocationGate {
    pub port: u16,
    pub frames: Arc<Mutex<Vec<Value>>>,
    held: mpsc::UnboundedReceiver<Value>,
    task: JoinHandle<()>,
}
impl AllocationGate {
    pub async fn start(gateway: u16, attachment: bool) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let frames = Arc::new(Mutex::new(Vec::new()));
        let log = frames.clone();
        let (send, held) = mpsc::unbounded_channel();
        let once = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let task = tokio::spawn(async move {
            let mut links = JoinSet::new();
            loop {
                tokio::select! {
                    next = listener.accept() => {
                        let (socket, _) = next.unwrap();
                        links.spawn(relay(socket, gateway, attachment, log.clone(), once.clone(), send.clone()));
                    }
                    done = links.join_next(), if !links.is_empty() => { done.unwrap().unwrap(); }
                }
            }
        });
        Self {
            port,
            frames,
            held,
            task,
        }
    }
    pub async fn held(&mut self) -> Value {
        tokio::time::timeout(Duration::from_secs(30), self.held.recv())
            .await
            .expect("Node never completed the selected storage operation")
            .expect("relay exited before receiving the response")
    }
    pub fn requests(&self) -> Vec<Value> {
        self.frames
            .lock()
            .unwrap()
            .iter()
            .filter(|v| v["direction"] == "gateway" && v["frame"]["type"] == "request")
            .map(|v| v["frame"]["data"].clone())
            .collect()
    }
}
impl Drop for AllocationGate {
    fn drop(&mut self) {
        self.task.abort();
    }
}

// The WebSocket callback's error is tungstenite's HTTP response.
#[allow(clippy::result_large_err)]
async fn relay(
    socket: TcpStream,
    gateway: u16,
    attachment: bool,
    frames: Arc<Mutex<Vec<Value>>>,
    once: Arc<std::sync::atomic::AtomicBool>,
    held: mpsc::UnboundedSender<Value>,
) {
    let mut upstream = format!("ws://127.0.0.1:{gateway}/node/connect")
        .into_client_request()
        .unwrap();
    let Ok(node) = accept_hdr_async(socket, |request: &Request, response: Response| {
        assert_eq!(request.uri().path(), "/node/connect");
        for name in ["authorization", "x-pirc-node-id"] {
            upstream
                .headers_mut()
                .insert(name, request.headers().get(name).unwrap().clone());
        }
        Ok(response)
    })
    .await
    else {
        return;
    };
    let Ok((server, _)) = connect_async(upstream).await else {
        return;
    };
    let (mut to_node, mut from_node) = node.split();
    let (mut to_gateway, mut from_gateway) = server.split();
    let mut pending = HashMap::<String, Value>::new();
    loop {
        tokio::select! {
            next = from_gateway.next() => {
                let Some(Ok(message)) = next else { return };
                if let Message::Text(text) = &message {
                    let frame: Value = serde_json::from_str(text).unwrap();
                    pirc_conformance::assert_gateway_frame(&frame);
                    if frame["type"] == "request" {
                        pending.insert(frame["requestId"].as_str().unwrap().to_owned(), frame["data"].clone());
                    }
                    frames.lock().unwrap().push(json!({"direction":"gateway","frame":frame}));
                }
                if to_node.send(message).await.is_err() { return }
            }
            next = from_node.next() => {
                let Some(Ok(message)) = next else { return };
                if let Message::Text(text) = &message {
                    let frame: Value = serde_json::from_str(text).unwrap();
                    pirc_conformance::assert_node_frame(&frame);
                    frames.lock().unwrap().push(json!({"direction":"node","frame":frame}));
                    if frame["type"] == "response"
                        && let Some(request) = pending.remove(frame["requestId"].as_str().unwrap())
                    {
                        let selected = if attachment {
                            request["method"] == "PUT" && request["url"].as_str().unwrap().starts_with("/api/session-creations/")
                                && request["url"].as_str().unwrap().contains("/attachments/")
                        } else { request["method"] == "POST" && request["url"] == "/api/session-creations" };
                        if selected && !once.swap(true, std::sync::atomic::Ordering::SeqCst) {
                            assert_eq!(frame["data"]["status"], 200, "{frame}");
                            held.send(json!({"request":request,"response":frame["data"]["body"]})).unwrap();
                            // Deliberately discard only this successful response. Heartbeats
                            // and all other frames continue until the test crashes the hosts.
                            continue;
                        }
                    }
                }
                if to_gateway.send(message).await.is_err() { return }
            }
        }
    }
}
