// The executor runs one task at a time. Only an explicitly interactive task
// lends its stdin and capture descriptors to the authenticated control channel.
use anyhow::{ensure, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    fs::File,
    os::unix::{fs::FileExt, io::AsRawFd},
    sync::{Arc, Mutex},
};
use tokio::process::ChildStdin;

#[derive(Clone, Default)]
pub struct ScriptIo {
    active: Arc<Mutex<Option<Active>>>,
}
struct Active {
    task: String,
    stdin: ChildStdin,
    stdout: File,
    stderr: File,
    next: u32,
}
pub struct Lease(ScriptIo);
impl Drop for Lease {
    fn drop(&mut self) {
        self.0.active.lock().unwrap().take();
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    request_id: uuid::Uuid,
    task_id: String,
    stdout_offset: u64,
    stderr_offset: u64,
    input: Option<Line>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Line {
    seq: u32,
    text: String,
}

impl ScriptIo {
    pub fn open(&self, task: &str, stdin: ChildStdin, stdout: File, stderr: File) -> Lease {
        *self.active.lock().unwrap() = Some(Active {
            task: task.into(),
            stdin,
            stdout,
            stderr,
            next: 1,
        });
        Lease(self.clone())
    }
    pub fn reply(&self, req: Request) -> Result<Value> {
        let mut state = self.active.lock().unwrap();
        let mut reply = json!({"request_id":req.request_id, "task_id": req.task_id, "next":0,"stdout":"","stderr":""});
        if let Some(run) = state.as_mut().filter(|r| r.task == req.task_id) {
            if let Some(line) = req.input {
                ensure!(
                    line.text.len() <= 1024 && !line.text.contains(['\r', '\n', '\0']),
                    "invalid script answer"
                );
                if line.seq == run.next {
                    let data = format!("{}\n", line.text);
                    // Tokio's pipe is nonblocking. One write <= PIPE_BUF either
                    // queues the whole line atomically or leaves the sequence unchanged.
                    let n = unsafe {
                        libc::write(run.stdin.as_raw_fd(), data.as_ptr().cast(), data.len())
                    };
                    if n == data.len() as isize {
                        run.next += 1;
                        reply["accepted"] = json!(true);
                    }
                }
            }
            reply["next"] = json!(run.next);
            for (name, file, offset) in [
                ("stdout", &run.stdout, req.stdout_offset),
                ("stderr", &run.stderr, req.stderr_offset),
            ] {
                let mut bytes = [0u8; 8192];
                let n = file.read_at(&mut bytes, offset)?;
                reply[name] = json!(STANDARD.encode(&bytes[..n]));
            }
        }
        Ok(reply)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::process::Stdio;
    #[tokio::test]
    async fn reads_by_byte_offset_and_writes_each_answer_once() {
        let io = ScriptIo::default();
        let mut child = tokio::process::Command::new("/bin/cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut capture = tempfile::tempfile().unwrap();
        capture.write_all(b"log:prompt").unwrap();
        let lease = io.open(
            "active",
            child.stdin.take().unwrap(),
            capture,
            tempfile::tempfile().unwrap(),
        );
        let reply = |task: &str, seq: u32| {
            let req =
                serde_json::from_value(json!({"request_id":uuid::Uuid::new_v4(),"task_id":task,
                "stdout_offset":4,"stderr_offset":0,"input":{"seq":seq,"text":"y"}}))
                .unwrap();
            io.reply(req).unwrap()
        };
        assert_eq!(reply("other", 1)["next"], 0);
        let first = reply("active", 1);
        assert_eq!(first["stdout"], STANDARD.encode("prompt"));
        assert_eq!(first["accepted"], true);
        assert_eq!(reply("active", 1)["accepted"], Value::Null);
        drop(lease);
        assert_eq!(reply("active", 2)["next"], 0);
        assert_eq!(child.wait_with_output().await.unwrap().stdout, b"y\n");
    }
}
