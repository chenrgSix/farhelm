//! Ephemeral PTYs: a lost control connection closes shells, never replays input.
use crate::{config::Config, now_ms};
use anyhow::{ensure, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs::File,
    io,
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::{fs::MetadataExt, process::CommandExt},
    },
    process::Stdio,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{
    io::unix::AsyncFd,
    process::{Child, Command},
    sync::mpsc,
    task::JoinHandle,
};

pub type Output = (String, Value);
enum Control {
    Input(Vec<u8>),
    Resize(u16, u16),
    Ack(u64),
    Close,
}
struct Entry {
    input: mpsc::Sender<Control>,
    task: JoinHandle<()>,
}
struct SudoCommands(JoinHandle<Result<()>>);
impl Drop for SudoCommands {
    fn drop(&mut self) {
        self.0.abort();
    }
}
impl Drop for Entry {
    fn drop(&mut self) {
        self.task.abort();
    }
}
pub struct Terminals {
    cfg: Config,
    entries: HashMap<String, Entry>,
    seen: HashSet<String>,
    output: mpsc::Sender<Output>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Open {
    session_id: String,
    cols: u16,
    rows: u16,
    #[serde(default)]
    sudo_password: Option<String>,
    #[serde(default)]
    sudo_auto_password: Option<String>,
    #[serde(default)]
    allow_sudo: Option<bool>,
    #[serde(default)]
    username: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    session_id: String,
    data: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Ack {
    session_id: String,
    seq: u64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Close {
    session_id: String,
}

impl Terminals {
    pub fn is_idle(&self) -> bool {
        self.entries.values().all(|e| e.task.is_finished())
    }
    pub fn set_privilege(&mut self, enabled: bool) -> Result<()> {
        ensure!(self.is_idle(), "terminal sessions are active");
        self.cfg.terminal_allow_privilege_escalation = enabled;
        Ok(())
    }
    pub fn new(cfg: Config, output: mpsc::Sender<Output>) -> Self {
        Self {
            cfg,
            entries: HashMap::new(),
            seen: HashSet::new(),
            output,
        }
    }
    pub async fn receive(&mut self, kind: &str, body: Value) -> Result<()> {
        self.entries.retain(|_, e| !e.task.is_finished());
        if kind == "terminal.open" || kind == "terminal.sudo.open" {
            let mut open: Open = serde_json::from_value(body)?;
            ensure!(
                (kind == "terminal.sudo.open") == open.sudo_password.is_some(),
                "invalid sudo terminal request"
            );
            ensure!(
                kind == "terminal.sudo.open" || open.username.is_none(),
                "unexpected target username"
            );
            let privileged = kind == "terminal.sudo.open";
            ensure!(
                !privileged || open.sudo_auto_password.is_none(),
                "conflicting sudo modes"
            );
            let allow_sudo = open.allow_sudo.unwrap_or(false);
            let auto_sudo = open.sudo_auto_password.is_some();
            if (privileged || auto_sudo) && !allow_sudo {
                self.output
                    .send((
                        "terminal.closed".into(),
                        json!({"session_id":open.session_id,"reason":"SUDO_NOT_AUTHORIZED"}),
                    ))
                    .await?;
                return Ok(());
            }
            let password = open
                .sudo_password
                .take()
                .or_else(|| open.sudo_auto_password.take())
                .filter(|value| !value.is_empty())
                .map(crate::sudo::Password::new)
                .transpose()?;
            ensure!(
                !auto_sudo || password.is_some(),
                "missing automatic sudo credential"
            );
            ensure!(
                uuid::Uuid::parse_str(&open.session_id).is_ok(),
                "invalid terminal ID"
            );
            size(open.cols, open.rows)?;
            if !self.seen.insert(open.session_id.clone()) {
                return Ok(());
            }
            if (privileged || auto_sudo) && !self.cfg.terminal_allow_privilege_escalation {
                self.output
                    .send((
                        "terminal.closed".into(),
                        json!({"session_id":open.session_id,"reason":"SUDO_DISABLED"}),
                    ))
                    .await?;
                return Ok(());
            }
            if !self.cfg.execution_enabled || self.entries.len() >= 4 || self.seen.len() > 1024 {
                self.output
                    .send((
                        "terminal.closed".into(),
                        json!({"session_id":open.session_id,"reason":"TERMINAL_DISABLED_OR_LIMIT"}),
                    ))
                    .await?;
                return Ok(());
            }
            let id = open.session_id.clone();
            let (input, receiver) = mpsc::channel(32);
            let output = self.output.clone();
            let allow_privilege_escalation =
                self.cfg.terminal_allow_privilege_escalation && allow_sudo;
            let task = tokio::spawn(async move {
                let reason = run(
                    &open,
                    receiver,
                    output.clone(),
                    allow_privilege_escalation,
                    password,
                    privileged,
                )
                .await
                .unwrap_or("PTY_FAILURE");
                let _ = output
                    .send((
                        "terminal.closed".into(),
                        json!({"session_id":open.session_id,"reason":reason}),
                    ))
                    .await;
            });
            self.entries.insert(id, Entry { input, task });
            return Ok(());
        }
        let (id, message) = match kind {
            "terminal.input" => {
                let input: Input = serde_json::from_value(body)?;
                ensure!(input.data.len() <= 10924, "terminal input too large");
                let bytes = STANDARD.decode(&input.data)?;
                ensure!(
                    !bytes.is_empty()
                        && bytes.len() <= 8192
                        && STANDARD.encode(&bytes) == input.data,
                    "invalid terminal input"
                );
                (input.session_id, Control::Input(bytes))
            }
            "terminal.resize" => {
                let s: Open = serde_json::from_value(body)?;
                size(s.cols, s.rows)?;
                (s.session_id, Control::Resize(s.cols, s.rows))
            }
            "terminal.ack" => {
                let ack: Ack = serde_json::from_value(body)?;
                (ack.session_id, Control::Ack(ack.seq))
            }
            "terminal.close" => {
                let close: Close = serde_json::from_value(body)?;
                (close.session_id, Control::Close)
            }
            _ => anyhow::bail!("unknown terminal message"),
        };
        if let Some(entry) = self.entries.get(&id) {
            // A full input queue closes only this PTY; it must not block heartbeats.
            if entry.input.try_send(message).is_err() {
                self.entries.remove(&id);
                self.output
                    .send((
                        "terminal.closed".into(),
                        json!({"session_id":id,"reason":"TERMINAL_INPUT_QUEUE_FULL"}),
                    ))
                    .await?;
            }
        }
        Ok(())
    }
}
fn size(cols: u16, rows: u16) -> Result<()> {
    ensure!(
        (20..=500).contains(&cols) && (5..=200).contains(&rows),
        "invalid terminal size"
    );
    Ok(())
}
struct Pty {
    master: Arc<AsyncFd<File>>,
    child: Child,
    pid: u32,
}
impl Drop for Pty {
    fn drop(&mut self) {
        // Job control creates multiple process groups. Cover the Linux session,
        // checking UID and session again before signaling. setsid escapes remain
        // outside this same-UID process boundary, as with the Exec backend.
        if let Ok(entries) = std::fs::read_dir("/proc") {
            for entry in entries.flatten() {
                if let Ok(pid) = entry.file_name().to_string_lossy().parse::<i32>() {
                    let belongs = || -> bool {
                        let Ok(meta) = std::fs::metadata(entry.path()) else {
                            return false;
                        };
                        if meta.uid() != unsafe { libc::geteuid() } {
                            return false;
                        }
                        let Ok(stat) = std::fs::read_to_string(entry.path().join("stat")) else {
                            return false;
                        };
                        stat.rsplit_once(')')
                            .and_then(|(_, s)| s.split_whitespace().nth(3))
                            .and_then(|s| s.parse::<u32>().ok())
                            == Some(self.pid)
                    };
                    if belongs() {
                        unsafe {
                            libc::kill(pid, libc::SIGKILL);
                        }
                    }
                }
            }
        }
        let _ = self.child.start_kill();
    }
}
fn spawn(
    session_id: &str,
    cols: u16,
    rows: u16,
    allow_privilege_escalation: bool,
    sudo: Option<&crate::sudo::Channel>,
    commands: Option<&crate::sudo::Channel>,
) -> Result<Pty> {
    ensure!(
        unsafe { libc::geteuid() } != 0,
        "terminal as root forbidden"
    );
    // Allocate both descriptors with CLOEXEC atomically: Exec can spawn on
    // another thread, so openpty followed by fcntl can leak a slave into an
    // unrelated child and prevent this terminal from reaching EOF.
    let master = unsafe {
        libc::posix_openpt(libc::O_RDWR | libc::O_NOCTTY | libc::O_CLOEXEC | libc::O_NONBLOCK)
    };
    ensure!(master >= 0, "cannot allocate PTY master");
    let master = unsafe { File::from_raw_fd(master) };
    ensure!(
        unsafe { libc::grantpt(master.as_raw_fd()) } == 0
            && unsafe { libc::unlockpt(master.as_raw_fd()) } == 0,
        "cannot prepare PTY slave"
    );
    let mut name = [0 as libc::c_char; 128];
    ensure!(
        unsafe { libc::ptsname_r(master.as_raw_fd(), name.as_mut_ptr(), name.len()) } == 0,
        "cannot resolve PTY slave"
    );
    let slave = unsafe {
        libc::open(
            name.as_ptr(),
            libc::O_RDWR | libc::O_NOCTTY | libc::O_CLOEXEC,
        )
    };
    ensure!(slave >= 0, "cannot open PTY slave");
    let slave = unsafe { File::from_raw_fd(slave) };
    let dimensions = libc::winsize {
        ws_col: cols,
        ws_row: rows,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    ensure!(
        unsafe { libc::ioctl(master.as_raw_fd(), libc::TIOCSWINSZ, &dimensions) } == 0,
        "cannot size PTY"
    );
    let home = std::env::var("HOME")
        .ok()
        .filter(|p| std::fs::read_dir(p).is_ok())
        .unwrap_or_else(|| "/tmp".into());
    let shell = if std::path::Path::new("/bin/bash").exists() {
        "/bin/bash"
    } else {
        "/bin/sh"
    };
    let mut command = Command::new(if sudo.is_some() {
        "/usr/bin/sudo"
    } else {
        shell
    });
    if let Some(sudo) = sudo {
        command
            .args([
                if sudo.needs_password() { "-A" } else { "-n" },
                "-k",
                "-p",
                "",
                "-u",
                &sudo.username,
                "--",
            ])
            .arg(std::env::current_exe()?)
            .arg("--sudo-shell")
            .arg(&sudo.path)
            .arg(&sudo.username)
            .arg(session_id);
    } else if shell == "/bin/bash" {
        command.args(["--noprofile", "--norc"]);
    }
    if sudo.is_none() {
        command.arg("-i");
    }
    command
        .current_dir(&home)
        .env_clear()
        .env("HOME", &home)
        .env("SHELL", shell)
        .env(
            "PS1",
            if shell == "/bin/bash" {
                r"\u@\h:\w\$ "
            } else {
                "${PWD} $ "
            },
        )
        .env("PATH", "/usr/bin:/bin")
        .env("TERM", "xterm-256color")
        .env("LANG", "C.UTF-8")
        .env("LC_ALL", "C.UTF-8")
        .env("FARHELM_COMMAND_TOKEN", session_id)
        .env(
            "PROMPT_COMMAND",
            include_str!("../../lib/terminal-command-hooks.bash"),
        )
        .stdin(Stdio::from(slave.try_clone()?))
        .stdout(Stdio::from(slave.try_clone()?))
        .stderr(Stdio::from(slave))
        .kill_on_drop(true);
    if let Some(sudo) = sudo {
        command
            .env("SUDO_ASKPASS", std::env::current_exe()?)
            .env("FLEET_SUDO_ASKPASS_SOCKET", &sudo.path);
    }
    if let Some(commands) = commands {
        command
            .env(
                "PATH",
                format!("{}:/usr/bin:/bin", commands.command_directory().display()),
            )
            .env("FLEET_SUDO_COMMAND_SOCKET", &commands.path);
    }
    unsafe {
        command.as_std_mut().pre_exec(move || {
            if libc::setsid() == -1
                || libc::ioctl(0, libc::TIOCSCTTY, 0) == -1
                || (!allow_privilege_escalation
                    && libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) == -1)
            {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let child = command.spawn().context("cannot start interactive shell")?;
    let pid = child.id().context("shell PID missing")?;
    Ok(Pty {
        // File owns this nonblocking descriptor for the entire registration.
        master: Arc::new(unsafe { AsyncFd::register(master) }?),
        child,
        pid,
    })
}
async fn read(master: &AsyncFd<File>, buffer: &mut [u8]) -> io::Result<usize> {
    loop {
        let mut guard = master.readable().await?;
        match guard.try_io(|fd| {
            let n = unsafe { libc::read(fd.as_raw_fd(), buffer.as_mut_ptr().cast(), buffer.len()) };
            if n >= 0 {
                Ok(n as usize)
            } else {
                Err(io::Error::last_os_error())
            }
        }) {
            Ok(result) => return result,
            Err(_) => continue,
        }
    }
}
async fn write(master: &AsyncFd<File>, bytes: &[u8]) -> io::Result<usize> {
    loop {
        let mut guard = master.writable().await?;
        match guard.try_io(|fd| {
            let n = unsafe { libc::write(fd.as_raw_fd(), bytes.as_ptr().cast(), bytes.len()) };
            if n >= 0 {
                Ok(n as usize)
            } else {
                Err(io::Error::last_os_error())
            }
        }) {
            Ok(result) => return result,
            Err(_) => continue,
        }
    }
}
async fn run(
    open: &Open,
    mut input: mpsc::Receiver<Control>,
    output: mpsc::Sender<Output>,
    allow_privilege_escalation: bool,
    password: Option<crate::sudo::Password>,
    privileged: bool,
) -> Result<&'static str> {
    let (mut channel, commands) = if privileged {
        (
            Some(crate::sudo::Channel::new(
                open.username.clone().unwrap_or_else(|| "root".into()),
                password,
            )?),
            None,
        )
    } else {
        (
            None,
            password.map(crate::sudo::Channel::commands).transpose()?,
        )
    };
    let mut pty = match spawn(
        &open.session_id,
        open.cols,
        open.rows,
        allow_privilege_escalation,
        channel.as_ref(),
        commands.as_ref(),
    ) {
        Ok(pty) => pty,
        Err(_) if channel.is_some() => return Ok("SUDO_AUTH_FAILED"),
        Err(error) => return Err(error),
    };
    if let Some(channel) = &mut channel {
        tokio::select! {
            result = tokio::time::timeout(Duration::from_secs(15), channel.authenticate(pty.pid)) => match result {
                Ok(Ok(())) => {}, Ok(Err(_)) => return Ok("SUDO_AUTH_FAILED"), Err(_) => return Ok("SUDO_AUTH_TIMEOUT"),
            },
            _ = pty.child.wait() => return Ok("SUDO_AUTH_FAILED"),
            _ = input.recv() => return Ok("CONTROL_CLOSED"),
        }
    }
    drop(channel);
    let commands = commands.map(|mut channel| {
        let pid = pty.pid;
        SudoCommands(tokio::spawn(
            async move { channel.serve_commands(pid).await },
        ))
    });
    output
        .send((
            "terminal.opened".into(),
            json!({"session_id":open.session_id}),
        ))
        .await?;
    let mut buffer = [0u8; 4096];
    let mut queue = VecDeque::<u8>::new();
    let mut seq = 0u64;
    let mut pending = None::<Instant>;
    let start = now_ms();
    let mut timer = tokio::time::interval(Duration::from_millis(250));
    loop {
        let writing: Vec<u8> = queue.iter().take(8192).copied().collect();
        tokio::select! {
            message = input.recv() => match message {
                Some(Control::Input(bytes)) => { ensure!(queue.len()+bytes.len() <= 65536,"terminal input queue exceeded"); queue.extend(bytes); }
                Some(Control::Resize(cols,rows)) => {
                    let dimensions = libc::winsize { ws_col:cols,ws_row:rows,ws_xpixel:0,ws_ypixel:0 };
                    ensure!(unsafe { libc::ioctl(pty.master.as_raw_fd(),libc::TIOCSWINSZ,&dimensions) } == 0,"cannot resize PTY");
                }
                Some(Control::Ack(ack)) => { ensure!(pending.is_some() && ack==seq,"terminal ACK mismatch"); pending=None; }
                Some(Control::Close) | None => return Ok("CONTROL_CLOSED"),
            },
            result = read(&pty.master,&mut buffer), if pending.is_none() => {
                let count = match result { Ok(0)=>return Ok("SHELL_EXIT"),Ok(n)=>n,Err(e) if e.raw_os_error()==Some(libc::EIO)=>return Ok("SHELL_EXIT"),Err(e)=>return Err(e.into()) };
                seq += 1;
                output.send(("terminal.output".into(),json!({"session_id":open.session_id,"seq":seq,"data":STANDARD.encode(&buffer[..count])}))).await?;
                pending=Some(Instant::now());
            },
            result = write(&pty.master,&writing), if !writing.is_empty() => { let count=result?; ensure!(count>0,"PTY write returned zero"); queue.drain(..count); },
            _=timer.tick()=>{
                if commands.as_ref().is_some_and(|task| task.0.is_finished()) { return Ok("SUDO_AUTH_FAILED"); }
                if pending.is_some_and(|time| time.elapsed()>Duration::from_secs(10)) { return Ok("RECORDING_ACK_TIMEOUT"); }
                if now_ms()-start>3_600_000 { return Ok("SESSION_EXPIRED"); }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn sudo_cannot_bypass_the_local_opt_in_or_use_normal_terminal_frames() {
        let temp = tempfile::tempdir().unwrap();
        let cfg = Config {
            connect_ip: None,
            server: url::Url::parse("https://localhost:8444").unwrap(),
            state: temp.path().into(),
            ca_pem: None,
            enrollment_token: None,
            name: "sudo-disabled".into(),
            execution_enabled: true,
            terminal_allow_privilege_escalation: false,
            heartbeat_ms: 1000,
            fault: None,
        };
        let (output, mut events) = mpsc::channel(8);
        let mut terminals = Terminals::new(cfg, output);
        let body = json!({"session_id":uuid::Uuid::new_v4().to_string(),"cols":80,"rows":24,"allow_sudo":true,"username":"root","sudo_password":"public-test-password"});
        assert!(terminals
            .receive("terminal.open", body.clone())
            .await
            .is_err());
        terminals.receive("terminal.sudo.open", body).await.unwrap();
        let (kind, body) = events.recv().await.unwrap();
        assert_eq!(kind, "terminal.closed");
        assert_eq!(body["reason"], "SUDO_DISABLED");
        assert!(!body.to_string().contains("public-test-password"));
        terminals.receive("terminal.sudo.open", json!({"session_id":uuid::Uuid::new_v4().to_string(),"cols":80,"rows":24,"allow_sudo":true,"username":"root","sudo_password":""})).await.unwrap();
        let (_, body) = events.recv().await.unwrap();
        assert_eq!(body["reason"], "SUDO_DISABLED");
    }

    async fn input(manager: &mut Terminals, id: &str, text: &str) {
        manager
            .receive(
                "terminal.input",
                json!({"session_id":id,"data":STANDARD.encode(text)}),
            )
            .await
            .unwrap();
    }
    async fn until(
        manager: &mut Terminals,
        events: &mut mpsc::Receiver<Output>,
        needle: &str,
    ) -> String {
        let mut all = Vec::new();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let (kind, body) = events.recv().await.unwrap();
                if kind == "terminal.output" {
                    all.extend(STANDARD.decode(body["data"].as_str().unwrap()).unwrap());
                    manager
                        .receive(
                            "terminal.ack",
                            json!({"session_id":body["session_id"],"seq":body["seq"]}),
                        )
                        .await
                        .unwrap();
                    let decoded = String::from_utf8_lossy(&all);
                    if let Some((_, tail)) = decoded.rsplit_once(needle) {
                        // Wait for readline to restore its prompt before the
                        // next test command. The foreground sleep deliberately
                        // has no prompt until Ctrl-C.
                        if needle == "^WAIT^" || tail.trim_end().ends_with('$') {
                            break;
                        }
                    }
                } else {
                    assert_eq!(kind, "terminal.opened", "unexpected PTY close: {body}");
                }
            }
        })
        .await
        .unwrap_or_else(|error| {
            panic!(
                "PTY output timeout for {needle}: {error}; captured={:?}",
                String::from_utf8_lossy(&all)
            )
        });
        String::from_utf8(all).unwrap()
    }
    #[tokio::test]
    async fn real_pty_keeps_cwd_resizes_supports_unicode_and_ctrl_c() {
        let temp = tempfile::tempdir().unwrap();
        let cfg = Config {
            connect_ip: None,
            server: url::Url::parse("https://localhost:8443").unwrap(),
            state: temp.path().into(),
            ca_pem: None,
            enrollment_token: None,
            name: "pty-test".into(),
            execution_enabled: true,
            terminal_allow_privilege_escalation: false,
            heartbeat_ms: 2000,
            fault: None,
        };
        let (output, mut events) = mpsc::channel(32);
        let mut manager = Terminals::new(cfg, output);
        let id = uuid::Uuid::new_v4().to_string();
        manager
            .receive(
                "terminal.open",
                json!({"session_id":id,"cols":80,"rows":24}),
            )
            .await
            .unwrap();
        input(
            &mut manager,
            &id,
            "stty -echo;printf '\\136READY\\136\\n'\r",
        )
        .await;
        until(&mut manager, &mut events, "^READY^").await;
        manager
            .receive(
                "terminal.resize",
                json!({"session_id":id,"cols":100,"rows":31}),
            )
            .await
            .unwrap();
        input(
            &mut manager,
            &id,
            "test -t 0 && printf 'REAL_TTY\\n'; stty size; cd /tmp; printf '\\136END\\136\\n'\r",
        )
        .await;
        let result = until(&mut manager, &mut events, "^END^").await;
        assert!(result.contains("REAL_TTY\r\n"), "{result}");
        assert!(result.contains("31 100\r\n"), "{result}");
        input(&mut manager,&id,"pwd;printf '终端中文\\n';grep '^NoNewPrivs:' /proc/self/status;printf '\\136DONE\\136\\n'\r").await;
        let result = until(&mut manager, &mut events, "^DONE^").await;
        assert!(result.contains("/tmp\r\n"), "{result}");
        assert!(result.contains("终端中文\r\n"), "{result}");
        assert!(result.contains("NoNewPrivs:\t1"), "{result}");
        // The marker comes from the foreground child, after job control has
        // assigned its process group; printing it in the parent races Ctrl-C.
        input(
            &mut manager,
            &id,
            "/bin/sh -c \"printf '\\136WAIT\\136\\n';exec sleep 30\"\r",
        )
        .await;
        until(&mut manager, &mut events, "^WAIT^").await;
        input(&mut manager, &id, "\x03").await;
        input(&mut manager, &id, "printf '\\136INTERRUPTED\\136\\n'\r").await;
        until(&mut manager, &mut events, "^INTERRUPTED^").await;
        input(&mut manager, &id, "exit\r").await;
        let (kind, body) = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let (kind, body) = events.recv().await.unwrap();
                if kind == "terminal.output" {
                    manager
                        .receive("terminal.ack", json!({"session_id":id,"seq":body["seq"]}))
                        .await
                        .unwrap();
                } else {
                    break (kind, body);
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(kind, "terminal.closed");
        assert_eq!(body["reason"], "SHELL_EXIT");
    }
    #[tokio::test]
    async fn explicit_terminal_opt_in_allows_existing_sudo_policy() {
        let temp = tempfile::tempdir().unwrap();
        let cfg = Config {
            connect_ip: None,
            server: url::Url::parse("https://localhost:8443").unwrap(),
            state: temp.path().into(),
            ca_pem: None,
            enrollment_token: None,
            name: "sudo-pty-test".into(),
            execution_enabled: true,
            terminal_allow_privilege_escalation: true,
            heartbeat_ms: 2000,
            fault: None,
        };
        let (output, mut events) = mpsc::channel(32);
        let mut manager = Terminals::new(cfg, output);
        let id = uuid::Uuid::new_v4().to_string();
        manager
            .receive(
                "terminal.open",
                json!({"session_id":id,"cols":80,"rows":24,"allow_sudo":true}),
            )
            .await
            .unwrap();
        input(
            &mut manager,
            &id,
            "stty -echo;printf '\\136READY\\136\\n'\r",
        )
        .await;
        until(&mut manager, &mut events, "^READY^").await;
        input(
            &mut manager,
            &id,
            "grep '^NoNewPrivs:' /proc/self/status;printf '\\136SUDO_POLICY\\136\\n'\r",
        )
        .await;
        let result = until(&mut manager, &mut events, "^SUDO_POLICY^").await;
        assert!(result.contains("NoNewPrivs:\t0"), "{result}");
        manager
            .receive("terminal.close", json!({"session_id":id}))
            .await
            .unwrap();
    }
}
