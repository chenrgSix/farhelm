use crate::{
    config::{sync_dir, Config},
    journal::Journal,
    now_ms,
};
use anyhow::{ensure, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::{Signer, SigningKey};
use rand::rngs::OsRng;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    fs::OpenOptions,
    io::{Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::Path,
};

pub struct Identity {
    key: SigningKey,
}
#[derive(Clone, Debug)]
pub struct Access {
    pub device_id: String,
    pub token: String,
    pub expires_at: i64,
}
#[derive(Deserialize)]
struct Challenge {
    v: u32,
    challenge_id: String,
    signing_payload: String,
    expires_at: i64,
}
#[derive(Deserialize)]
struct Enrolled {
    v: u32,
    device_id: String,
}
#[derive(Deserialize)]
struct Authenticated {
    v: u32,
    device_id: String,
    access_token: String,
    expires_at: i64,
}

impl Identity {
    pub fn load_or_create(state: &Path) -> Result<Self> {
        let path = state.join("identity.key");
        if path.exists() {
            let mut f = OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
                .open(path)?;
            let m = f.metadata()?;
            ensure!(
                m.is_file()
                    && m.uid() == unsafe { libc::geteuid() }
                    && m.mode() & 0o077 == 0
                    && m.len() == 32,
                "identity key must be current-UID owned, private, exactly 32 bytes"
            );
            let mut bytes = [0; 32];
            f.read_exact(&mut bytes)?;
            return Ok(Self {
                key: SigningKey::from_bytes(&bytes),
            });
        }
        let key = SigningKey::generate(&mut OsRng);
        let mut f = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&path)?;
        f.write_all(&key.to_bytes())?;
        f.sync_all()?;
        sync_dir(state)?;
        Ok(Self { key })
    }
    pub fn public_key(&self) -> String {
        STANDARD.encode(self.key.verifying_key().to_bytes())
    }
    async fn proof(
        &self,
        http: &reqwest::Client,
        cfg: &Config,
        journal: &Journal,
        purpose: &str,
        device: Option<&str>,
        token: Option<&str>,
    ) -> Result<(String, String)> {
        let mut req = serde_json::json!({"v":1,"purpose":purpose,"public_key":self.public_key()});
        if let Some(d) = device {
            req["device_id"] = d.into();
        }
        if let Some(t) = token {
            req["enrollment_token"] = t.into();
        }
        let response = http
            .post(cfg.url("/api/agent/challenge")?)
            .json(&req)
            .send()
            .await?;
        // Do not echo authentication response bodies or secrets into logs.
        ensure!(
            response.status().is_success(),
            "challenge rejected ({})",
            response.status()
        );
        ensure!(
            response.content_length().unwrap_or(0) <= 16 * 1024,
            "challenge response oversized"
        );
        let c: Challenge = response_json(response).await?;
        ensure!(c.v == 1, "challenge version mismatch");
        let bytes = STANDARD.decode(&c.signing_payload)?;
        let server = validate_challenge(
            &bytes,
            &c.challenge_id,
            purpose,
            &self.public_key(),
            device,
            token,
            c.expires_at,
        )?;
        match journal.metadata("server_instance")? {
            Some(expected) => ensure!(
                server == expected,
                "server instance changed; operator review required"
            ),
            None => journal.set_metadata("server_instance", &server)?,
        }
        Ok((
            c.challenge_id,
            STANDARD.encode(self.key.sign(&bytes).to_bytes()),
        ))
    }
    pub async fn authenticate(
        &self,
        http: &reqwest::Client,
        cfg: &Config,
        journal: &Journal,
    ) -> Result<Access> {
        let existing = journal.metadata("device_id")?;
        let attempt = self
            .auth_only(http, cfg, journal, existing.as_deref())
            .await;
        // Key-only auth recovers an enrollment response lost after server commit.
        if attempt.is_ok() {
            return attempt;
        }
        if existing.is_some() {
            return attempt;
        }
        let token = cfg
            .enrollment_token
            .as_deref()
            .context("unregistered identity; FLEET_ENROLLMENT_TOKEN required")?;
        let (challenge_id, signature) = self
            .proof(http, cfg, journal, "enroll", None, Some(token))
            .await?;
        let response=http.post(cfg.url("/api/agent/enroll")?).json(&serde_json::json!({"v":1,"challenge_id":challenge_id,"signature":signature,"name":cfg.name})).send().await?;
        ensure!(
            response.status().is_success(),
            "enrollment rejected ({})",
            response.status()
        );
        let body: Enrolled = response_json(response).await?;
        ensure!(
            body.v == 1 && !body.device_id.is_empty(),
            "invalid enrollment response"
        );
        cfg.fault("after_enroll_response")?;
        journal.set_metadata("device_id", &body.device_id)?;
        self.auth_only(http, cfg, journal, Some(&body.device_id))
            .await
    }
    async fn auth_only(
        &self,
        http: &reqwest::Client,
        cfg: &Config,
        journal: &Journal,
        device: Option<&str>,
    ) -> Result<Access> {
        let (challenge_id, signature) =
            self.proof(http, cfg, journal, "auth", device, None).await?;
        let response = http
            .post(cfg.url("/api/agent/auth")?)
            .json(&serde_json::json!({"v":1,"challenge_id":challenge_id,"signature":signature}))
            .send()
            .await?;
        ensure!(
            response.status().is_success(),
            "device authentication rejected ({})",
            response.status()
        );
        let body: Authenticated = response_json(response).await?;
        ensure!(
            body.v == 1
                && body.expires_at > now_ms()
                && body.expires_at <= now_ms() + 24 * 60 * 60 * 1000
                && !body.access_token.is_empty(),
            "invalid access response"
        );
        if let Some(expected) = device {
            ensure!(body.device_id == expected, "device identity changed");
        }
        journal.set_metadata("device_id", &body.device_id)?;
        Ok(Access {
            device_id: body.device_id,
            token: body.access_token,
            expires_at: body.expires_at,
        })
    }
}

