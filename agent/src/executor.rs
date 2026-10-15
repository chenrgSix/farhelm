use crate::{
    config::{sync_dir, Config},
    journal::Journal,
    now_ms,
    protocol::Task,
};
use anyhow::{ensure, Context, Result};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::{
        fs::{MetadataExt, OpenOptionsExt},
        process::CommandExt,
    },
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    sync::mpsc,
};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Artifact {
    pub sha256: String,
    pub size: u64,
}
#[derive(Clone, Debug)]
struct ProcessIdentity {
    pid: u32,
    start_ticks: u64,
    pgid: i32,
    state: char,
}
#[derive(Debug, Clone, Copy)]
enum CaptureFailure {
    Limit,
    Storage,
}

#[async_trait]
pub trait ExecutionBackend: Send + Sync {
    async fn execute(&self, cfg: &Config, journal: &Journal, task: &Task) -> Result<()>;
    fn name(&self) -> &'static str;
}
pub struct Disabled;
pub struct SameUid;
#[async_trait]
impl ExecutionBackend for Disabled {
    async fn execute(&self, _: &Config, journal: &Journal, task: &Task) -> Result<()> {
        journal.finish(
            &task.task_id,
            no_execution("FAILED", "EXECUTION_BACKEND_DISABLED"),
        )
    }
    fn name(&self) -> &'static str {
        "disabled"
    }
}
#[async_trait]
impl ExecutionBackend for SameUid {
    async fn execute(&self, cfg: &Config, journal: &Journal, task: &Task) -> Result<()> {
        run_same_uid(cfg, journal, task).await
    }
    fn name(&self) -> &'static str {
        "same-uid"
    }
}

