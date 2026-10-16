//! Additive platform trust, delivered only over the authenticated control channel.
//! Keep the original trust anchors during migration; never modify root-owned env files.
use crate::config::{sync_dir, Config};
use anyhow::{ensure, Context, Result};
use rustls::{
    client::danger::ServerCertVerifier,
    pki_types::{ServerName, UnixTime},
    RootCertStore,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::Path,
    sync::Arc,
};
const LIMIT: usize = 8;
const FILE: &str = "platform-trust.json";
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Update {
    pub request_id: String,
    pub revision: u64,
    pub fingerprint: String,
    pub ca_pem: String,
    pub proof_pem: String,
    pub server_name: String,
}
#[derive(Clone, Serialize)]
pub struct Receipt {
    pub request_id: String,
    pub revision: u64,
    pub fingerprint: String,
    pub status: String,
    pub reason: Option<String>,
}
impl Receipt {
    pub fn new(update: &Update, reason: Option<&str>) -> Self {
        Self {
            request_id: update.request_id.clone(),
            revision: update.revision,
            fingerprint: update.fingerprint.clone(),
            status: if reason.is_some() {
                "failed"
            } else {
                "applied"
            }
            .into(),
            reason: reason.map(str::to_owned),
        }
    }
}
#[derive(Deserialize, Serialize, Default)]
#[serde(deny_unknown_fields)]
struct Trust {
    roots: Vec<String>,
}
pub fn fingerprint(der: &[u8]) -> String {
    Sha256::digest(der)
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}
fn certificates(pem: &[u8]) -> Result<Vec<rustls::pki_types::CertificateDer<'static>>> {
    Ok(rustls_pemfile::certs(&mut &pem[..]).collect::<std::io::Result<Vec<_>>>()?)
}
fn load(state: &Path) -> Result<Trust> {
    let path = state.join(FILE);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Trust::default()),
        Err(e) => return Err(e.into()),
    };
    ensure!(
        metadata.is_file()
            && !metadata.file_type().is_symlink()
            && metadata.uid() == unsafe { libc::geteuid() }
            && metadata.mode() & 0o077 == 0
            && metadata.len() <= 131072,
        "invalid platform trust file"
    );
    let saved: Trust = serde_json::from_slice(&fs::read(path)?)?;
    ensure!(saved.roots.len() <= LIMIT, "too many trust anchors");
    for root in &saved.roots {
        ensure!(
            root.len() <= 16384 && certificates(root.as_bytes())?.len() == 1,
            "invalid trust anchor"
        );
    }
    Ok(saved)
}
pub fn roots(state: &Path) -> Result<Vec<String>> {
    Ok(load(state)?.roots)
}
pub fn fingerprints(cfg: &Config) -> Result<Vec<String>> {
    let mut values = Vec::new();
    for pem in roots(&cfg.state)? {
        for cert in certificates(pem.as_bytes())? {
            values.push(fingerprint(&cert));
        }
    }
    if let Some(pem) = &cfg.ca_pem {
        for cert in certificates(pem)? {
            let f = fingerprint(&cert);
            if !values.contains(&f) {
                values.push(f);
            }
        }
    }
    values.truncate(16);
    Ok(values)
}
impl Update {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            uuid::Uuid::parse_str(&self.request_id).is_ok()
                && self.revision > 0
                && self.revision <= 9_007_199_254_740_991,
            "invalid trust request"
        );
        ensure!(
            self.ca_pem.len() <= 16384
                && self.proof_pem.len() <= 32768
                && self.server_name.len() <= 253,
            "trust payload too large"
        );
        ensure!(
            !self.ca_pem.contains("PRIVATE KEY") && !self.proof_pem.contains("PRIVATE KEY"),
            "unexpected private key"
        );
        let roots = certificates(self.ca_pem.as_bytes())?;
        ensure!(
            roots.len() == 1 && fingerprint(&roots[0]) == self.fingerprint,
            "CA fingerprint mismatch"
        );
        let proof = certificates(self.proof_pem.as_bytes())?;
        ensure!(
            !proof.is_empty() && proof.len() <= 4 && proof[0] != roots[0],
            "missing server proof"
        );
        let mut store = RootCertStore::empty();
        store.add(roots[0].clone())?;
        let verifier = rustls::client::WebPkiServerVerifier::builder(Arc::new(store)).build()?;
        let host = ServerName::try_from(self.server_name.clone())?;
        verifier
            .verify_server_cert(&proof[0], &proof[1..], &host, &[], UnixTime::now())
            .context("prospective server chain is not trusted")?;
        Ok(())
    }
    pub fn apply(&self, cfg: &Config) -> Result<()> {
        let mut trust = load(&cfg.state)?;
        if trust.roots.iter().any(|pem| {
            certificates(pem.as_bytes()).is_ok_and(|c| fingerprint(&c[0]) == self.fingerprint)
        }) {
            return Ok(());
        }
        ensure!(trust.roots.len() < LIMIT, "platform trust store is full");
        trust.roots.push(self.ca_pem.clone());
        let path = cfg.state.join(FILE);
        let temp = cfg.state.join(format!(".{FILE}.{}", uuid::Uuid::new_v4()));
        let result = (|| -> Result<()> {
            let mut f = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
                .open(&temp)?;
            f.write_all(&serde_json::to_vec(&trust)?)?;
            f.sync_all()?;
            fs::rename(&temp, path)?;
            sync_dir(&cfg.state)?;
            Ok(())
        })();
        if temp.exists() {
            let _ = fs::remove_file(temp);
        }
        result
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    #[test]
    fn rejects_untrusted_malformed_and_wrong_fingerprint() {
        let update = Update {
            request_id: uuid::Uuid::new_v4().to_string(),
            revision: 1,
            fingerprint: "00".into(),
            ca_pem: "not a certificate".into(),
            proof_pem: "".into(),
            server_name: "fleet.internal".into(),
        };
        assert!(update.validate().is_err());
        assert!(serde_json::from_value::<Update>(serde_json::json!({"extra":true})).is_err());
    }
    #[test]
    fn damaged_or_shared_trust_is_not_silently_discarded() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE);
        fs::write(&path, "{}").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(roots(dir.path()).is_err());
        fs::write(&path, r#"{"roots":[]}"#).unwrap();
        assert!(roots(dir.path()).unwrap().is_empty());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(roots(dir.path()).is_err());
        fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink("missing", &path).unwrap();
        // A dangling symlink must not be treated as an unconfigured trust store.
        assert!(roots(dir.path()).is_err());
    }
}
