use anyhow::{bail, ensure, Context, Result};
use fs2::FileExt;
use std::{
    env,
    fs::{self, File, OpenOptions},
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::Arc,
};
use url::Url;

#[derive(Clone)]
pub struct Config {
    pub server: Url,
    pub state: PathBuf,
    pub ca_pem: Option<Vec<u8>>,
    pub enrollment_token: Option<String>,
    pub name: String,
    pub execution_enabled: bool,
    pub terminal_allow_privilege_escalation: bool,
    pub heartbeat_ms: u64,
    pub fault: Option<String>,
}
impl Config {
    pub fn from_env() -> Result<Self> {
        let server = Url::parse(
            &env::var("FLEET_SERVER_URL").unwrap_or_else(|_| "https://localhost:8443".into()),
        )?;
        ensure!(
            server.scheme() == "https"
                && server.username().is_empty()
                && server.password().is_none()
                && server.query().is_none()
                && server.fragment().is_none()
                && server.path() == "/",
            "server must be an HTTPS origin without credentials/path/query"
        );
        let state =
            PathBuf::from(env::var("FLEET_STATE_DIR").context("FLEET_STATE_DIR is required")?);
        ensure!(state.is_absolute(), "state directory must be absolute");
        let execution_enabled = match env::var("FLEET_EXECUTION_BACKEND")
            .as_deref()
            .unwrap_or("same-uid")
        {
            "disabled" => false,
            "same-uid" | "development-same-uid" => {
                ensure!(
                    unsafe { libc::geteuid() } != 0,
                    "arbitrary execution as root is forbidden"
                );
                true
            }
            _ => bail!("unsupported execution backend"),
        };
        let terminal_allow_privilege_escalation =
            match env::var("FLEET_TERMINAL_ALLOW_PRIVILEGE_ESCALATION").as_deref() {
                Err(env::VarError::NotPresent) | Ok("0") => false,
                Ok("1") => true,
                _ => bail!("FLEET_TERMINAL_ALLOW_PRIVILEGE_ESCALATION must be 0 or 1"),
            };
        if terminal_allow_privilege_escalation {
            ensure!(
                unsafe { libc::prctl(libc::PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0) } == 0,
                "terminal privilege escalation cannot override inherited no_new_privs"
            );
        }
        let fault = env::var("FLEET_TEST_FAULT").ok();
        if let Some(point) = &fault {
            ensure!(
                env::var("FLEET_TEST_MODE").as_deref() == Ok("1"),
                "fault injection requires FLEET_TEST_MODE=1"
            );
            ensure!(
                matches!(server.host_str(), Some("localhost" | "127.0.0.1" | "::1")),
                "fault injection requires loopback server"
            );
            ensure!(
                matches!(
                    point.as_str(),
                    "after_enroll_response"
                        | "after_accept"
                        | "after_running"
                        | "after_spawn"
                        | "after_seal"
                        | "after_finish"
                ),
                "unsupported fault point"
            );
        }
        let heartbeat_ms = env::var("FLEET_HEARTBEAT_MS")
            .ok()
            .map(|x| x.parse())
            .transpose()?
            .unwrap_or(2000);
        ensure!(
            (100..=60_000).contains(&heartbeat_ms),
            "heartbeat outside bounds"
        );
        Ok(Self {
            server,
            state,
            ca_pem: env::var("FLEET_CA_CERT").ok().map(fs::read).transpose()?,
            enrollment_token: env::var("FLEET_ENROLLMENT_TOKEN").ok(),
            name: env::var("FLEET_DEVICE_NAME").unwrap_or_else(|_| "farhelm-device".into()),
            execution_enabled,
            terminal_allow_privilege_escalation,
            heartbeat_ms,
            fault,
        })
    }
    pub fn url(&self, path: &str) -> Result<Url> {
        Ok(self.server.join(path)?)
    }
    pub fn prepare_state(&self) -> Result<File> {
        if !self.state.exists() {
            fs::create_dir_all(&self.state)?;
            fs::set_permissions(&self.state, fs::Permissions::from_mode(0o700))?;
        }
        validate_private_dir(&self.state)?;
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(self.state.join("agent.lock"))?;
        lock.try_lock_exclusive()
            .context("another agent owns this state directory")?;
        let key = self.state.join("identity.key").exists();
        let db = self.state.join("journal.sqlite3").exists();
        ensure!(key==db, "identity/journal pair incomplete: recovery requires operator review; refusing automatic fresh identity");
        let artifacts = self.state.join("artifacts");
        if !artifacts.exists() {
            fs::create_dir(&artifacts)?;
            fs::set_permissions(&artifacts, fs::Permissions::from_mode(0o700))?;
        }
        validate_private_dir(&artifacts)?;
        Ok(lock)
    }
    pub fn fault(&self, point: &str) -> Result<()> {
        if self.fault.as_deref() == Some(point) {
            let marker = self.state.join(format!("fault-{point}.once"));
            match OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(marker)
            {
                Ok(f) => {
                    f.sync_all()?;
                    sync_dir(&self.state)?;
                    eprintln!("development fault injected at {point}");
                    std::process::exit(86)
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => (),
                Err(e) => return Err(e.into()),
            }
        }
        Ok(())
    }
    pub fn tls_config(&self) -> Result<Arc<rustls::ClientConfig>> {
        let mut roots = rustls::RootCertStore::empty();
        if let Some(pem) = &self.ca_pem {
            for cert in rustls_pemfile::certs(&mut &pem[..]) {
                roots.add(cert?)?;
            }
        } else {
            roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        }
        for pem in crate::trust::roots(&self.state)? {
            for cert in rustls_pemfile::certs(&mut pem.as_bytes()) {
                roots.add(cert?)?;
            }
        }
        ensure!(!roots.is_empty(), "no trust anchors");
        Ok(Arc::new(
            rustls::ClientConfig::builder()
                .with_root_certificates(roots)
                .with_no_client_auth(),
        ))
    }
    pub fn http_client(&self) -> Result<reqwest::Client> {
        let mut b = reqwest::Client::builder()
            .use_rustls_tls()
            .https_only(true)
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(15));
        if let Some(pem) = &self.ca_pem {
            b = b.tls_built_in_root_certs(false);
            for cert in reqwest::Certificate::from_pem_bundle(pem)? {
                b = b.add_root_certificate(cert);
            }
        }
        for pem in crate::trust::roots(&self.state)? {
            for cert in reqwest::Certificate::from_pem_bundle(pem.as_bytes())? {
                b = b.add_root_certificate(cert);
            }
        }
        Ok(b.build()?)
    }
}
pub fn validate_private_dir(path: &Path) -> Result<()> {
    let m = fs::symlink_metadata(path)?;
    ensure!(
        m.is_dir()
            && !m.file_type().is_symlink()
            && m.uid() == unsafe { libc::geteuid() }
            && m.mode() & 0o077 == 0,
        "state directory must be owned by current UID, non-symlink, and mode 0700"
    );
    Ok(())
}
pub fn sync_dir(path: &Path) -> Result<()> {
    File::open(path)?.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config(state: &Path) -> Config {
        Config {
            server: Url::parse("https://localhost:8443").unwrap(),
            state: state.into(),
            ca_pem: None,
            enrollment_token: None,
            name: "test".into(),
            execution_enabled: false,
            terminal_allow_privilege_escalation: false,
            heartbeat_ms: 2000,
            fault: None,
        }
    }
    #[test]
    fn single_instance_lock_rejects_second_owner() {
        let d = tempfile::tempdir().unwrap();
        fs::set_permissions(d.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let c = config(d.path());
        let first = c.prepare_state().unwrap();
        assert!(c.prepare_state().is_err());
        drop(first);
        assert!(c.prepare_state().is_ok());
    }
    #[test]
    fn missing_journal_does_not_create_new_identity() {
        let d = tempfile::tempdir().unwrap();
        fs::write(d.path().join("identity.key"), [0; 32]).unwrap();
        assert!(config(d.path()).prepare_state().is_err());
    }
}
