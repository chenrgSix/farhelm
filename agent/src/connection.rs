use crate::{
    config::Config,
    executor::{seal, Artifact},
    identity::{response_json, Access, Identity},
    journal::Journal,
    now_ms,
    protocol::{envelope, Envelope, Event, Task, MAX_FRAME},
};
use anyhow::{ensure, Context, Result};
use futures_util::{SinkExt, StreamExt};
use rand::Rng;
use serde::Deserialize;
use serde_json::json;
use std::{path::PathBuf, sync::Arc, time::Duration};
use tokio_tungstenite::{
    connect_async_tls_with_config,
    tungstenite::{
        client::IntoClientRequest,
        protocol::{Message, WebSocketConfig},
    },
    Connector,
};

pub async fn run(cfg: Config, journal: Journal, identity: Identity) -> Result<()> {
    let identity = Arc::new(identity);
    let http = cfg.http_client()?;
    let tls = cfg.tls_config()?;
    let mut failures = 0u32;
    loop {
        let result = async {
            let access = identity.authenticate(&http, &cfg, &journal).await?;
            session(
                &cfg,
                &journal,
                &http,
                &access,
                tls.clone(),
                identity.clone(),
            )
            .await
        }
        .await;
        if let Err(error) = result {
            eprintln!("control connection unavailable: {error:#}");
            failures = (failures + 1).min(6);
        } else {
            failures = 0;
        }
        let base = 250u64.saturating_mul(1u64 << failures).min(15_000);
        let jitter = rand::thread_rng().gen_range(0..=base / 2);
        tokio::time::sleep(Duration::from_millis(base + jitter)).await;
    }
}
async fn session(
    cfg: &Config,
    journal: &Journal,
    http: &reqwest::Client,
    access: &Access,
    tls: Arc<rustls::ClientConfig>,
    identity: Arc<Identity>,
) -> Result<()> {
    let mut access = access.clone();
    let mut url = cfg.url("/agent/ws")?;
    url.set_scheme("wss")
        .map_err(|_| anyhow::anyhow!("invalid WSS URL"))?;
    let mut request = url.as_str().into_client_request()?;
    request
        .headers_mut()
        .insert("Authorization", format!("Bearer {}", access.token).parse()?);
    let mut ws_config = WebSocketConfig::default();
    ws_config.max_message_size = Some(MAX_FRAME);
    ws_config.max_frame_size = Some(MAX_FRAME);
    ws_config.max_write_buffer_size = 128 * 1024;
    ws_config.write_buffer_size = 0;
    let (mut socket, _) = tokio::time::timeout(
        Duration::from_secs(15),
        connect_async_tls_with_config(
            request,
            Some(ws_config),
            false,
            Some(Connector::Rustls(tls)),
        ),
    )
    .await??;
    socket
        .send(Message::Text(
            envelope(
                "agent.hello",
                json!({"agent_version":env!("CARGO_PKG_VERSION"),"capabilities":["terminal.pty.v1"]}),
            )?
            .into(),
        ))
        .await?;
    eprintln!("control connected; device {}", access.device_id);
    let mut heartbeat = tokio::time::interval(Duration::from_millis(cfg.heartbeat_ms));
    let mut outbox = tokio::time::interval(Duration::from_millis(250));
    // Artifact transfer must not block incoming cancellations or heartbeats.
    // JoinSet aborts pending uploads when this authenticated session closes.
    let mut uploads = tokio::task::JoinSet::<Result<Event>>::new();
    let (terminal_output, mut terminal_events) = tokio::sync::mpsc::channel(128);
    let mut terminals = crate::terminal::Terminals::new(cfg.clone(), terminal_output);
    let mut renewal = tokio::task::JoinSet::<Result<Access>>::new();
    // Refresh before expiration. Very short-lived test tokens renew at half-life.
    let remaining = (access.expires_at - now_ms()).max(1) as u64;
    let renew_after = remaining.saturating_sub((remaining / 2).min(30_000));
    let renew = tokio::time::sleep(Duration::from_millis(renew_after));
    tokio::pin!(renew);
    loop {
        tokio::select! {
            _=&mut renew, if renewal.is_empty()=>{
                let identity=identity.clone();let http=http.clone();let cfg=cfg.clone();let journal=journal.clone();
                renewal.spawn(async move { identity.authenticate(&http,&cfg,&journal).await });
            }
            Some(result)=renewal.join_next(), if !renewal.is_empty()=>{
                let renewed=result??;
                ensure!(renewed.device_id==access.device_id,"renewal changed device identity");
                socket.send(Message::Text(envelope("agent.reauth",json!({"access_token":renewed.token}))?.into())).await?;
                let remaining=(renewed.expires_at-now_ms()).max(1) as u64;
                renew.as_mut().reset(tokio::time::Instant::now()+Duration::from_millis(remaining.saturating_sub((remaining/2).min(30_000))));
                access=renewed;
            }
            Some((kind,body))=terminal_events.recv()=>{socket.send(Message::Text(envelope(&kind,body)?.into())).await?;}
            _=heartbeat.tick()=>{socket.send(Message::Text(envelope("agent.heartbeat",json!({"agent_version":env!("CARGO_PKG_VERSION")}))?.into())).await?;}
            _=outbox.tick(), if uploads.is_empty()=>{
                if let Some(event)=journal.first_outbox()?{
                    let cfg=cfg.clone();let journal=journal.clone();let http=http.clone();let access=access.clone();
                    uploads.spawn(async move {
                        if event.kind=="finished"{upload_artifacts(&cfg,&journal,&http,&access,&event).await?;}
                        Ok(event)
                    });
                }
            }
            Some(prepared)=uploads.join_next(), if !uploads.is_empty()=>{
                let event=prepared??;
                socket.send(Message::Text(envelope("task.event",&event)?.into())).await?;
            }
            incoming=socket.next()=>{
                let message=incoming.context("server closed control connection")??;
                match message{
                    Message::Text(text)=>{
                        let envelope=Envelope::parse(text.as_bytes())?;
                        match envelope.r#type.as_str(){
                            "task.assign"=>{let task:Task=serde_json::from_value(envelope.body)?;task.validate(&access.device_id)?;let fresh=journal.accept(&task)?;if fresh{cfg.fault("after_accept")?;}}
                            "task.cancel"=>{#[derive(Deserialize)]#[serde(deny_unknown_fields)]struct Cancel{task_id:String}let body:Cancel=serde_json::from_value(envelope.body)?;journal.cancel(&body.task_id)?;}
                            "event.ack"=>{#[derive(Deserialize)]#[serde(deny_unknown_fields)]struct Ack{event_id:String,task_id:String,seq:i64}let ack:Ack=serde_json::from_value(envelope.body)?;journal.ack(&ack.event_id,&ack.task_id,ack.seq)?;}
                            kind if kind.starts_with("terminal.")=>{terminals.receive(kind,envelope.body).await?;}
                            "error"=>{eprintln!("server rejected a control message; retaining outbox for replay");}
                            _=>anyhow::bail!("unknown control message type"),
                        }
                    }
                    Message::Ping(bytes)=>socket.send(Message::Pong(bytes)).await?,
                    Message::Pong(_)=>(),
                    Message::Close(_)=>return Ok(()),
                    _=>anyhow::bail!("unexpected non-text control message"),
                }
            }
        }
    }
}
async fn upload_artifacts(
    cfg: &Config,
    journal: &Journal,
    http: &reqwest::Client,
    access: &Access,
    event: &Event,
) -> Result<()> {
    let (out, err) = journal.artifacts(&event.task_id)?;
    for (stream, path) in [("stdout", out), ("stderr", err)] {
        let Some(reference) = event.payload.get(stream) else {
            continue;
        };
        if reference.is_null() || reference.as_object().map(|x| x.is_empty()).unwrap_or(false) {
            continue;
        }
        let expected: Artifact = serde_json::from_value(reference.clone())?;
        let path =
            PathBuf::from(path.context("finished event references missing local artifact path")?);
        ensure!(
            path.parent() == Some(cfg.state.join("artifacts").as_path()),
            "artifact path outside spool"
        );
        let actual = seal(&path)?;
        ensure!(
            actual.sha256 == expected.sha256 && actual.size == expected.size,
            "local artifact changed after result commit; refusing audit corruption"
        );
        // Each stream <=1MiB, combined cap enforced during capture. Never read unbounded.
        let bytes = std::fs::read(&path)?;
        ensure!(
            bytes.len() as u64 == expected.size,
            "artifact changed during upload"
        );
        let response = http
            .put(cfg.url(&format!(
                "/api/agent/tasks/{}/artifacts/{}",
                event.task_id, expected.sha256
            ))?)
            .bearer_auth(&access.token)
            .header("content-type", "application/octet-stream")
            .body(bytes)
            .send()
            .await?;
        ensure!(
            response.status().is_success(),
            "artifact upload rejected ({})",
            response.status()
        );
        let value: serde_json::Value = response_json(response).await?;
        ensure!(
            value.get("v").and_then(|x| x.as_u64()) == Some(1)
                && value.get("sha256").and_then(|x| x.as_str()) == Some(expected.sha256.as_str())
                && value.get("size").and_then(|x| x.as_u64()) == Some(expected.size),
            "artifact receipt mismatch"
        );
    }
    Ok(())
}
