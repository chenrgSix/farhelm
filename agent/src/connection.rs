use crate::{
    address::{Receipt as AddressReceipt, State as AddressState, Update as AddressUpdate},
    config::Config,
    executor::{seal, Artifact},
    identity::{response_json, Access, Identity},
    journal::Journal,
    network::{self, Monitor},
    now_ms,
    protocol::{envelope, Envelope, Event, Task, MAX_FRAME},
    upgrade::{self, Spec as UpgradeSpec, State as UpgradeState},
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

enum SessionEnd {
    AddressChange,
    ConnectionLost,
    Upgrade,
}
pub async fn run(
    cfg: Config,
    journal: Journal,
    identity: Identity,
    probes: crate::network_probes::Probes,
) -> Result<i32> {
    let identity = Arc::new(identity);

    let mut failures = 0u32;
    let running_hash = upgrade::current_hash()?;
    let mut network = Monitor::start(journal.clone())?;
    loop {
        let route = crate::routes::Settings::load(&journal)?;
        let base = AddressState::load(&cfg, &journal)?.candidate(&cfg)?;
        let (contact, mut observed) = tokio::sync::watch::channel(None);
        let attempt = async {
            let mut chosen = None;
            for (candidate, channel) in route.candidates(&base)? {
                if channel == "configured"
                    || probe_candidate(&candidate, &journal, identity.clone())
                        .await
                        .is_ok()
                {
                    chosen = Some((candidate, channel));
                    break;
                }
            }
            let (selected, channel) = chosen
                .ok_or_else(|| anyhow::anyhow!("no permitted platform route is reachable"))?;
            let http = selected.http_client()?;
            let tls = selected.tls_config()?;
            let access = identity.authenticate(&http, &selected, &journal).await?;
            session(Session {
                cfg: &selected,
                journal: &journal,
                http: &http,
                access: &access,
                tls: tls.clone(),
                identity: identity.clone(),
                running_hash: &running_hash,
                network: &mut network,
                contact,
                probes: &probes,
                route: &route,
                channel,
            })
            .await
        };
        let result = tokio::select! {
            result = attempt => result,
            _ = watch_connection(&mut observed) => Err(anyhow::anyhow!("platform heartbeat timeout")),
        };
        if matches!(result, Ok(SessionEnd::Upgrade)) {
            return Ok(upgrade::RESTART_EXIT);
        }
        if matches!(result, Err(_) | Ok(SessionEnd::ConnectionLost)) {
            let changed = network.failed(
                if observed.borrow().is_some() {
                    "connection_lost"
                } else {
                    "connection_failed"
                },
                now_ms(),
            )?;
            if changed {
                probes.wake();
            }
        }
        if let Err(error) = result {
            AddressState::load(&cfg, &journal)?.rollback(&journal)?;
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
async fn watch_connection(rx: &mut tokio::sync::watch::Receiver<Option<tokio::time::Instant>>) {
    loop {
        let last = *rx.borrow_and_update();
        if let Some(last) = last {
            match tokio::time::timeout_at(last + Duration::from_secs(20), rx.changed()).await {
                Err(_) => return,
                Ok(Err(_)) => std::future::pending::<()>().await,
                Ok(Ok(_)) => (),
            }
        } else if rx.changed().await.is_err() {
            std::future::pending::<()>().await;
        }
    }
}

type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;
async fn connect(
    cfg: &Config,
    access: &Access,
    tls: Arc<rustls::ClientConfig>,
    path: &str,
) -> Result<Socket> {
    let mut url = cfg.url(path)?;
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
    let (socket, _) = tokio::time::timeout(Duration::from_secs(15), async {
        if let Some(ip) = cfg.connect_ip {
            let stream = tokio::net::TcpStream::connect((
                ip,
                cfg.server.port_or_known_default().unwrap_or(443),
            ))
            .await?;
            tokio_tungstenite::client_async_tls_with_config(
                request,
                stream,
                Some(ws_config),
                Some(Connector::Rustls(tls)),
            )
            .await
        } else {
            connect_async_tls_with_config(
                request,
                Some(ws_config),
                false,
                Some(Connector::Rustls(tls)),
            )
            .await
        }
    })
    .await??;
    Ok(socket)
}
async fn ready(socket: &mut Socket, journal: &Journal) -> Result<()> {
    let msg = tokio::time::timeout(Duration::from_secs(15), socket.next())
        .await?
        .context("missing address handshake")??;
    let Message::Text(text) = msg else {
        anyhow::bail!("invalid address handshake")
    };
    let frame = Envelope::parse(text.as_bytes())?;
    ensure!(
        frame.r#type == "agent.address.ready"
            && frame.body.get("server_instance").and_then(|v| v.as_str())
                == journal.metadata("server_instance")?.as_deref(),
        "platform identity mismatch"
    );
    Ok(())
}
async fn probe_candidate(cfg: &Config, journal: &Journal, identity: Arc<Identity>) -> Result<()> {
    tokio::time::timeout(Duration::from_secs(5), async {
        let http = cfg.http_client()?;
        let access = identity.authenticate(&http, cfg, journal).await?;
        let mut socket = connect(cfg, &access, cfg.tls_config()?, "/agent/address-probe").await?;
        ready(&mut socket, journal).await?;
        let _ = socket.close(None).await;
        Ok::<_, anyhow::Error>(())
    })
    .await?
}
async fn probe(
    cfg: Config,
    journal: Journal,
    identity: Arc<Identity>,
    update: &AddressUpdate,
) -> Result<()> {
    let mut next = cfg;
    next.server = update.validate()?;
    let http = next.http_client()?;
    // Authentication checks the existing server_instance and device identity before signing.
    let access = identity.authenticate(&http, &next, &journal).await?;
    let mut socket = connect(&next, &access, next.tls_config()?, "/agent/address-probe").await?;
    ready(&mut socket, &journal).await?;
    let _ = socket.close(None).await;
    Ok(())
}
struct Session<'a> {
    cfg: &'a Config,
    journal: &'a Journal,
    http: &'a reqwest::Client,
    access: &'a Access,
    tls: Arc<rustls::ClientConfig>,
    identity: Arc<Identity>,
    running_hash: &'a str,
    network: &'a mut Monitor,
    contact: tokio::sync::watch::Sender<Option<tokio::time::Instant>>,
    probes: &'a crate::network_probes::Probes,
    route: &'a crate::routes::Settings,
    channel: &'a str,
}
async fn session(context: Session<'_>) -> Result<SessionEnd> {
    let Session {
        cfg,
        journal,
        http,
        access,
        tls,
        identity,
        running_hash,
        network,
        contact,
        probes,
        route,
        channel,
    } = context;
    let mut access = access.clone();
    let mut http = http.clone();
    let mut trust_receipt: Option<crate::trust::Receipt> = None;
    let mut socket = connect(cfg, &access, tls, "/agent/ws").await?;
    socket
        .send(Message::Text(
            envelope(
                "agent.hello",
                json!({"agent_version":env!("CARGO_PKG_VERSION"),"capabilities":if upgrade::supervised(){vec!["agent.route.v1","agent.trust.v1","agent.network.probes.v1","agent.network.v1","terminal.pty.v1","health.probes.v1","agent.address.v1","agent.upgrade.v1"]}else{vec!["agent.route.v1","agent.trust.v1","agent.network.probes.v1","agent.network.v1","terminal.pty.v1","health.probes.v1","agent.address.v1"]},"server_url":cfg.server.origin().ascii_serialization(),"runtime":{"arch":std::env::consts::ARCH,"sha256":running_hash},"trusted_ca_fingerprints":crate::trust::fingerprints(cfg)?}),
            )?
            .into(),
        ))
        .await?;
    ready(&mut socket, journal).await?;
    network.connected(now_ms())?;
    probes.wake();
    contact.send_replace(Some(tokio::time::Instant::now()));
    if let Some(state) = upgrade::connected(journal, running_hash)? {
        socket
            .send(Message::Text(
                envelope("agent.upgrade.result", state.receipt())?.into(),
            ))
            .await?;
    }
    let mut downloads = tokio::task::JoinSet::<(UpgradeSpec, Result<()>)>::new();
    let mut address = AddressState::load(cfg, journal)?;
    if route.policy.is_none() {
        address.confirmed(cfg, journal)?;
    }
    if let Some(receipt) = &address.receipt {
        socket
            .send(Message::Text(
                envelope("agent.address.result", receipt)?.into(),
            ))
            .await?;
    }
    let mut address_probes = tokio::task::JoinSet::<(AddressUpdate, Result<()>)>::new();
    eprintln!("control connected; device {}", access.device_id);
    let mut heartbeat = tokio::time::interval(Duration::from_millis(cfg.heartbeat_ms));
    let mut ping = tokio::time::interval(Duration::from_secs(5));
    let mut pending_ping: Option<Vec<u8>> = None;
    let mut inventory = tokio::time::interval(Duration::from_secs(30));
    let mut route_pending = false;
    let mut vpn_successes = 0u8;
    let mut route_checks = tokio::task::JoinSet::<(serde_json::Value, bool)>::new();
    let mut route_status = json!({"revision":route.revision,"channel":channel,"endpoint":cfg.server.origin().ascii_serialization(),"reason":if channel=="public"{Some("VPN_UNREACHABLE")}else{None},"easytier":{"state":"unknown","latency_ms":null}});
    socket
        .send(Message::Text(
            envelope("agent.route.status", &route_status)?.into(),
        ))
        .await?;
    let mut reported_probe = 0;
    let mut network_events = tokio::time::interval(Duration::from_secs(1));
    let mut outbox = tokio::time::interval(Duration::from_millis(250));
    // Artifact transfer must not block incoming cancellations or heartbeats.
    // JoinSet aborts pending uploads when this authenticated session closes.
    let mut uploads = tokio::task::JoinSet::<Result<Event>>::new();
    let (terminal_output, mut terminal_events) = tokio::sync::mpsc::channel(128);
    let mut terminals = crate::terminal::Terminals::new(cfg.clone(), terminal_output);
    let (health_output, mut health_events) = tokio::sync::mpsc::channel(32);
    let mut health = crate::health::Checks::new(health_output)?;
    let mut renewal = tokio::task::JoinSet::<Result<Access>>::new();
    // Refresh before expiration. Very short-lived test tokens renew at half-life.
    let remaining = (access.expires_at - now_ms()).max(1) as u64;
    let renew_after = remaining.saturating_sub((remaining / 2).min(30_000));
    let renew = tokio::time::sleep(Duration::from_millis(renew_after));
    tokio::pin!(renew);
    loop {
        tokio::select! {
            _=ping.tick(), if pending_ping.is_none()=>{
                let bytes=uuid::Uuid::new_v4().as_bytes().to_vec();
                pending_ping=Some(bytes.clone());
                socket.send(Message::Ping(bytes.into())).await?;
            }
            Some(checked)=route_checks.join_next(), if !route_checks.is_empty()=>{
                let (easytier,vpn_ok)=checked?;
                route_status["easytier"]=easytier;
                if channel=="public" {
                    vpn_successes=if vpn_ok{vpn_successes.saturating_add(1)}else{0};
                    if vpn_successes>=3 {route_pending=true;route_status["reason"]=json!("VPN_RECOVERY_WAITING_IDLE");}
                }
                socket.send(Message::Text(envelope("agent.route.status",&route_status)?.into())).await?;
            }
            _=inventory.tick()=>{
                if route_checks.is_empty() {
                    let cfg=cfg.clone();let journal=journal.clone();let identity=identity.clone();let route=route.clone();let on_public=channel=="public";
                    route_checks.spawn(async move {
                        let target=cfg.connect_ip.map(|ip|ip.to_string()).unwrap_or_else(||cfg.server.host_str().unwrap_or("").trim_matches(['[',']']).to_owned());
                        let et=crate::routes::easytier(&target).await;
                        let ok=if on_public {
                            if let Ok(candidates)=route.candidates(&cfg) {probe_candidate(&candidates[0].0,&journal,identity).await.is_ok()}else{false}
                        }else{false};(et,ok)
                    });
                }
                match network::addresses() {
                    Ok(addresses)=>{
                        let truncated=addresses.len()>128;
                        let addresses:Vec<_>=addresses.into_iter().take(128).collect();
                        socket.send(Message::Text(envelope("agent.network",json!({"observed_at":now_ms(),"addresses":addresses,"truncated":truncated}))?.into())).await?;
                    }
                    Err(error)=>eprintln!("local interface collection failed: {error}"),
                }
            }
            _=network_events.tick()=>{
                if let Some(report)=journal.network_probe_latest()? {
                    if report.seq!=reported_probe {
                        socket.send(Message::Text(envelope("agent.network.probe.latest",json!({"age_ms":(now_ms()-report.observed_at).max(0),"report":&report}))?.into())).await?;
                        reported_probe=report.seq;
                    }
                }
                if let Some(report)=journal.network_probe_first()? {
                    socket.send(Message::Text(envelope("agent.network.probe.event",report)?.into())).await?;
                }
                if let Some(event)=journal.network_first()? {
                    socket.send(Message::Text(envelope("agent.network.event",event)?.into())).await?;
                }
            }
            Some(downloaded)=downloads.join_next(), if !downloads.is_empty()=>{
                let (spec,result)=downloaded?;
                let state=UpgradeState{spec,status:if result.is_ok(){"WAITING_IDLE"}else{"FAILED"}.into(),reason:if result.is_ok(){None}else{Some("DOWNLOAD_FAILED".into())}};
                state.save(journal)?;
                socket.send(Message::Text(envelope("agent.upgrade.result",state.receipt())?.into())).await?;
            }
            Some(probed)=address_probes.join_next(), if !address_probes.is_empty()=>{
                let (update,result)=probed?;
                let previous=address.clone();
                if result.is_ok() {
                    address.pending=Some(update.clone());
                    address.receipt=Some(AddressReceipt::new(&update,"saved",None));
                    if update.validate()?==cfg.server {
                        address.active_url=cfg.server.origin().ascii_serialization();
                        address.pending=None;
                        address.receipt=Some(AddressReceipt::new(&update,"applied",None));
                    }
                } else {
                    address.pending=None;
                    address.receipt=Some(AddressReceipt::new(&update,"failed",Some("PROBE_FAILED")));
                }
                if address.save(journal).is_err() {
                    address=previous;
                    let receipt=AddressReceipt::new(&update,"failed",Some("PERSIST_FAILED"));
                    socket.send(Message::Text(envelope("agent.address.result",receipt)?.into())).await?;
                } else if let Some(receipt)=&address.receipt {
                    socket.send(Message::Text(envelope("agent.address.result",receipt)?.into())).await?;
                }
            }
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
            Some(body)=health_events.recv()=>{socket.send(Message::Text(envelope("health.result",body)?.into())).await?;}
            _=heartbeat.tick()=>{socket.send(Message::Text(envelope("agent.heartbeat",json!({"agent_version":env!("CARGO_PKG_VERSION")}))?.into())).await?;}
            _=outbox.tick(), if uploads.is_empty()=>{
                if trust_receipt.is_some() {
                    // Wait for HTTP work using the previous client to finish before
                    // authorizing a cutover; PTYs continue to run throughout.
                    if downloads.is_empty() && renewal.is_empty() && address_probes.is_empty() {
                        socket.send(Message::Text(envelope("agent.trust.result",trust_receipt.take().unwrap())?.into())).await?;
                    } else { continue; }
                }
                if upgrade::supervised() && downloads.is_empty() && terminals.is_idle() && terminal_events.is_empty() && journal.upgrade_idle()? {
                    if let Some(mut state)=UpgradeState::load(journal)? {
                        if state.status=="WAITING_IDLE" {
                            state.status="RESTARTING".into();state.save(journal)?;
                            let _=socket.send(Message::Text(envelope("agent.upgrade.result",state.receipt())?.into())).await;
                            network.planned()?;
                            let _=socket.close(None).await;return Ok(SessionEnd::Upgrade);
                        }
                    }
                }
                if route_pending && downloads.is_empty() && renewal.is_empty() && terminals.is_idle() && terminal_events.is_empty() && journal.upgrade_idle()? {
                    network.planned()?;let _=socket.close(None).await;return Ok(SessionEnd::AddressChange);
                }
                if route.policy.is_none() && address.pending.is_some() && address_probes.is_empty() && terminals.is_idle() && terminal_events.is_empty() {
                    network.planned()?;
                    let _=socket.close(None).await;
                    return Ok(SessionEnd::AddressChange);
                }
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
                            "agent.route.config"=>{
                                let next:crate::routes::Settings=serde_json::from_value(envelope.body)?;
                                let saved=crate::routes::Settings::load(journal)?;
                                if next.revision>saved.revision {next.save(journal)?;route_pending=true;}
                                else if next==*route {socket.send(Message::Text(crate::protocol::envelope("agent.route.status",&route_status)?.into())).await?;}
                            }
                            "agent.network.probe.config"=>{
                                socket.send(Message::Text(probes.configure_message(envelope.body)?.into())).await?;
                            }
                            "agent.network.probe.ack"=>{
                                #[derive(Deserialize)]#[serde(deny_unknown_fields)]struct Ack{sample_id:String,seq:u64}
                                let ack:Ack=serde_json::from_value(envelope.body)?;journal.network_probe_ack(&ack.sample_id,ack.seq)?;
                            }
                            "agent.network.ack"=>{
                                #[derive(Deserialize)]#[serde(deny_unknown_fields)]struct Ack{event_id:String}
                                let ack:Ack=serde_json::from_value(envelope.body)?;journal.network_ack(&ack.event_id)?;
                            }
                            "agent.upgrade"=>{
                                ensure!(upgrade::supervised(),"upgrade requires supervisor");
                                let spec:UpgradeSpec=serde_json::from_value(envelope.body)?;spec.validate()?;
                                if let Some(state)=UpgradeState::load(journal)? {
                                    if state.spec.upgrade_id==spec.upgrade_id && (state.status!="DOWNLOADING" || !downloads.is_empty()) {
                                        socket.send(Message::Text(crate::protocol::envelope("agent.upgrade.result",state.receipt())?.into())).await?;continue;
                                    }
                                    ensure!(state.spec.upgrade_id==spec.upgrade_id || ["SUCCEEDED","FAILED"].contains(&state.status.as_str()),"upgrade already in progress");
                                }
                                let state=UpgradeState{spec:spec.clone(),status:if spec.sha256==running_hash{"SUCCEEDED"}else{"DOWNLOADING"}.into(),reason:None};state.save(journal)?;
                                socket.send(Message::Text(crate::protocol::envelope("agent.upgrade.result",state.receipt())?.into())).await?;
                                if spec.sha256!=running_hash {
                                    let cfg=cfg.clone();let http=http.clone();let access=access.clone();
                                    downloads.spawn(async move {let result=tokio::time::timeout(Duration::from_secs(120),upgrade::download(&cfg,&http,&access,&spec)).await.map_err(anyhow::Error::from).and_then(|x|x);(spec,result)});
                                }
                            }
                            "agent.trust.update"=>{
                                let update:crate::trust::Update=serde_json::from_value(envelope.body)?;
                                let reason = if update.validate().is_err() { Some("CERTIFICATE_INVALID") }
                                    else if update.apply(cfg).is_err() { Some("PERSIST_FAILED") }
                                    else { None };
                                let receipt = crate::trust::Receipt::new(&update,reason);
                                if reason.is_none() {
                                    // Persist first, then replace the HTTP client. Future WSS
                                    // handshakes also reload the additive trust on reconnect.
                                    match cfg.http_client().and_then(|client| {cfg.tls_config()?; Ok(client)}) {
                                        Ok(client) => { http=client; trust_receipt=Some(receipt); }
                                        Err(_) => { socket.send(Message::Text(crate::protocol::envelope("agent.trust.result",crate::trust::Receipt::new(&update,Some("CONFIG_FAILED")))?.into())).await?; }
                                    }
                                } else { socket.send(Message::Text(crate::protocol::envelope("agent.trust.result",receipt)?.into())).await?; }
                            }
                            "agent.address.update"=>{
                                if crate::routes::Settings::load(journal)?.policy.is_some() {continue;}
                                let update:AddressUpdate=serde_json::from_value(envelope.body)?;update.validate()?;
                                if let Some(receipt)=&address.receipt {
                                    if receipt.request_id==update.request_id {
                                        socket.send(Message::Text(crate::protocol::envelope("agent.address.result",receipt)?.into())).await?;
                                        continue;
                                    }
                                    if receipt.revision>update.revision {continue;}
                                }
                                address_probes.abort_all();while address_probes.join_next().await.is_some() {}
                                let cfg=cfg.clone();let journal=journal.clone();let identity=identity.clone();
                                address_probes.spawn(async move {
                                    let result=tokio::time::timeout(Duration::from_secs(30),probe(cfg,journal,identity,&update)).await.map_err(anyhow::Error::from).and_then(|x|x);
                                    (update,result)
                                });
                            }
                            "task.assign"=>{let task:Task=serde_json::from_value(envelope.body)?;task.validate(&access.device_id)?;let fresh=journal.accept(&task)?;if fresh{cfg.fault("after_accept")?;}}
                            "task.cancel"=>{#[derive(Deserialize)]#[serde(deny_unknown_fields)]struct Cancel{task_id:String}let body:Cancel=serde_json::from_value(envelope.body)?;journal.cancel(&body.task_id)?;}
                            "event.ack"=>{#[derive(Deserialize)]#[serde(deny_unknown_fields)]struct Ack{event_id:String,task_id:String,seq:i64}let ack:Ack=serde_json::from_value(envelope.body)?;journal.ack(&ack.event_id,&ack.task_id,ack.seq)?;}
                            kind if kind.starts_with("terminal.")=>{terminals.receive(kind,envelope.body).await?;}
                            "health.config"=>{health.configure(serde_json::from_value(envelope.body)?)?;}
                            "health.run"=>{#[derive(Deserialize)]#[serde(deny_unknown_fields)]struct Run{revision:u64}let body:Run=serde_json::from_value(envelope.body)?;health.run(body.revision);}
                            "error"=>{eprintln!("server rejected a control message; retaining outbox for replay");}
                            _=>anyhow::bail!("unknown control message type"),
                        }
                    }
                    Message::Ping(bytes)=>socket.send(Message::Pong(bytes)).await?,
                    Message::Pong(bytes)=>{
                        if pending_ping.as_deref()==Some(bytes.as_ref()) {
                            pending_ping=None; network.contact(now_ms())?;
                            contact.send_replace(Some(tokio::time::Instant::now()));
                        }
                    },
                    Message::Close(_)=>return Ok(SessionEnd::ConnectionLost),
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
