//! Sudo askpass uses an authenticated, session-local Unix socket, never the PTY.
use anyhow::{ensure, Context, Result};
use std::{
    fs::{self, DirBuilder, File},
    io::{Read, Write},
    os::unix::{fs::DirBuilderExt, process::CommandExt},
    path::{Path, PathBuf},
    process::Command,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::UnixListener,
};

pub struct Password(Vec<u8>);
impl Password {
    pub fn new(value: String) -> Result<Self> {
        let secret = Self(value.into_bytes());
        ensure!(
            !secret.0.is_empty()
                && secret.0.len() <= 4096
                && !secret.0.iter().any(|b| [0, 10, 13].contains(b)),
            "invalid sudo password"
        );
        Ok(secret)
    }
}
impl Drop for Password {
    fn drop(&mut self) {
        self.0.fill(0);
    }
}

pub struct Channel {
    listener: UnixListener,
    directory: PathBuf,
    pub path: PathBuf,
    pub username: String,
    uid: u32,
    password: Option<Password>,
}
fn user(name: &str) -> Result<(u32, String)> {
    let name = std::ffi::CString::new(name)?;
    let mut entry: libc::passwd = unsafe { std::mem::zeroed() };
    let mut result = std::ptr::null_mut();
    let mut buffer = vec![0; 16384];
    ensure!(
        unsafe {
            libc::getpwnam_r(
                name.as_ptr(),
                &mut entry,
                buffer.as_mut_ptr().cast(),
                buffer.len(),
                &mut result,
            )
        } == 0
            && !result.is_null(),
        "target account does not exist"
    );
    let home = unsafe { std::ffi::CStr::from_ptr(entry.pw_dir) }
        .to_str()?
        .to_owned();
    Ok((entry.pw_uid, home))
}
fn descendant(mut pid: i32, ancestor: u32) -> bool {
    for _ in 0..32 {
        if pid as u32 == ancestor {
            return true;
        }
        if pid <= 1 {
            return false;
        }
        let Ok(status) = fs::read_to_string(format!("/proc/{pid}/status")) else {
            return false;
        };
        let Some(parent) = status
            .lines()
            .find_map(|l| l.strip_prefix("PPid:").and_then(|v| v.trim().parse().ok()))
        else {
            return false;
        };
        pid = parent;
    }
    false
}
impl Channel {
    pub fn new(username: String, password: Password) -> Result<Self> {
        let (uid, _) = user(&username)?;
        let directory = std::env::temp_dir().join(format!("farhelm-sudo-{}", uuid::Uuid::new_v4()));
        DirBuilder::new().mode(0o700).create(&directory)?;
        let path = directory.join("auth.sock");
        let listener = match UnixListener::bind(&path) {
            Ok(l) => l,
            Err(e) => {
                let _ = fs::remove_dir(&directory);
                return Err(e.into());
            }
        };
        Ok(Self {
            listener,
            directory,
            path,
            username,
            uid,
            password: Some(password),
        })
    }
    pub async fn authenticate(&mut self, sudo_pid: u32) -> Result<()> {
        loop {
            let (mut stream, _) = self.listener.accept().await?;
            let cred = stream.peer_cred()?;
            if !cred.pid().is_some_and(|pid| descendant(pid, sudo_pid)) {
                continue;
            }
            let kind =
                tokio::time::timeout(std::time::Duration::from_secs(1), stream.read_u8()).await??;
            match kind {
                b'P' if cred.uid() == unsafe { libc::getuid() } => {
                    let password = self
                        .password
                        .take()
                        .context("sudo asked for the password again")?;
                    stream.write_all(&password.0).await?;
                    stream.write_all(b"\n").await?;
                    stream.shutdown().await?;
                }
                b'R' if cred.uid() == self.uid => {
                    self.password.take();
                    stream.write_all(b"K").await?;
                    return Ok(());
                }
                _ => anyhow::bail!("invalid sudo authentication peer"),
            }
        }
    }
}
impl Drop for Channel {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
        let _ = fs::remove_dir(&self.directory);
    }
}