pub async fn scheduler(cfg: Config, journal: Journal) -> Result<()> {
    recover_running(&cfg, &journal).await?;
    let backend: Box<dyn ExecutionBackend> = if cfg.execution_enabled {
        Box::new(SameUid)
    } else {
        Box::new(Disabled)
    };
    eprintln!(
        "execution backend: {} (same-UID mode is not an endpoint integrity boundary)",
        backend.name()
    );
    loop {
        if let Some(task) = journal.next_accepted()? {
            if journal.cancelled(&task.task_id)? {
                journal.finish(
                    &task.task_id,
                    no_execution("CANCELLED", "CANCELLED_BEFORE_START"),
                )?;
                continue;
            }
            if now_ms() >= task.expires_at {
                journal.finish(
                    &task.task_id,
                    no_execution("EXPIRED", "TTL_EXPIRED_BEFORE_START"),
                )?;
                continue;
            }
            // There is only one scheduler, held independently of the control connection.
            backend.execute(&cfg, &journal, &task).await?;
        } else {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
}
fn no_execution(status: &str, reason: &str) -> Value {
    json!({"status":status,"exit_code":null,"reason":reason,"audit_complete":!reason.starts_with("AUDIT_"),"stdout":null,"stderr":null,"started_at":null,"finished_at":now_ms(),"cleanup":"not_started"})
}

async fn run_same_uid(cfg: &Config, journal: &Journal, task: &Task) -> Result<()> {
    ensure!(
        unsafe { libc::geteuid() } != 0,
        "refusing arbitrary execution as root"
    );
    // Check storage before marking RUNNING: no child exists if capture cannot be opened.
    let dir = cfg.state.join("artifacts");
    if !enough_disk(&dir, task.max_output_bytes.saturating_add(16 * 1024 * 1024))? {
        journal.finish(&task.task_id, no_execution("FAILED", "AUDIT_DISK_RESERVE"))?;
        return Ok(());
    }
    let stdout = dir.join(format!("{}.stdout", task.task_id));
    let stderr = dir.join(format!("{}.stderr", task.task_id));
    let out = create_capture(&stdout);
    let err = create_capture(&stderr);
    let (out, err) = match (out, err) {
        (Ok(a), Ok(b)) => (a, b),
        _ => {
            journal.finish(
                &task.task_id,
                no_execution("FAILED", "AUDIT_STORAGE_UNAVAILABLE"),
            )?;
            return Ok(());
        }
    };
    sync_dir(&dir)?;
    let started_at = journal.start(&task.task_id, &stdout, &stderr)?;
    cfg.fault("after_running")?;
    let mut command = tokio::process::Command::new(&task.argv[0]);
    command
        .args(&task.argv[1..])
        .current_dir(&task.cwd)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("LANG", "C.UTF-8")
        .env("LC_ALL", "C.UTF-8")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // Fixed same-UID, never sudo/setuid/user creation. Separate process group is limited
    // containment: a descendant can deliberately setsid(), so cleanup is unconfirmed.
    command.as_std_mut().process_group(0);
    // Restrict this child only: setuid/file capabilities cannot elevate the selected UID.
    // pre_exec performs only the async-signal-safe prctl syscall and errno capture.
    unsafe {
        command.as_std_mut().pre_exec(|| {
            if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(_) => {
            out.sync_all()?;
            err.sync_all()?;
            let payload = json!({"status":"FAILED","exit_code":null,"reason":"SPAWN_FAILED","audit_complete":true,"stdout":seal(&stdout)?,"stderr":seal(&stderr)?,"started_at":started_at,"finished_at":now_ms(),"cleanup":"not_started"});
            journal.finish(&task.task_id, payload)?;
            return Ok(());
        }
    };
    let pid = child.id().context("spawn did not produce PID")?;
    let identity = process_identity(pid).context("cannot verify spawned process identity")?;
    if let Err(error) = journal.set_process(&task.task_id, pid, identity.start_ticks) {
        // On journal failure stop before allowing the scheduler to move on.
        let _ = signal_verified_group(&identity, libc::SIGKILL);
        let _ = child.wait().await;
        return Err(error);
    }
    cfg.fault("after_spawn")?;
    let (failure_tx, mut failure_rx) = mpsc::channel(4);
    let used = Arc::new(AtomicU64::new(0));
    let mut captures = tokio::task::JoinSet::new();
    captures.spawn(capture(
        child.stdout.take().unwrap(),
        out,
        used.clone(),
        task.max_output_bytes,
        failure_tx.clone(),
    ));
    captures.spawn(capture(
        child.stderr.take().unwrap(),
        err,
        used,
        task.max_output_bytes,
        failure_tx.clone(),
    ));
    drop(failure_tx);
    let deadline = tokio::time::Instant::now() + Duration::from_millis(task.timeout_ms);
    let mut tick = tokio::time::interval(Duration::from_millis(25));
    let mut interruption: Option<&str> = None;
    loop {
        tokio::select! {
            Some(failure)=failure_rx.recv()=>{interruption=Some(match failure{CaptureFailure::Limit=>"OUTPUT_LIMIT",CaptureFailure::Storage=>"AUDIT_STORAGE_FAILURE"});break;}
            _=tokio::time::sleep_until(deadline)=>{interruption=Some("TIMEOUT_CLEANUP_UNCONFIRMED");break;}
            _=tick.tick()=>{
                match journal.cancelled(&task.task_id){Ok(true)=>{interruption=Some("CANCEL_CLEANUP_UNCONFIRMED");break;},Ok(false)=>(),Err(_)=>{interruption=Some("AUDIT_STORAGE_FAILURE");break;}}
                match process_identity(pid){Some(p) if p.start_ticks==identity.start_ticks && p.state=='Z'=>break,Some(p) if p.start_ticks==identity.start_ticks=>(),_=>{interruption=Some("PROCESS_IDENTITY_LOST");break;}}
            }
        }
    }
    // Preserve the unreaped leader until group cleanup, preventing PGID reuse.
    // TERM, bounded grace, KILL; wait/reap occurs only after both group signals.
    let cleanup_evidence = stop_group(&identity).await;
    let status = tokio::time::timeout(Duration::from_secs(3), child.wait()).await;
    reap_group(identity.pgid).await;
    let mut audit_complete = true;
    let readers = async {
        let mut complete = true;
        while let Some(reader) = captures.join_next().await {
            if !matches!(reader, Ok(Ok(()))) {
                complete = false;
            }
        }
        complete
    };
    let readers_done = tokio::time::timeout(Duration::from_secs(2), readers).await;
    // A setsid escape may keep one inherited pipe open after the other closes.
    // JoinSet removes completed handles, avoiding a double-poll after drain timeout.
    if readers_done.is_err() {
        captures.abort_all();
        while captures.join_next().await.is_some() {}
    }
    if !matches!(readers_done, Ok(true)) {
        audit_complete = false;
    }
    while let Ok(failure) = failure_rx.try_recv() {
        audit_complete = false;
        if matches!(failure, CaptureFailure::Limit) {
            interruption = Some("OUTPUT_LIMIT");
        } else {
            interruption = Some("AUDIT_STORAGE_FAILURE");
        }
    }
    if matches!(interruption, Some("OUTPUT_LIMIT" | "AUDIT_STORAGE_FAILURE")) {
        audit_complete = false;
    }
    let out_meta = seal(&stdout);
    let err_meta = seal(&stderr);
    if out_meta.is_err() || err_meta.is_err() {
        audit_complete = false;
        interruption = Some("AUDIT_STORAGE_FAILURE");
    }
    cfg.fault("after_seal")?;
    let exit = status
        .as_ref()
        .ok()
        .and_then(|x| x.as_ref().ok())
        .and_then(|x| x.code());
    let success = status
        .as_ref()
        .ok()
        .and_then(|x| x.as_ref().ok())
        .map(|x| x.success())
        .unwrap_or(false);
    let (terminal, reason) = if interruption.is_some() || !cleanup_evidence || status.is_err() {
        (
            "UNKNOWN",
            interruption.or(Some("PROCESS_CLEANUP_UNCONFIRMED")),
        )
    } else if !audit_complete {
        ("UNKNOWN", Some("AUDIT_CAPTURE_INCOMPLETE"))
    } else if success {
        ("SUCCEEDED", None)
    } else {
        ("FAILED", Some("NONZERO_EXIT"))
    };
    if terminal == "UNKNOWN" {
        audit_complete = false;
    }
    let payload = json!({"status":terminal,"exit_code":exit,"reason":reason,"audit_complete":audit_complete,"stdout":out_meta.ok(),"stderr":err_meta.ok(),"started_at":started_at,"finished_at":now_ms(),"cleanup":"unconfirmed"});
    journal.finish(&task.task_id, payload)?;
    cfg.fault("after_finish")?;
    Ok(())
}
fn enough_disk(path: &Path, reserve: u64) -> Result<bool> {
    use std::os::unix::ffi::OsStrExt;
    let path = std::ffi::CString::new(path.as_os_str().as_bytes())?;
    let mut stat = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    ensure!(
        unsafe { libc::statvfs(path.as_ptr(), stat.as_mut_ptr()) } == 0,
        "cannot inspect audit filesystem capacity"
    );
    let stat = unsafe { stat.assume_init() };
    Ok(stat.f_bavail.saturating_mul(stat.f_frsize) >= reserve)
}
async fn reap_group(pgid: i32) {
    // Linux subreaper mode is enabled at agent startup. Only reap this task's group.
    for _ in 0..20 {
        let mut status = 0;
        let rc = unsafe { libc::waitpid(-pgid, &mut status, libc::WNOHANG) };
        if rc < 0 {
            break;
        }
        if rc == 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
}
fn create_capture(path: &Path) -> Result<File> {
    Ok(OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)?)
}
async fn capture<R: AsyncRead + Unpin>(
    mut input: R,
    file: File,
    used: Arc<AtomicU64>,
    limit: u64,
    notice: mpsc::Sender<CaptureFailure>,
) -> Result<()> {
    let mut file = file;
    let mut buf = [0u8; 8192];
    let mut notified = false;
    loop {
        let n = match input.read(&mut buf).await {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) => {
                let _ = notice.try_send(CaptureFailure::Storage);
                return Err(e.into());
            }
        };
        let old = loop {
            let old = used.load(Ordering::SeqCst);
            let new = old.saturating_add(n as u64).min(limit);
            if used
                .compare_exchange_weak(old, new, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
            {
                break old;
            }
        };
        let allowed = (limit.saturating_sub(old) as usize).min(n);
        if allowed > 0 {
            if let Err(e) = file.write_all(&buf[..allowed]) {
                let _ = notice.try_send(CaptureFailure::Storage);
                return Err(e.into());
            }
        }
        if allowed < n && !notified {
            notified = true;
            let _ = notice.try_send(CaptureFailure::Limit);
        }
    }
    if let Err(e) = file.sync_all() {
        let _ = notice.try_send(CaptureFailure::Storage);
        return Err(e.into());
    }
    Ok(())
}
pub fn seal(path: &Path) -> Result<Artifact> {
    let mut f = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)?;
    ensure!(f.metadata()?.is_file(), "artifact is not regular file");
    f.sync_all()?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 8192];
    let mut size = 0;
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        size += n as u64;
        ensure!(
            size <= crate::protocol::MAX_OUTPUT,
            "artifact exceeds absolute size bound"
        );
        hasher.update(&buf[..n]);
    }
    Ok(Artifact {
        sha256: hex::encode(hasher.finalize()),
        size,
    })
}
fn process_identity(pid: u32) -> Option<ProcessIdentity> {
    let path = PathBuf::from(format!("/proc/{pid}"));
    if fs::metadata(&path).ok()?.uid() != unsafe { libc::geteuid() } {
        return None;
    }
    let stat = fs::read_to_string(path.join("stat")).ok()?;
    let after = stat.rsplit_once(')')?.1;
    let fields: Vec<_> = after.split_whitespace().collect();
    Some(ProcessIdentity {
        pid,
        start_ticks: fields.get(19)?.parse().ok()?,
        pgid: fields.get(2)?.parse().ok()?,
        state: fields.first()?.chars().next()?,
    })
}
fn signal_verified_group(identity: &ProcessIdentity, signal: i32) -> bool {
    let Some(current) = process_identity(identity.pid) else {
        return false;
    };
    if current.start_ticks != identity.start_ticks || current.pgid != identity.pid as i32 {
        return false;
    }
    let rc = unsafe { libc::kill(-(identity.pid as i32), signal) };
    rc == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
}
async fn stop_group(identity: &ProcessIdentity) -> bool {
    let term = signal_verified_group(identity, libc::SIGTERM);
    tokio::time::sleep(Duration::from_millis(200)).await;
    let kill = signal_verified_group(identity, libc::SIGKILL);
    term && kill
}
pub async fn recover_running(cfg: &Config, journal: &Journal) -> Result<()> {
    for running in journal.running()? {
        let cleanup = "unconfirmed";
        if let (Some(pid), Some(ticks)) = (running.pid, running.start_ticks) {
            if let Some(p) = process_identity(pid) {
                if p.start_ticks == ticks && p.pgid == pid as i32 {
                    let _ = stop_group(&p).await; /* Always unconfirmed: setsid escape cannot be excluded. */
                }
            }
        }
        let artifact_dir = cfg.state.join("artifacts");
        let recover = |value: Option<String>| -> Option<Artifact> {
            let p = PathBuf::from(value?);
            if p.parent() != Some(artifact_dir.as_path()) {
                return None;
            }
            seal(&p).ok()
        };
        let out = recover(running.stdout_path);
        let err = recover(running.stderr_path);
        journal.finish(&running.task.task_id,json!({"status":"UNKNOWN","exit_code":null,"reason":"AGENT_RESTART_DURING_RUNNING_NEVER_RERUN","audit_complete":false,"stdout":out,"stderr":err,"started_at":running.started_at,"finished_at":now_ms(),"cleanup":cleanup}))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn capture_is_bounded_and_reports_overflow() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("out");
        let f = create_capture(&p).unwrap();
        let (tx, mut rx) = mpsc::channel(4);
        capture(&b"abcdefgh"[..], f, Arc::new(AtomicU64::new(0)), 3, tx)
            .await
            .unwrap();
        assert!(matches!(rx.recv().await, Some(CaptureFailure::Limit)));
        assert_eq!(fs::read(p).unwrap(), b"abc");
    }
    #[test]
    fn refuses_reused_pid_identity() {
        let pid = std::process::id();
        let mut p = process_identity(pid).unwrap();
        p.start_ticks += 1;
        assert!(!signal_verified_group(&p, 0));
    }
}

#[cfg(test)]
mod execution_tests {
    use super::*;
    fn setup() -> (tempfile::TempDir, Config, Journal, Task) {
        let d = tempfile::tempdir().unwrap();
        fs::create_dir(d.path().join("artifacts")).unwrap();
        let cfg = Config {
            server: url::Url::parse("https://localhost:8443").unwrap(),
            state: d.path().into(),
            ca_pem: None,
            enrollment_token: None,
            name: "test".into(),
            execution_enabled: true,
            terminal_allow_privilege_escalation: false,
            heartbeat_ms: 2000,
            fault: None,
        };
        let journal = Journal::open(&d.path().join("journal")).unwrap();
        let task = crate::protocol::test_task();
        (d, cfg, journal, task)
    }
    fn result(j: &Journal) -> Value {
        loop {
            let e = j.first_outbox().unwrap().unwrap();
            j.ack(&e.event_id, &e.task_id, e.seq).unwrap();
            if e.kind == "finished" {
                return e.payload;
            }
        }
    }
    #[tokio::test]
    async fn real_process_captures_both_streams_and_nonzero_exit() {
        let (_d, cfg, j, mut t) = setup();
        t.argv = vec![
            "/bin/sh".into(),
            "-c".into(),
            "printf stdout; printf stderr >&2; exit 7".into(),
        ];
        t.payload_hash = t.hash();
        j.accept(&t).unwrap();
        SameUid.execute(&cfg, &j, &t).await.unwrap();
        let r = result(&j);
        assert_eq!(r["status"], "FAILED");
        assert_eq!(r["exit_code"], 7);
        assert_eq!(r["audit_complete"], true);
        assert_eq!(r["cleanup"], "unconfirmed");
        assert_eq!(
            fs::read(cfg.state.join(format!("artifacts/{}.stdout", t.task_id))).unwrap(),
            b"stdout"
        );
        assert_eq!(
            fs::read(cfg.state.join(format!("artifacts/{}.stderr", t.task_id))).unwrap(),
            b"stderr"
        );
    }
    #[tokio::test]
    async fn execution_has_only_allowlisted_environment() {
        let (_d, cfg, j, mut t) = setup();
        t.argv = vec!["/usr/bin/env".into()];
        t.payload_hash = t.hash();
        j.accept(&t).unwrap();
        SameUid.execute(&cfg, &j, &t).await.unwrap();
        let r = result(&j);
        assert_eq!(r["status"], "SUCCEEDED");
        let text =
            fs::read_to_string(cfg.state.join(format!("artifacts/{}.stdout", t.task_id))).unwrap();
        let mut lines: Vec<_> = text.lines().collect();
        lines.sort();
        assert_eq!(
            lines,
            vec!["LANG=C.UTF-8", "LC_ALL=C.UTF-8", "PATH=/usr/bin:/bin"]
        );
    }
    #[tokio::test]
    async fn child_cannot_gain_new_privileges() {
        let (_d, mut cfg, j, mut t) = setup();
        // A terminal-only opt-in must never relax the persistent Exec backend.
        cfg.terminal_allow_privilege_escalation = true;
        t.argv = vec![
            "/bin/sh".into(),
            "-c".into(),
            "grep '^NoNewPrivs:' /proc/self/status".into(),
        ];
        t.payload_hash = t.hash();
        j.accept(&t).unwrap();
        SameUid.execute(&cfg, &j, &t).await.unwrap();
        let r = result(&j);
        assert_eq!(r["status"], "SUCCEEDED");
        assert_eq!(
            fs::read_to_string(cfg.state.join(format!("artifacts/{}.stdout", t.task_id)))
                .unwrap()
                .split_whitespace()
                .collect::<Vec<_>>(),
            vec!["NoNewPrivs:", "1"]
        );
    }
    #[tokio::test]
    async fn output_overflow_stops_child_and_marks_incomplete() {
        let (_d, cfg, j, mut t) = setup();
        t.argv = vec![
            "/bin/sh".into(),
            "-c".into(),
            "while :; do printf abcdef; done".into(),
        ];
        t.max_output_bytes = 32;
        t.payload_hash = t.hash();
        j.accept(&t).unwrap();
        SameUid.execute(&cfg, &j, &t).await.unwrap();
        let r = result(&j);
        assert_eq!(r["status"], "UNKNOWN");
        assert_eq!(r["reason"], "OUTPUT_LIMIT");
        assert_eq!(r["audit_complete"], false);
        assert_eq!(
            r["stdout"]["size"].as_u64().unwrap() + r["stderr"]["size"].as_u64().unwrap(),
            32
        );
    }
    #[tokio::test]
    async fn timeout_kills_regular_fork_child_but_does_not_overclaim() {
        unsafe {
            libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0);
        }
        let (_d, cfg, j, mut t) = setup();
        let pidfile = cfg.state.join("child.pid");
        t.argv = vec![
            "/bin/sh".into(),
            "-c".into(),
            format!("sleep 30 & echo $! > {}; wait", pidfile.display()),
        ];
        t.timeout_ms = 150;
        t.payload_hash = t.hash();
        j.accept(&t).unwrap();
        SameUid.execute(&cfg, &j, &t).await.unwrap();
        let r = result(&j);
        assert_eq!(r["status"], "UNKNOWN");
        assert_eq!(r["reason"], "TIMEOUT_CLEANUP_UNCONFIRMED");
        assert_eq!(r["audit_complete"], false);
        let pid = fs::read_to_string(pidfile).unwrap().trim().parse().unwrap();
        assert!(
            process_identity(pid)
                .map(|p| p.state == 'Z')
                .unwrap_or(true),
            "fork child still running"
        );
    }
    #[tokio::test]
    async fn setsid_escape_is_unconfirmed_and_test_cleans_its_process() {
        unsafe {
            libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0);
        }
        let (_d, cfg, j, mut t) = setup();
        let pidfile = cfg.state.join("escaped.pid");
        // The escape inherits the output FDs, exercising the bounded drain deadline.
        // Its own five-second lifetime is a second safety bound if the test is interrupted.
        t.argv = vec![
            "/bin/sh".into(),
            "-c".into(),
            format!(
                "/usr/bin/setsid /bin/sh -c 'echo $$ > {}; exec /bin/sleep 5 2>/dev/null' & wait",
                pidfile.display()
            ),
        ];
        t.timeout_ms = 150;
        t.payload_hash = t.hash();
        j.accept(&t).unwrap();
        let outcome = SameUid.execute(&cfg, &j, &t).await;
        let pid = fs::read_to_string(&pidfile)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        let escaped = process_identity(pid).expect("bounded setsid child should still be alive");
        struct Cleanup(ProcessIdentity);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                if signal_verified_group(&self.0, libc::SIGKILL) {
                    let mut status = 0;
                    unsafe {
                        libc::waitpid(self.0.pid as i32, &mut status, 0);
                    }
                }
            }
        }
        let cleanup = Cleanup(escaped.clone());
        outcome.unwrap();
        let r = result(&j);
        assert_eq!(r["status"], "UNKNOWN");
        assert_eq!(r["reason"], "TIMEOUT_CLEANUP_UNCONFIRMED");
        assert_eq!(r["cleanup"], "unconfirmed");
        assert_eq!(r["audit_complete"], false);
        assert_ne!(
            escaped.state, 'Z',
            "process group incorrectly claimed setsid containment"
        );
        drop(cleanup);
        assert!(
            process_identity(pid)
                .map(|p| p.state == 'Z')
                .unwrap_or(true),
            "test escape cleanup failed"
        );
    }
    #[tokio::test]
    async fn restart_running_is_unknown_and_never_requeued() {
        let (_d, cfg, j, t) = setup();
        j.accept(&t).unwrap();
        let a = cfg.state.join("artifacts/a");
        let b = cfg.state.join("artifacts/b");
        fs::write(&a, b"crash prefix").unwrap();
        fs::write(&b, b"").unwrap();
        j.start(&t.task_id, &a, &b).unwrap();
        recover_running(&cfg, &j).await.unwrap();
        let r = result(&j);
        assert_eq!(r["status"], "UNKNOWN");
        assert_eq!(r["audit_complete"], false);
        assert_eq!(r["stdout"]["size"], 12);
        assert!(j.next_accepted().unwrap().is_none());
        assert!(j.running().unwrap().is_empty());
        assert!(!j.accept(&t).unwrap());
    }
    #[tokio::test]
    async fn capture_unavailable_never_spawns_and_marks_audit_incomplete() {
        let (_d, cfg, j, mut t) = setup();
        let marker = cfg.state.join("must-not-exist");
        t.argv = vec![
            "/bin/sh".into(),
            "-c".into(),
            format!("touch {}", marker.display()),
        ];
        t.payload_hash = t.hash();
        fs::create_dir(cfg.state.join(format!("artifacts/{}.stdout", t.task_id))).unwrap();
        j.accept(&t).unwrap();
        SameUid.execute(&cfg, &j, &t).await.unwrap();
        let r = result(&j);
        assert_eq!(r["status"], "FAILED");
        assert_eq!(r["reason"], "AUDIT_STORAGE_UNAVAILABLE");
        assert_eq!(r["audit_complete"], false);
        assert_eq!(r["cleanup"], "not_started");
        assert!(!marker.exists());
    }
    #[tokio::test]
    async fn disabled_backend_never_spawns() {
        let (_d, cfg, j, t) = setup();
        j.accept(&t).unwrap();
        Disabled.execute(&cfg, &j, &t).await.unwrap();
        let r = result(&j);
        assert_eq!(r["reason"], "EXECUTION_BACKEND_DISABLED");
        assert_eq!(r["cleanup"], "not_started");
    }
}
