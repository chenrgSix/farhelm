//! Runtime address changes are stored with the Agent's private journal, never in root-owned env files.
use crate::{config::Config, journal::Journal};
use anyhow::{ensure, Result};
use serde::{Deserialize, Serialize};
use url::Url;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Update {
    pub request_id: String,
    pub revision: u64,
    pub server_url: String,
}
impl Update {
    pub fn validate(&self) -> Result<Url> {
        ensure!(
            uuid::Uuid::parse_str(&self.request_id).is_ok()
                && self.revision > 0
                && self.revision <= 9_007_199_254_740_991,
            "invalid address update"
        );
        origin(&self.server_url)
    }
}
pub fn origin(input: &str) -> Result<Url> {
    ensure!(
        input.len() <= 2048 && !input.bytes().any(|b| b <= 32 || b == 127),
        "invalid address bytes"
    );
    let url = Url::parse(input)?;
    ensure!(
        url.scheme() == "https"
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.path() == "/"
            && url.query().is_none()
            && url.fragment().is_none(),
        "address must be an HTTPS origin"
    );
    Ok(url)
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Receipt {
    pub request_id: String,
    pub revision: u64,
    pub status: String,
    pub reason: Option<String>,
}
impl Receipt {
    pub fn new(update: &Update, status: &str, reason: Option<&str>) -> Self {
        Self {
            request_id: update.request_id.clone(),
            revision: update.revision,
            status: status.into(),
            reason: reason.map(str::to_owned),
        }
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct State {
    pub active_url: String,
    pub pending: Option<Update>,
    pub receipt: Option<Receipt>,
}
impl State {
    pub fn load(cfg: &Config, journal: &Journal) -> Result<Self> {
        let state = match journal.metadata("platform_address")? {
            Some(value) => serde_json::from_str::<Self>(&value)?,
            None => Self {
                active_url: cfg.server.origin().ascii_serialization(),
                pending: None,
                receipt: None,
            },
        };
        origin(&state.active_url)?;
        if let Some(pending) = &state.pending {
            pending.validate()?;
        }
        Ok(state)
    }
    pub fn save(&self, journal: &Journal) -> Result<()> {
        journal.set_platform_address(&serde_json::to_string(self)?)
    }
    pub fn candidate(&self, cfg: &Config) -> Result<Config> {
        let mut next = cfg.clone();
        next.server = origin(
            self.pending
                .as_ref()
                .map(|p| p.server_url.as_str())
                .unwrap_or(&self.active_url),
        )?;
        Ok(next)
    }
    pub fn confirmed(&mut self, cfg: &Config, journal: &Journal) -> Result<()> {
        if let Some(update) = self.pending.take() {
            ensure!(update.validate()? == cfg.server, "candidate changed");
            self.active_url = cfg.server.origin().ascii_serialization();
            self.receipt = Some(Receipt::new(&update, "applied", None));
            self.save(journal)?;
        }
        Ok(())
    }
    pub fn rollback(&mut self, journal: &Journal) -> Result<()> {
        if let Some(update) = self.pending.take() {
            self.receipt = Some(Receipt::new(&update, "failed", Some("CONNECT_FAILED")));
            self.save(journal)?;
        }
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_unsafe_origins() {
        for value in [
            "http://example.com",
            "https://user:pw@example.com",
            "https://example.com/path",
            "https://example.com?q=1",
            "https://exa\nmple.com",
        ] {
            assert!(origin(value).is_err());
        }
        assert!(origin("https://[::1]:8443").is_ok());
    }
    #[test]
    fn candidate_and_rollback_are_durable_without_changing_identity() {
        let tmp = tempfile::tempdir().unwrap();
        let journal = Journal::open(&tmp.path().join("journal.sqlite3")).unwrap();
        journal
            .set_metadata("server_instance", "bound-instance")
            .unwrap();
        let update = Update {
            request_id: uuid::Uuid::new_v4().to_string(),
            revision: 1,
            server_url: "https://new.example.com".into(),
        };
        let mut state = State {
            active_url: "https://old.example.com".into(),
            pending: Some(update.clone()),
            receipt: Some(Receipt::new(&update, "saved", None)),
        };
        state.save(&journal).unwrap();
        state.rollback(&journal).unwrap();
        let restored: State =
            serde_json::from_str(&journal.metadata("platform_address").unwrap().unwrap()).unwrap();
        assert_eq!(restored.active_url, "https://old.example.com");
        assert!(restored.pending.is_none());
        assert_eq!(
            restored.receipt.unwrap().reason.as_deref(),
            Some("CONNECT_FAILED")
        );
        assert_eq!(
            journal.metadata("server_instance").unwrap().as_deref(),
            Some("bound-instance")
        );
    }
}
