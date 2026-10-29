//! Bounded TCP forwarding over the existing authenticated control connection.
use anyhow::{ensure, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::HashMap, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    sync::mpsc,
    task::JoinHandle,
};

type Output = (String, Value);
enum Write {
    Data(u64, Vec<u8>),
    End,
}
struct Forward {
    write: mpsc::Sender<Write>,
    ack: mpsc::Sender<u64>,
    task: JoinHandle<()>,
}
pub struct Forwards {
    active: HashMap<String, Forward>,
    output: mpsc::Sender<Output>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Open {
    forward_id: String,
    host: String,
    port: u16,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Data {
    forward_id: String,
    seq: u64,
    data: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Ack {
    forward_id: String,
    seq: u64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Id {
    forward_id: String,
}
impl Forwards {
    pub fn new(output: mpsc::Sender<Output>) -> Self {
        Self {
            active: HashMap::new(),
            output,
        }
    }
    pub fn is_idle(&self) -> bool {
        self.active.values().all(|f| f.task.is_finished())
    }
    pub fn receive(&mut self, kind: &str, body: Value) -> Result<()> {
        self.active.retain(|_, f| !f.task.is_finished());
        if kind == "tcp.open" {
            let open: Open = serde_json::from_value(body)?;
            uuid::Uuid::parse_str(&open.forward_id)?;
            ensure!(
                !self.active.contains_key(&open.forward_id),
                "duplicate forward"
            );
            ensure!(
                open.port > 0
                    && !open.host.is_empty()
                    && open.host.len() <= 253
                    && !open
                        .host
                        .chars()
                        .any(|c| c.is_whitespace() || c.is_control()),
                "invalid TCP destination"
            );
            if self.active.len() >= 32 {
                self.output.try_send((
                    "tcp.closed".into(),
                    json!({"forward_id":open.forward_id,"reason":"FORWARD_LIMIT"}),
                ))?;
                return Ok(());
            }
            let (write, input) = mpsc::channel(2);
            let (ack, acknowledgements) = mpsc::channel(1);
            let output = self.output.clone();
            let id = open.forward_id.clone();
            let task = tokio::spawn(async move {
                let result = tokio::time::timeout(
                    Duration::from_secs(3600),
                    run(&open, input, acknowledgements, &output),
                )
                .await;
                let reason = if matches!(result, Ok(Ok(()))) {
                    "EOF"
                } else {
                    "TCP_FORWARD_FAILED"
                };
                let _ = output
                    .send((
                        "tcp.closed".into(),
                        json!({"forward_id":open.forward_id,"reason":reason}),
                    ))
                    .await;
            });
            self.active.insert(id, Forward { write, ack, task });
            return Ok(());
        }
        match kind {
            "tcp.data" => {
                let data: Data = serde_json::from_value(body)?;
                ensure!(
                    data.seq > 0 && data.seq <= 9_007_199_254_740_991 && data.data.len() <= 10924,
                    "invalid TCP frame"
                );
                let bytes = STANDARD.decode(&data.data)?;
                ensure!(
                    !bytes.is_empty()
                        && bytes.len() <= 8192
                        && STANDARD.encode(&bytes) == data.data,
                    "invalid TCP data"
                );
                if let Some(f) = self.active.get(&data.forward_id) {
                    if f.write.try_send(Write::Data(data.seq, bytes)).is_err() {
                        self.stop(&data.forward_id);
                    }
                }
            }
            "tcp.ack" => {
                let ack: Ack = serde_json::from_value(body)?;
                if let Some(f) = self.active.get(&ack.forward_id) {
                    if f.ack.try_send(ack.seq).is_err() {
                        self.stop(&ack.forward_id);
                    }
                }
            }
            "tcp.end" => {
                let id: Id = serde_json::from_value(body)?;
                if let Some(f) = self.active.get(&id.forward_id) {
                    if f.write.try_send(Write::End).is_err() {
                        self.stop(&id.forward_id);
                    }
                }
            }
            "tcp.close" => {
                let id: Id = serde_json::from_value(body)?;
                self.stop(&id.forward_id);
            }
            _ => anyhow::bail!("unknown TCP frame"),
        }
        Ok(())
    }
    fn stop(&mut self, id: &str) {
        if let Some(f) = self.active.remove(id) {
            f.task.abort();
        }
    }
}
impl Drop for Forwards {
    fn drop(&mut self) {
        for (_, f) in self.active.drain() {
            f.task.abort();
        }
    }
}
async fn run(
    open: &Open,
    mut input: mpsc::Receiver<Write>,
    mut acks: mpsc::Receiver<u64>,
    output: &mpsc::Sender<Output>,
) -> Result<()> {
    let stream = tokio::time::timeout(
        Duration::from_secs(8),
        TcpStream::connect((open.host.as_str(), open.port)),
    )
    .await??;
    stream.set_nodelay(true)?;
    let (mut reader, mut writer) = stream.into_split();
    output
        .send(("tcp.opened".into(), json!({"forward_id":open.forward_id})))
        .await?;
    let write = async {
        let mut expected = 1;
        while let Some(message) = input.recv().await {
            match message {
                Write::Data(seq, bytes) => {
                    ensure!(seq == expected, "invalid write sequence");
                    writer.write_all(&bytes).await?;
                    output
                        .send((
                            "tcp.ack".into(),
                            json!({"forward_id":open.forward_id,"seq":seq}),
                        ))
                        .await?;
                    expected += 1;
                }
                Write::End => {
                    writer.shutdown().await?;
                    return Ok::<_, anyhow::Error>(());
                }
            }
        }
        anyhow::bail!("control disconnected")
    };
    let read = async {
        let mut seq = 0;
        let mut bytes = [0; 8192];
        loop {
            let count = reader.read(&mut bytes).await?;
            if count == 0 {
                output
                    .send(("tcp.end".into(), json!({"forward_id":open.forward_id})))
                    .await?;
                return Ok::<_, anyhow::Error>(());
            }
            seq += 1;
            output.send(("tcp.data".into(), json!({"forward_id":open.forward_id,"seq":seq,"data":STANDARD.encode(&bytes[..count])}))).await?;
            ensure!(
                acks.recv().await == Some(seq),
                "invalid read acknowledgement"
            );
        }
    };
    tokio::try_join!(read, write)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;
    #[tokio::test]
    async fn binary_forwarding_backpressure_half_close_and_cleanup() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let target = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut data = Vec::new();
            stream.read_to_end(&mut data).await.unwrap();
            assert_eq!(data, vec![0, 255, 42]);
            stream.write_all(&vec![17; 524288]).await.unwrap();
        });
        let (output, mut events) = mpsc::channel(8);
        let mut manager = Forwards::new(output);
        let id = uuid::Uuid::new_v4().to_string();
        manager
            .receive(
                "tcp.open",
                json!({"forward_id":id,"host":"127.0.0.1","port":port}),
            )
            .unwrap();
        assert_eq!(events.recv().await.unwrap().0, "tcp.opened");
        manager
            .receive(
                "tcp.data",
                json!({"forward_id":id,"seq":1,"data":STANDARD.encode([0,255,42])}),
            )
            .unwrap();
        assert_eq!(events.recv().await.unwrap().0, "tcp.ack");
        manager
            .receive("tcp.end", json!({"forward_id":id}))
            .unwrap();
        let mut received = 0;
        loop {
            let (kind, body) = tokio::time::timeout(Duration::from_secs(3), events.recv())
                .await
                .unwrap()
                .unwrap();
            if kind == "tcp.end" {
                break;
            }
            assert_eq!(kind, "tcp.data");
            let bytes = STANDARD.decode(body["data"].as_str().unwrap()).unwrap();
            assert!(bytes.iter().all(|b| *b == 17));
            received += bytes.len();
            // A slow reader receives no more data until it acknowledges this chunk.
            assert!(
                tokio::time::timeout(Duration::from_millis(20), events.recv())
                    .await
                    .is_err()
            );
            manager
                .receive("tcp.ack", json!({"forward_id":id,"seq":body["seq"]}))
                .unwrap();
        }
        assert_eq!(received, 524288);
        assert_eq!(events.recv().await.unwrap().1["reason"], "EOF");
        target.await.unwrap();
        manager
            .receive("tcp.close", json!({"forward_id":id}))
            .unwrap();
        assert!(manager.is_idle());
    }
    #[tokio::test]
    async fn disconnect_aborts_tcp_socket() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (output, mut events) = mpsc::channel(8);
        let mut manager = Forwards::new(output);
        manager.receive("tcp.open", json!({"forward_id":uuid::Uuid::new_v4().to_string(),"host":"127.0.0.1","port":listener.local_addr().unwrap().port()})).unwrap();
        let (mut stream, _) = listener.accept().await.unwrap();
        assert_eq!(events.recv().await.unwrap().0, "tcp.opened");
        drop(manager);
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(2), stream.read(&mut [0; 1]))
                .await
                .unwrap()
                .unwrap(),
            0
        );
    }
}
