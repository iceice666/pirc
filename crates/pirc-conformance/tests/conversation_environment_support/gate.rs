//! Hold one genuine command between Gateway admission and Node execution.
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Notify, mpsc};
use tokio::task::{JoinHandle, JoinSet};
use tokio_tungstenite::{
    accept_hdr_async, connect_async,
    tungstenite::{
        Message,
        client::IntoClientRequest,
        handshake::server::{Request, Response},
    },
};

pub struct Gate {
    pub port: u16,
    held: mpsc::UnboundedReceiver<()>,
    release: Arc<Notify>,
    task: JoinHandle<()>,
}
impl Gate {
    pub async fn start(gateway: u16) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (held_tx, held) = mpsc::unbounded_channel();
        let release = Arc::new(Notify::new());
        let resume = release.clone();
        let task = tokio::spawn(async move {
            let once = Arc::new(AtomicBool::new(false));
            let mut links = JoinSet::new();
            loop {
                tokio::select! {
                    next=listener.accept()=> {let (socket,_)=next.unwrap();links.spawn(relay(socket,gateway,once.clone(),held_tx.clone(),resume.clone()));},
                    done=links.join_next(),if !links.is_empty()=> {done.unwrap().unwrap();}
                }
            }
        });
        Self {
            port,
            held,
            release,
            task,
        }
    }
    pub async fn held(&mut self) {
        tokio::time::timeout(std::time::Duration::from_secs(20), self.held.recv())
            .await
            .expect("command not forwarded")
            .expect("gate stopped");
    }
    pub fn release(&self) {
        self.release.notify_one();
    }
}
impl Drop for Gate {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[allow(clippy::result_large_err)]
async fn relay(
    socket: TcpStream,
    gateway: u16,
    once: Arc<AtomicBool>,
    held: mpsc::UnboundedSender<()>,
    release: Arc<Notify>,
) {
    let mut upstream = format!("ws://127.0.0.1:{gateway}/node/connect")
        .into_client_request()
        .unwrap();
    let Ok(node) = accept_hdr_async(socket, |request: &Request, response: Response| {
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
    loop {
        tokio::select! {
            next=from_gateway.next()=> {
                let Some(Ok(message))=next else {return};
                if let Message::Text(text)=&message {
                    let frame:Value=serde_json::from_str(text).unwrap();pirc_conformance::assert_gateway_frame(&frame);
                    if frame["type"]=="request" && frame["data"]["payload"]["commandEnvironment"].is_object()
                        && !once.swap(true,Ordering::SeqCst) {
                        held.send(()).unwrap();release.notified().await;
                    }
                }
                if to_node.send(message).await.is_err() {return}
            },
            next=from_node.next()=> {
                let Some(Ok(message))=next else {return};
                if let Message::Text(text)=&message {
                    let frame:Value=serde_json::from_str(text).unwrap();pirc_conformance::assert_node_frame(&frame);
                }
                if to_gateway.send(message).await.is_err() {return}
            }
        }
    }
}
