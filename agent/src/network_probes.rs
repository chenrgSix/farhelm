//! Runs independently of the control connection, including during reconnect backoff.
use crate::{config::Config, journal::Journal, now_ms};
use anyhow::{ensure, Result};
use serde::{Deserialize, Serialize};
use std::{sync::Arc, time::Duration};
use tokio::sync::Notify;
use url::Url;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    pub revision: u64,
    pub enabled: bool,
    pub interval_secs: u64,
    pub timeout_ms: u64,
    pub failure_threshold: u32,
    pub targets: Vec<String>,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            revision: 0,
            enabled: false,
            interval_secs: 30,
            timeout_ms: 3000,
            failure_threshold: 3,
            targets: vec![],
        }
    }
}
impl Settings {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.revision <= 9_007_199_254_740_991
                && (5..=3600).contains(&self.interval_secs)
                && (100..=10_000.min(self.interval_secs * 1000)).contains(&self.timeout_ms)
                && (1..=10).contains(&self.failure_threshold),
            "invalid network probe limits"
        );
        ensure!(
            self.targets.len() <= 5 && (!self.enabled || self.targets.len() >= 2),
            "enabled probes require 2 to 5 targets"
        );
        let mut seen = std::collections::HashSet::new();
        for target in &self.targets {
            ensure!(
                !target.is_empty()
                    && target.len() <= 512
                    && !target.chars().any(|c| c.is_whitespace() || c.is_control()),
                "invalid probe target"
            );
            let u = Url::parse(target)?;
            ensure!(
                ["http", "https", "tcp"].contains(&u.scheme())
                    && u.has_host()
                    && u.username().is_empty()
                    && u.password().is_none()
                    && u.fragment().is_none(),
                "invalid probe target URL"
            );
            if u.scheme() == "tcp" {
                ensure!(
                    u.port().is_some_and(|p| p > 0)
                        && ["", "/"].contains(&u.path())
                        && u.query().is_none(),
                    "TCP target requires only host and port"
                );
            }
            ensure!(seen.insert(u.to_string()), "duplicate probe targets");
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Outcome {
    pub target: String,
    pub reachable: bool,
    pub reason: String,
    pub duration_ms: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Report {
    pub sample_id: String,
    pub seq: u64,
    pub revision: u64,
    pub observed_at: i64,
    pub platform_connected: bool,
    pub status: String,
    pub consecutive_failures: u32,
    pub results: Vec<Outcome>,
}
pub fn classify(
    platform: bool,
    results: &[Outcome],
    failures: u32,
    threshold: u32,
) -> &'static str {
    let passed = results.iter().filter(|r| r.reachable).count();
    if results.is_empty() {
        "disabled"
    } else if passed == results.len() {
        if platform {
            "healthy"
        } else {
            "platform_unreachable"
        }
    } else if passed > 0 {
        "partial_unreachable"
    } else if failures < threshold {
        "checking"
    } else if platform {
        "targets_unreachable"
    } else {
        "suspected_offline"
    }
}
async fn probe(client: &reqwest::Client, target: &str, timeout: u64) -> Outcome {
    let start = tokio::time::Instant::now();
    let run = async {
        let u = Url::parse(target).expect("validated probe URL");
        if u.scheme() == "tcp" {
            let host = u
                .host_str()
                .unwrap()
                .trim_start_matches('[')
                .trim_end_matches(']');
            match tokio::net::TcpStream::connect((host, u.port().unwrap())).await {
                Ok(_) => (true, "TCP_CONNECTED"),
                Err(_) => (false, "CONNECT_FAILED"),
            }
        } else {
            // Any response proves reachability, including 4xx/5xx. Do not download the body or follow redirects.
            match client.get(u).send().await {
                Ok(_) => (true, "HTTP_RESPONSE"),
                Err(_) => (false, "HTTP_OR_TLS_FAILED"),
            }
        }
    };
    let (reachable, reason) = tokio::time::timeout(Duration::from_millis(timeout), run)
        .await
        .unwrap_or((false, "TIMEOUT"));
    Outcome {
        target: target.into(),
        reachable,
        reason: reason.into(),
        duration_ms: (start.elapsed().as_millis() as u64).min(timeout),
    }
}

#[derive(Clone)]
pub struct Probes {
    journal: Journal,
    changed: Arc<Notify>,
}
impl Probes {
    pub fn new(journal: Journal) -> Self {
        Self {
            journal,
            changed: Arc::new(Notify::new()),
        }
    }
    pub fn wake(&self) {
        self.changed.notify_one();
    }
    pub fn settings(&self) -> Result<Settings> {
        let settings = self
            .journal
            .metadata("network_probe_config")?
            .map(|s| serde_json::from_str(&s))
            .transpose()?
            .unwrap_or_default();
        Ok(settings)
    }
    pub fn configure(&self, next: Settings) -> Result<u64> {
        next.validate()?;
        let current = self.settings()?;
        ensure!(
            next.revision >= current.revision,
            "stale network probe configuration"
        );
        if next.revision == current.revision {
            ensure!(next == current, "network probe revision conflict");
        } else {
            self.journal
                .network_probe_config(&serde_json::to_string(&next)?)?;
            self.wake();
        }
        Ok(next.revision)
    }
    pub async fn run(self, cfg: Config) -> Result<()> {
        let mut builder = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .pool_max_idle_per_host(0);
        if let Some(pem) = &cfg.ca_pem {
            for cert in reqwest::Certificate::from_pem_bundle(pem)? {
                builder = builder.add_root_certificate(cert);
            }
        }
        let client = builder.build()?;
        let mut revision = None;
        let mut failures = 0u32;
        loop {
            let settings = self.settings()?;
            settings.validate()?;
            if revision != Some(settings.revision) {
                revision = Some(settings.revision);
                failures = 0;
            }
            let results = if settings.enabled {
                tokio::select! {
                    results=futures_util::future::join_all(settings.targets.iter().map(|t|probe(&client,t,settings.timeout_ms)))=>results,
                    _=self.changed.notified()=>continue,
                }
            } else {
                vec![]
            };
            // Cancelled/replaced configurations never publish a result under the new revision.
            if self.settings()?.revision != settings.revision {
                continue;
            }
            failures = if !results.is_empty() && results.iter().all(|r| !r.reachable) {
                failures.saturating_add(1).min(10)
            } else {
                0
            };
            let state: serde_json::Value = self
                .journal
                .metadata("network_state")?
                .map(|s| serde_json::from_str(&s))
                .transpose()?
                .unwrap_or_default();
            // An intentional address/upgrade handoff is not a connectivity failure.
            if state["planned"].as_bool().unwrap_or(false) {
                tokio::select! { _=tokio::time::sleep(Duration::from_secs(settings.interval_secs))=>(), _=self.changed.notified()=>() }
                continue;
            }
            let platform = state["connected"].as_bool().unwrap_or(false);
            let report = Report {
                sample_id: uuid::Uuid::new_v4().to_string(),
                seq: 0,
                revision: settings.revision,
                observed_at: now_ms(),
                platform_connected: platform,
                status: classify(platform, &results, failures, settings.failure_threshold).into(),
                consecutive_failures: failures,
                results,
            };
            self.journal.network_probe_save(report)?;
            tokio::select! {_=tokio::time::sleep(Duration::from_secs(settings.interval_secs))=>(),_=self.changed.notified()=>()}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn outcomes(values: &[bool]) -> Vec<Outcome> {
        values
            .iter()
            .enumerate()
            .map(|(i, v)| Outcome {
                target: format!("tcp://127.0.0.1:{}", i + 1),
                reachable: *v,
                reason: if *v {
                    "TCP_CONNECTED"
                } else {
                    "CONNECT_FAILED"
                }
                .into(),
                duration_ms: 1,
            })
            .collect()
    }
    #[test]
    fn classification_requires_multiple_failures_and_preserves_platform_evidence() {
        assert_eq!(
            classify(false, &outcomes(&[true, true]), 0, 2),
            "platform_unreachable"
        );
        assert_eq!(
            classify(false, &outcomes(&[true, false]), 0, 2),
            "partial_unreachable"
        );
        assert_eq!(
            classify(false, &outcomes(&[false, false]), 1, 2),
            "checking"
        );
        assert_eq!(
            classify(false, &outcomes(&[false, false]), 2, 2),
            "suspected_offline"
        );
        assert_eq!(
            classify(true, &outcomes(&[false, false]), 2, 2),
            "targets_unreachable"
        );
    }
    #[test]
    fn config_is_durable_validated_and_revision_bound() -> Result<()> {
        let t = tempfile::tempdir()?;
        let j = Journal::open(&t.path().join("db"))?;
        let p = Probes::new(j.clone());
        let valid = Settings {
            revision: 1,
            enabled: true,
            targets: vec![
                "tcp://127.0.0.1:80".into(),
                "https://example.test/health".into(),
            ],
            ..Default::default()
        };
        p.configure(valid.clone())?;
        assert_eq!(Probes::new(j.clone()).settings()?, valid);
        let mut bad = valid.clone();
        bad.interval_secs = 1;
        assert!(p.configure(bad).is_err());
        let mut bad = valid.clone();
        bad.targets[0] = "https://user:secret@host/".into();
        assert!(bad.validate().is_err());
        let mut bad = valid.clone();
        bad.targets[0] = "tcp://host:80/path".into();
        assert!(bad.validate().is_err());
        let mut bad = valid.clone();
        bad.interval_secs = 10;
        assert!(p.configure(bad).is_err());
        assert!(p.configure(Settings::default()).is_err());
        let report = Report {
            sample_id: uuid::Uuid::new_v4().to_string(),
            seq: 0,
            revision: 1,
            observed_at: 100,
            platform_connected: false,
            status: "platform_unreachable".into(),
            consecutive_failures: 0,
            results: outcomes(&[true, true]),
        };
        j.network_probe_save(report.clone())?;
        let first = j.network_probe_first()?.unwrap();
        j.network_probe_save(Report {
            sample_id: uuid::Uuid::new_v4().to_string(),
            observed_at: 200,
            ..report
        })?;
        assert_eq!(j.network_probe_first()?.unwrap().sample_id, first.sample_id);
        assert_eq!(j.network_probe_latest()?.unwrap().seq, 2);
        j.network_probe_ack(&first.sample_id, first.seq)?;
        assert!(j.network_probe_first()?.is_none());
        Ok(())
    }
    #[tokio::test]
    async fn tcp_and_http_probes_use_real_sockets_and_any_http_response() -> Result<()> {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let port = listener.local_addr()?.port();
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        assert!(
            probe(&client, &format!("tcp://127.0.0.1:{port}"), 500)
                .await
                .reachable
        );
        let _ = listener.accept().await?;
        tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let mut b = [0; 1024];
            let _ = s.read(&mut b).await;
            let _ = s
                .write_all(b"HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\n\r\n")
                .await;
        });
        let r = probe(&client, &format!("http://127.0.0.1:{port}/"), 500).await;
        assert!(r.reachable);
        assert_eq!(r.reason, "HTTP_RESPONSE");
        assert!(
            !probe(&client, &format!("tcp://127.0.0.1:{port}"), 500)
                .await
                .reachable
        );
        Ok(())
    }
}
