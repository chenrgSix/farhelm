use crate::{
    config::{sync_dir, validate_private_dir, Config},
    identity::{Access, Identity},
    journal::Journal,
};
use anyhow::{ensure, Context, Result};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{io::AsyncReadExt, process::Command};
pub const RESTART_EXIT: i32 = 75;
const LIMIT: u64 = 64 * 1024 * 1024;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Spec {
    pub upgrade_id: String,
    pub arch: String,
    pub sha256: String,
    pub size: u64,
    pub version: String,
}
fn version(value: &str) -> Result<Vec<u32>> {
    ensure!(
        value.len() <= 20
            && value
                .split('.')
                .all(|v| !v.is_empty() && v.len() <= 6 && v.bytes().all(|b| b.is_ascii_digit())),
        "invalid version"
    );
    let v = value
        .split('.')
        .map(str::parse)
        .collect::<std::result::Result<Vec<u32>, _>>()?;
    ensure!(v.len() == 3, "invalid version");
    Ok(v)
}
impl Spec {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            uuid::Uuid::parse_str(&self.upgrade_id).is_ok()
                && self.arch == std::env::consts::ARCH
                && self.sha256.len() == 64
                && self
                    .sha256
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
                && (64..=LIMIT).contains(&self.size),
            "invalid upgrade"
        );
        ensure!(
            version(&self.version)? >= version(env!("CARGO_PKG_VERSION"))?,
            "downgrade refused"
        );
        Ok(())
    }
    pub fn path(&self, cfg: &Config) -> PathBuf {
        cfg.state.join("releases").join(&self.sha256)
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct State {
    pub spec: Spec,
    pub status: String,
    pub reason: Option<String>,
}
impl State {
    pub fn load(j: &Journal) -> Result<Option<Self>> {
        j.metadata("agent_upgrade")?
            .map(|s| serde_json::from_str(&s).map_err(Into::into))
            .transpose()
    }
    pub fn save(&self, j: &Journal) -> Result<()> {
        j.set_upgrade(&serde_json::to_string(self)?, None)
    }
    pub fn receipt(&self) -> serde_json::Value {
        json!({"upgrade_id":self.spec.upgrade_id,"status":self.status,"reason":self.reason})
    }
    pub fn failed(&mut self, j: &Journal, reason: &str) -> Result<()> {
        self.status = "FAILED".into();
        self.reason = Some(reason.into());
        self.save(j)
    }
}
#[derive(Default, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Release {
    current: Option<Spec>,
    previous: Option<Spec>,
    trial: bool,
}
impl Release {
    fn load(j: &Journal) -> Result<Self> {
        j.metadata("agent_release")?
            .map(|s| serde_json::from_str(&s))
            .transpose()
            .map(|x| x.unwrap_or_default())
            .map_err(Into::into)
    }
}
pub fn current_hash() -> Result<String> {
    let mut file = File::open("/proc/self/exe")?;
    let mut sha = Sha256::new();
    let mut buf = [0u8; 65536];
    loop {
        let n = Read::read(&mut file, &mut buf)?;
        if n == 0 {
            break;
        }
        sha.update(&buf[..n]);
    }
    Ok(hex::encode(sha.finalize()))
}
pub fn supervised() -> bool {
    std::env::var("FLEET_AGENT_SUPERVISOR_PID")
        .ok()
        .and_then(|s| s.parse::<u32>().ok())
        == Some(unsafe { libc::getppid() } as u32)
}
pub fn build_info() -> serde_json::Value {
    json!({"version":env!("CARGO_PKG_VERSION"),"arch":std::env::consts::ARCH,"upgrade_protocol":1})
}
fn verify_file(path: &Path, spec: &Spec) -> Result<()> {
    let mut f = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)?;
    let m = f.metadata()?;
    ensure!(
        m.is_file()
            && m.uid() == unsafe { libc::geteuid() }
            && m.mode() & 0o077 == 0
            && m.len() == spec.size,
        "invalid release file permissions/size"
    );
    let mut sha = Sha256::new();
    let mut buf = [0u8; 65536];
    let mut header = true;
    loop {
        let n = Read::read(&mut f, &mut buf)?;
        if n == 0 {
            break;
        }
        if header {
            ensure!(
                n >= 64
                    && buf[..6] == [0x7f, b'E', b'L', b'F', 2, 1]
                    && u16::from_le_bytes([buf[18], buf[19]])
                        == if spec.arch == "aarch64" { 183 } else { 62 },
                "invalid ELF architecture"
            );
            header = false;
        }
        sha.update(&buf[..n]);
    }
    ensure!(
        hex::encode(sha.finalize()) == spec.sha256,
        "package digest mismatch"
    );
    Ok(())
}
async fn inspect(path: &Path, spec: &Spec) -> Result<()> {
    let mut child = Command::new(path)
        .arg("--build-info")
        .env_clear()
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()?;
    let mut output = Vec::new();
    let stdout = child.stdout.take().context("missing stdout")?;
    tokio::time::timeout(Duration::from_secs(5), async {
        stdout.take(4097).read_to_end(&mut output).await?;
        ensure!(output.len() <= 4096, "build info oversized");
        ensure!(child.wait().await?.success(), "build check failed");
        Ok::<_, anyhow::Error>(())
    })
    .await??;
    let info: serde_json::Value = serde_json::from_slice(&output)?;
    ensure!(
        info == json!({"version":spec.version,"arch":spec.arch,"upgrade_protocol":1}),
        "incompatible release"
    );
    Ok(())
}
pub async fn download(
    cfg: &Config,
    http: &reqwest::Client,
    access: &Access,
    spec: &Spec,
) -> Result<()> {
    spec.validate()?;
    let dir = cfg.state.join("releases");
    if !dir.exists() {
        fs::create_dir(&dir)?;
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))?;
    }
    validate_private_dir(&dir)?;
    let path = spec.path(cfg);
    if path.exists() {
        verify_file(&path, spec)?;
        return inspect(&path, spec).await;
    }
    let temp = dir.join(format!("{}.part", spec.upgrade_id));
    if temp.exists() {
        fs::remove_file(&temp)?;
    }
    let result = async {
        let mut f = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o700)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&temp)?;
        let mut response = http
            .get(cfg.url(&format!("/api/agent/upgrades/{}/package", spec.upgrade_id))?)
            .bearer_auth(&access.token)
            .timeout(Duration::from_secs(120))
            .send()
            .await?;
        ensure!(
            response.status().is_success()
                && response
                    .content_length()
                    .map(|n| n == spec.size)
                    .unwrap_or(true),
            "download rejected or wrong size"
        );
        let mut size = 0;
        while let Some(chunk) = response.chunk().await? {
            size += chunk.len() as u64;
            ensure!(size <= spec.size, "oversized package");
            f.write_all(&chunk)?;
        }
        ensure!(size == spec.size, "truncated package");
        f.sync_all()?;
        drop(f);
        verify_file(&temp, spec)?;
        inspect(&temp, spec).await?;
        fs::rename(&temp, &path)?;
        sync_dir(&dir)?;
        Ok::<_, anyhow::Error>(())
    }
    .await;
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}
pub fn connected(j: &Journal, sha: &str) -> Result<Option<State>> {
    let Some(mut state) = State::load(j)? else {
        return Ok(None);
    };
    if state.status == "RESTARTING" && state.spec.sha256 == sha {
        let mut release = Release::load(j)?;
        ensure!(
            release.trial
                && release.current.as_ref().map(|r| &r.sha256) == Some(&state.spec.sha256),
            "unexpected upgrade trial"
        );
        release.trial = false;
        release.previous = None;
        state.status = "SUCCEEDED".into();
        state.reason = None;
        j.set_upgrade(
            &serde_json::to_string(&state)?,
            Some(&serde_json::to_string(&release)?),
        )?;
    }
    Ok(Some(state))
}
fn rollback(j: &Journal, release: &mut Release) -> Result<()> {
    let mut state = State::load(j)?.context("missing trial state")?;
    release.current = release.previous.take();
    release.trial = false;
    state.status = "FAILED".into();
    state.reason = Some("TRIAL_FAILED".into());
    j.set_upgrade(
        &serde_json::to_string(&state)?,
        Some(&serde_json::to_string(release)?),
    )
}
pub async fn supervise(cfg: Config) -> Result<()> {
    let instance = cfg.prepare_state()?;
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(cfg.state.join("supervisor.lock"))?;
    lock.try_lock_exclusive()
        .context("another Agent supervisor owns this state")?;
    let _identity = Identity::load_or_create(&cfg.state)?;
    let journal = Journal::open(&cfg.state.join("journal.sqlite3"))?;
    sync_dir(&cfg.state)?;
    drop(instance);
    let base = std::env::current_exe()?;
    let mut release = Release::load(&journal)?;
    if release.trial {
        rollback(&journal, &mut release)?;
    }
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    loop {
        release = Release::load(&journal)?;
        if !release.trial {
            if let Some(mut state) = State::load(&journal)? {
                if state.status == "RESTARTING" {
                    if verify_file(&state.spec.path(&cfg), &state.spec).is_err() {
                        state.failed(&journal, "PACKAGE_INVALID")?;
                    } else {
                        release.previous = release.current.take();
                        release.current = Some(state.spec.clone());
                        release.trial = true;
                        journal.set_upgrade(
                            &serde_json::to_string(&state)?,
                            Some(&serde_json::to_string(&release)?),
                        )?;
                    }
                }
            }
        }
        let executable = if let Some(spec) = &release.current {
            let path = spec.path(&cfg);
            if let Err(error) = verify_file(&path, spec) {
                if release.trial {
                    rollback(&journal, &mut release)?;
                    continue;
                }
                return Err(error);
            }
            path
        } else {
            base.clone()
        };
        let spawned = Command::new(executable)
            .arg("--worker")
            .env("FLEET_AGENT_SUPERVISOR_PID", std::process::id().to_string())
            .kill_on_drop(true)
            .spawn();
        let mut child = match spawned {
            Ok(child) => child,
            Err(error) => {
                if release.trial {
                    rollback(&journal, &mut release)?;
                    continue;
                }
                return Err(error.into());
            }
        };
        let started = tokio::time::Instant::now();
        let mut poll = tokio::time::interval(Duration::from_millis(200));
        let status = loop {
            tokio::select! {
             status=child.wait()=>break status?,
             _=terminate.recv()=>{
                 if let Some(pid)=child.id(){unsafe{libc::kill(pid as i32,libc::SIGTERM);}}
                 if tokio::time::timeout(Duration::from_secs(20),child.wait()).await.is_err(){child.kill().await?;}
                 return Ok(());
             },
             _=tokio::signal::ctrl_c()=>{
                 if let Some(pid)=child.id(){unsafe{libc::kill(pid as i32,libc::SIGTERM);}}
                 if tokio::time::timeout(Duration::from_secs(20),child.wait()).await.is_err(){child.kill().await?;}
                 return Ok(());
             },
             _=poll.tick()=>{release=Release::load(&journal)?;if release.trial && started.elapsed()>Duration::from_secs(60){child.kill().await?;let status=child.wait().await?;rollback(&journal,&mut release)?;break status;}},
            }
        };
        release = Release::load(&journal)?;
        if release.trial {
            rollback(&journal, &mut release)?;
        }
        if status.code() == Some(86) && cfg.fault.is_some() {
            std::process::exit(86);
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn spec() -> Spec {
        Spec {
            upgrade_id: uuid::Uuid::new_v4().to_string(),
            arch: std::env::consts::ARCH.into(),
            sha256: "a".repeat(64),
            size: 64,
            version: env!("CARGO_PKG_VERSION").into(),
        }
    }
    #[test]
    fn rejects_downgrade_wrong_arch_and_unsafe_files() {
        let mut s = spec();
        assert!(s.validate().is_ok());
        s.version = "0.0.1".into();
        assert!(s.validate().is_err());
        s.version = "+1.2.3".into();
        assert!(s.validate().is_err());
        s = spec();
        s.arch = "other".into();
        assert!(s.validate().is_err());
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("release");
        let mut bytes = vec![0u8; 64];
        bytes[..6].copy_from_slice(&[0x7f, b'E', b'L', b'F', 2, 1]);
        bytes[18..20].copy_from_slice(
            &(if std::env::consts::ARCH == "aarch64" {
                183u16
            } else {
                62
            })
            .to_le_bytes(),
        );
        s = spec();
        s.sha256 = hex::encode(Sha256::digest(&bytes));
        fs::write(&path, &bytes).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        verify_file(&path, &s).unwrap();
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&path, &link).unwrap();
        assert!(verify_file(&link, &s).is_err());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(verify_file(&path, &s).is_err());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        bytes[63] = 1;
        fs::write(&path, &bytes).unwrap();
        assert!(verify_file(&path, &s).is_err());
    }
    #[test]
    fn durable_confirmation_and_rollback_keep_identity_and_other_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("journal");
        let j = Journal::open(&path).unwrap();
        let current = spec();
        let previous = Spec {
            sha256: "b".repeat(64),
            ..spec()
        };
        let state = State {
            spec: current.clone(),
            status: "RESTARTING".into(),
            reason: None,
        };
        let mut release = Release {
            current: Some(current.clone()),
            previous: Some(previous.clone()),
            trial: true,
        };
        j.set_upgrade(
            &serde_json::to_string(&state).unwrap(),
            Some(&serde_json::to_string(&release).unwrap()),
        )
        .unwrap();
        assert_eq!(
            connected(&j, &previous.sha256).unwrap().unwrap().status,
            "RESTARTING"
        );
        rollback(&j, &mut release).unwrap();
        drop(j);
        let j = Journal::open(&path).unwrap();
        assert_eq!(
            Release::load(&j).unwrap().current.unwrap().sha256,
            previous.sha256
        );
        assert_eq!(
            State::load(&j).unwrap().unwrap().reason.as_deref(),
            Some("TRIAL_FAILED")
        );
        release = Release {
            current: Some(current.clone()),
            previous: Some(previous),
            trial: true,
        };
        j.set_upgrade(
            &serde_json::to_string(&state).unwrap(),
            Some(&serde_json::to_string(&release).unwrap()),
        )
        .unwrap();
        assert_eq!(
            connected(&j, &current.sha256).unwrap().unwrap().status,
            "SUCCEEDED"
        );
        drop(j);
        let j = Journal::open(&path).unwrap();
        let release = Release::load(&j).unwrap();
        assert!(!release.trial);
        assert!(release.previous.is_none());
        assert_eq!(release.current.unwrap().sha256, current.sha256);
        assert_eq!(
            connected(&j, &current.sha256).unwrap().unwrap().status,
            "SUCCEEDED"
        );
    }
}