pub(crate) async fn response_json<T: serde::de::DeserializeOwned>(
    mut response: reqwest::Response,
) -> Result<T> {
    const LIMIT: usize = 16 * 1024;
    ensure!(
        response.content_length().unwrap_or(0) <= LIMIT as u64,
        "JSON response oversized"
    );
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        ensure!(body.len() + chunk.len() <= LIMIT, "JSON response oversized");
        body.extend_from_slice(&chunk);
    }
    Ok(serde_json::from_slice(&body)?)
}

pub fn validate_challenge(
    bytes: &[u8],
    id: &str,
    purpose: &str,
    key: &str,
    device: Option<&str>,
    token: Option<&str>,
    expires: i64,
) -> Result<String> {
    ensure!(bytes.len() <= 8192, "challenge payload oversized");
    let text = std::str::from_utf8(bytes)?;
    let fields: Vec<_> = text.split('\n').collect();
    ensure!(
        fields.len() == 10 && fields[9].is_empty() && fields[0] == "fleet-v1",
        "invalid challenge domain/encoding"
    );
    ensure!(
        !fields[1].is_empty() && fields[1].len() <= 256,
        "invalid server instance"
    );
    ensure!(
        fields[2] == purpose
            && fields[3] == id
            && fields[5] == key
            && fields[6] == device.unwrap_or(""),
        "challenge context mismatch"
    );
    ensure!(
        STANDARD.decode(fields[4])?.len() == 32,
        "invalid challenge nonce"
    );
    let token_hash = token
        .map(|x| hex::encode(Sha256::digest(x.as_bytes())))
        .unwrap_or_default();
    ensure!(
        fields[7] == token_hash,
        "challenge enrollment binding mismatch"
    );
    ensure!(
        fields[8] == expires.to_string()
            && expires > now_ms()
            && expires <= now_ms() + 10 * 60 * 1000,
        "challenge expired or invalid expiry"
    );
    Ok(fields[1].into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rfc8032_vector() {
        let seed = hex::decode("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
            .unwrap();
        let key = SigningKey::from_bytes(&seed.try_into().unwrap());
        assert_eq!(
            hex::encode(key.verifying_key().to_bytes()),
            "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"
        );
        assert_eq!(hex::encode(key.sign(b"").to_bytes()),"e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b");
    }
    #[test]
    fn challenge_binds_context() {
        let expires = now_ms() + 30_000;
        let nonce = STANDARD.encode([7; 32]);
        let raw = format!("fleet-v1\nserver\nauth\ncid\n{nonce}\nkey\ndevice\n\n{expires}\n");
        assert!(validate_challenge(
            raw.as_bytes(),
            "cid",
            "auth",
            "key",
            Some("device"),
            None,
            expires
        )
        .is_ok());
        assert!(validate_challenge(
            raw.as_bytes(),
            "cid",
            "enroll",
            "key",
            Some("device"),
            None,
            expires
        )
        .is_err());
    }
    #[test]
    fn key_is_persistent_and_private() {
        let tmp = tempfile::tempdir().unwrap();
        let a = Identity::load_or_create(tmp.path()).unwrap();
        let b = Identity::load_or_create(tmp.path()).unwrap();
        assert_eq!(a.public_key(), b.public_key());
        assert_eq!(
            std::fs::metadata(tmp.path().join("identity.key"))
                .unwrap()
                .mode()
                & 0o777,
            0o600
        );
    }
}