// These helper modes return before creating a Tokio runtime or loading Agent credentials.
pub fn helper() -> Option<Result<()>> {
    if std::env::args().nth(1).as_deref() == Some("--sudo-shell") {
        return Some(shell());
    }
    std::env::var_os("FLEET_SUDO_ASKPASS_SOCKET").map(|path| askpass(Path::new(&path)))
}
fn askpass(path: &Path) -> Result<()> {
    let mut stream = std::os::unix::net::UnixStream::connect(path)?;
    stream.set_read_timeout(Some(std::time::Duration::from_secs(5)))?;
    stream.write_all(b"P")?;
    let mut password = Password(Vec::new());
    stream.take(4098).read_to_end(&mut password.0)?;
    ensure!(
        !password.0.is_empty() && password.0.len() <= 4097 && password.0.last() == Some(&b'\n'),
        "sudo credential unavailable"
    );
    std::io::stdout().write_all(&password.0)?;
    Ok(())
}
fn shell() -> Result<()> {
    let args: Vec<_> = std::env::args().collect();
    ensure!(args.len() == 4, "invalid sudo shell request");
    let (uid, home) = user(&args[3])?;
    ensure!(
        unsafe { libc::geteuid() } == uid,
        "sudo did not select the target account"
    );
    let tty = File::options().read(true).write(true).open("/dev/tty")?;
    let shell = if Path::new("/bin/bash").exists() {
        "/bin/bash"
    } else {
        "/bin/sh"
    };
    let mut command = Command::new(shell);
    if shell == "/bin/bash" {
        command.args(["--noprofile", "--norc"]);
    }
    command
        .arg("-i")
        .current_dir(&home)
        .env_clear()
        .env("HOME", home)
        .env("USER", &args[3])
        .env("LOGNAME", &args[3])
        .env("SHELL", shell)
        .env(
            "PATH",
            "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        )
        .env("TERM", "xterm-256color")
        .env("LANG", "C.UTF-8")
        .env(
            "PS1",
            if uid == 0 {
                r"\u@\h:\w\# "
            } else {
                r"\u@\h:\w\$ "
            },
        )
        .stdin(tty.try_clone()?)
        .stdout(tty.try_clone()?)
        .stderr(tty);
    let mut stream = std::os::unix::net::UnixStream::connect(&args[2])?;
    stream.set_read_timeout(Some(std::time::Duration::from_secs(5)))?;
    stream.write_all(b"R")?;
    let mut ack = [0];
    stream.read_exact(&mut ack)?;
    ensure!(ack == *b"K", "sudo session was cancelled");
    drop(stream);
    Err(command.exec().into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_password_delimiters() {
        for value in ["", "a\nb", "a\rb", "a\0b"] {
            assert!(Password::new(value.into()).is_err());
        }
        assert!(Password::new("中文! $'\\password".into()).is_ok());
    }
    #[test]
    fn ancestry_is_bound_to_the_spawned_sudo() {
        assert!(descendant(unsafe { libc::getpid() }, std::process::id()));
        assert!(!descendant(unsafe { libc::getpid() }, u32::MAX));
    }

    #[tokio::test]
    async fn unrelated_process_cannot_request_the_password() {
        let username = unsafe {
            let pw = libc::getpwuid(libc::getuid());
            assert!(!pw.is_null());
            std::ffi::CStr::from_ptr((*pw).pw_name)
                .to_str()
                .unwrap()
                .to_owned()
        };
        let mut channel =
            Channel::new(username, Password::new("fixture-secret".into()).unwrap()).unwrap();
        let path = channel.path.clone();
        let client = tokio::spawn(async move {
            let mut stream = tokio::net::UnixStream::connect(path).await.unwrap();
            // Rejection may close the socket before the untrusted client writes.
            let _ = stream.write_all(b"P").await;
            let mut bytes = Vec::new();
            let _ = tokio::time::timeout(
                std::time::Duration::from_millis(50),
                stream.read_to_end(&mut bytes),
            )
            .await;
            assert!(
                bytes.is_empty(),
                "a different process tree must receive no credential bytes"
            );
        });
        assert!(tokio::time::timeout(
            std::time::Duration::from_millis(75),
            channel.authenticate(u32::MAX)
        )
        .await
        .is_err());
        client.await.unwrap();
    }
}
