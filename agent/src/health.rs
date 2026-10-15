//! Agent-local, bounded health probes. Configuration and results use the authenticated control channel.
use anyhow::{ensure, Result};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{process::Stdio, sync::Arc, time::Duration};
use tokio::{
    net::TcpStream,
    sync::{mpsc, watch, Semaphore},
    task::JoinSet,
};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Check {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub interval_secs: u64,
    pub timeout_ms: u64,
    pub failure_threshold: u8,
    pub probe: Probe,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum Probe {
    Http {
        url: String,
        expected_status: u16,
        body_contains: String,
    },
    Tcp {
        host: String,
        port: u16,
    },
    Systemd {
        unit: String,
    },
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Snapshot {
    pub revision: u64,
    pub checks: Vec<Check>,
}
impl Check {
    fn validate(&self) -> Result<()> {
        uuid::Uuid::parse_str(&self.id)?;
        ensure!(
            !self.name.trim().is_empty() && self.name.chars().count() <= 80,
            "invalid check name"
        );
        ensure!(
            (5..=3600).contains(&self.interval_secs)
                && (100..=30000).contains(&self.timeout_ms)
                && self.timeout_ms <= self.interval_secs * 1000
                && (1..=10).contains(&self.failure_threshold),
            "invalid check limits"
        );
        match &self.probe {
            Probe::Http {
                url,
                expected_status,
                body_contains,
            } => {
                let parsed = url::Url::parse(url)?;
                ensure!(
                    url.chars().count() <= 2048
                        && ["http", "https"].contains(&parsed.scheme())
                        && parsed.host_str().is_some()
                        && parsed.username().is_empty()
                        && parsed.password().is_none()
                        && parsed.fragment().is_none()
                        && (100..=599).contains(expected_status)
                        && body_contains.chars().count() <= 256,
                    "invalid HTTP probe"
                );
            }
            Probe::Tcp { host, port } => {
                ensure!(
                    !host.is_empty()
                        && host.len() <= 253
                        && *port > 0
                        && host
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b".:[]_-".contains(&b)),
                    "invalid TCP probe"
                );
            }
            Probe::Systemd { unit } => {
                ensure!(
                    unit.ends_with(".service")
                        && unit.len() <= 200
                        && unit
                            .bytes()
                            .next()
                            .is_some_and(|b| b.is_ascii_alphanumeric() || b == b'_')
                        && unit
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b"_.@-".contains(&b)),
                    "invalid service unit"
                );
            }
        }
        Ok(())
    }
}
struct Outcome {
    healthy: Option<bool>,
    reason: &'static str,
}
impl Outcome {
    fn known(ok: bool, reason: &'static str) -> Self {
        Self {
            healthy: Some(ok),
            reason,
        }
    }
    fn unknown(reason: &'static str) -> Self {
        Self {
            healthy: None,
            reason,
        }
    }
}
async fn probe(check: &Check, http: &reqwest::Client) -> Outcome {
    match &check.probe {
        Probe::Tcp { host, port } => {
            match TcpStream::connect((host.trim_matches(['[', ']']), *port)).await {
                Ok(_) => Outcome::known(true, "OK"),
                Err(_) => Outcome::known(false, "TCP_CONNECT_FAILED"),
            }
        }
        Probe::Http {
            url,
            expected_status,
            body_contains,
        } => {
            let Ok(mut response) = http.get(url).send().await else {
                return Outcome::known(false, "HTTP_REQUEST_FAILED");
            };
            if response.status().as_u16() != *expected_status {
                return Outcome::known(false, "HTTP_STATUS_MISMATCH");
            }
            if body_contains.is_empty() {
                return Outcome::known(true, "OK");
            }
            let mut bytes = Vec::new();
            loop {
                match response.chunk().await {
                    Ok(Some(chunk)) => {
                        let remaining = 65536 - bytes.len();
                        bytes.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
                        if bytes
                            .windows(body_contains.len())
                            .any(|part| part == body_contains.as_bytes())
                        {
                            return Outcome::known(true, "OK");
                        }
                        if bytes.len() == 65536 {
                            return Outcome::known(false, "HTTP_BODY_LIMIT");
                        }
                    }
                    Ok(None) => return Outcome::known(false, "HTTP_BODY_MISMATCH"),
                    Err(_) => return Outcome::known(false, "HTTP_BODY_FAILED"),
                }
            }
        }
        Probe::Systemd { unit } => {
            if !std::path::Path::new("/run/systemd/system").is_dir() {
                return Outcome::unknown("SYSTEMD_UNAVAILABLE");
            }
            let mut command = tokio::process::Command::new("/usr/bin/systemctl");
            command
                .args(["is-active", "--quiet", "--", unit])
                .env_clear()
                .env("PATH", "/usr/bin:/bin")
                .env("LANG", "C")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .kill_on_drop(true);
            unsafe {
                command.pre_exec(|| {
                    if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) == -1 {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
            match command.status().await {
                Ok(status) if status.success() => Outcome::known(true, "OK"),
                Ok(status) if status.code() == Some(3) || status.code() == Some(4) => {
                    Outcome::known(false, "SERVICE_INACTIVE")
                }
                _ => Outcome::unknown("SYSTEMD_UNAVAILABLE"),
            }
        }
    }
}
pub struct Checks {
    revision: u64,
    workers: JoinSet<()>,
    wake: watch::Sender<u64>,
    output: mpsc::Sender<serde_json::Value>,
    http: reqwest::Client,
    permits: Arc<Semaphore>,
}
impl Checks {
    pub fn new(output: mpsc::Sender<serde_json::Value>) -> Result<Self> {
        Ok(Self {
            revision: 0,
            workers: JoinSet::new(),
            wake: watch::channel(0).0,
            output,
            http: reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(30))
                .build()?,
            permits: Arc::new(Semaphore::new(4)),
        })
    }
    pub fn configure(&mut self, snapshot: Snapshot) -> Result<()> {
        ensure!(
            snapshot.revision <= 9_007_199_254_740_991 && snapshot.checks.len() <= 8,
            "invalid health snapshot"
        );
        let mut ids = std::collections::HashSet::new();
        for check in &snapshot.checks {
            check.validate()?;
            ensure!(ids.insert(check.id.clone()), "duplicate check ID");
        }
        // Repeated delivery must not reset per-check sequence numbers or schedules.
        if snapshot.revision <= self.revision {
            return Ok(());
        }
        self.workers.abort_all();
        while self.workers.try_join_next().is_some() {}
        self.revision = snapshot.revision;
        for check in snapshot.checks.into_iter().filter(|c| c.enabled) {
            let output = self.output.clone();
            let http = self.http.clone();
            let mut wake = self.wake.subscribe();
            let permits = self.permits.clone();
            let revision = self.revision;
            self.workers.spawn(async move {
                let mut timer = tokio::time::interval(Duration::from_secs(check.interval_secs));
                timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                let mut seq = 0u64;
                loop {
                    tokio::select! { _=timer.tick()=>(), result=wake.changed()=>{if result.is_err(){return;}} }
                    let Ok(_permit) = permits.acquire().await else { return; };
                    let start = std::time::Instant::now();
                    let result = tokio::time::timeout(Duration::from_millis(check.timeout_ms), probe(&check, &http)).await.unwrap_or_else(|_| Outcome::known(false, "TIMEOUT"));
                    seq += 1;
                    if output.send(json!({"revision":revision,"check_id":check.id,"seq":seq,"healthy":result.healthy,"reason":result.reason,"duration_ms":start.elapsed().as_millis().min(30000) as u64})).await.is_err() { return; }
                }
            });
        }
        Ok(())
    }
    pub fn run(&self, revision: u64) {
        if revision == self.revision {
            self.wake
                .send_modify(|generation| *generation = generation.wrapping_add(1));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };
    fn check(probe: Probe) -> Check {
        Check {
            id: uuid::Uuid::new_v4().to_string(),
            name: "test".into(),
            enabled: true,
            interval_secs: 30,
            timeout_ms: 200,
            failure_threshold: 2,
            probe,
        }
    }
    #[tokio::test]
    async fn actual_tcp_success_and_refused_port() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let http = reqwest::Client::new();
        let c = check(Probe::Tcp {
            host: "127.0.0.1".into(),
            port,
        });
        assert_eq!(probe(&c, &http).await.healthy, Some(true));
        drop(listener);
        assert_eq!(probe(&c, &http).await.healthy, Some(false));
    }
    #[tokio::test]
    async fn actual_http_status_body_and_no_redirect_following() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            for _ in 0..4 {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = [0; 1024];
                let n = stream.read(&mut request).await.unwrap();
                let request = String::from_utf8_lossy(&request[..n]);
                let response = if request.contains("/redirect") {
                    "HTTP/1.1 302 Found\r\nLocation: /ok\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                } else {
                    "HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nready"
                };
                stream.write_all(response.as_bytes()).await.unwrap();
            }
        });
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        for (path, status, text, expected) in [
            ("/ok", 200, "ready", "OK"),
            ("/ok", 201, "", "HTTP_STATUS_MISMATCH"),
            ("/ok", 200, "missing", "HTTP_BODY_MISMATCH"),
            ("/redirect", 200, "", "HTTP_STATUS_MISMATCH"),
        ] {
            let c = check(Probe::Http {
                url: format!("http://127.0.0.1:{port}{path}"),
                expected_status: status,
                body_contains: text.into(),
            });
            assert_eq!(probe(&c, &http).await.reason, expected);
        }
        server.await.unwrap();
    }
    #[tokio::test]
    async fn timeout_manual_run_and_replacement_cancel_old_workers() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (out, mut events) = mpsc::channel(16);
        let mut manager = Checks::new(out).unwrap();
        let c = check(Probe::Http {
            url: format!("http://127.0.0.1:{port}/"),
            expected_status: 200,
            body_contains: String::new(),
        });
        manager
            .configure(Snapshot {
                revision: 1,
                checks: vec![c.clone()],
            })
            .unwrap();
        let result = tokio::time::timeout(Duration::from_secs(2), events.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result["reason"], "TIMEOUT");
        manager
            .configure(Snapshot {
                revision: 1,
                checks: vec![c],
            })
            .unwrap();
        manager.run(1);
        let result = tokio::time::timeout(Duration::from_secs(2), events.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result["seq"], 2);
        manager
            .configure(Snapshot {
                revision: 2,
                checks: vec![],
            })
            .unwrap();
        manager.run(1);
        assert!(
            tokio::time::timeout(Duration::from_millis(350), events.recv())
                .await
                .is_err()
        );
    }
    #[test]
    fn rejects_credentials_shell_injection_and_excess_limits() {
        assert!(check(Probe::Http {
            url: "http://u:pass@localhost/".into(),
            expected_status: 200,
            body_contains: String::new()
        })
        .validate()
        .is_err());
        assert!(check(Probe::Systemd {
            unit: "nginx.service;touch /tmp/no".into()
        })
        .validate()
        .is_err());
        let mut c = check(Probe::Tcp {
            host: "127.0.0.1".into(),
            port: 80,
        });
        c.interval_secs = 1;
        assert!(c.validate().is_err());
    }
}
