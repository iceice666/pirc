//! Synthetic HTTP peer for private state transport integration tests.
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
pub fn serve(
    listener: tokio::net::UnixListener,
    writes: Arc<pirc_node::persistence::Writes>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            let writes = writes.clone();
            tokio::spawn(async move {
                let mut bytes = Vec::new();
                let mut buf = [0; 8192];
                let end = loop {
                    if let Some(i) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                        break i + 4;
                    }
                    let n = stream.read(&mut buf).await.unwrap();
                    assert!(n > 0);
                    bytes.extend_from_slice(&buf[..n]);
                };
                let head = String::from_utf8(bytes[..end].to_vec()).unwrap();
                let length: usize = head
                    .lines()
                    .find_map(|l| l.strip_prefix("Content-Length: "))
                    .unwrap()
                    .parse()
                    .unwrap();
                while bytes.len() < end + length {
                    let n = stream.read(&mut buf).await.unwrap();
                    assert!(n > 0);
                    bytes.extend_from_slice(&buf[..n]);
                }
                let token = head
                    .lines()
                    .find_map(|l| l.strip_prefix("Authorization: Bearer "))
                    .unwrap();
                let result = writes.apply_response(
                    token,
                    serde_json::from_slice(&bytes[end..end + length]).unwrap(),
                );
                let (status, body) = match result {
                    Ok(v) => ("200 OK", v),
                    Err(e) => (
                        "400 Bad Request",
                        serde_json::json!({"error":e.to_string()}),
                    ),
                };
                let body = serde_json::to_vec(&body).unwrap();
                stream
                    .write_all(
                        format!(
                            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len()
                        )
                        .as_bytes(),
                    )
                    .await
                    .unwrap();
                stream.write_all(&body).await.unwrap();
                stream.shutdown().await.unwrap();
            });
        }
    })
}
