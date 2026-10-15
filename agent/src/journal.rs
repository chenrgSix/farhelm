use crate::{
    now_ms,
    protocol::{Event, Task},
};
use anyhow::{ensure, Result};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::{json, Value};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::Path,
    sync::{Arc, Mutex},
};

#[derive(Clone)]
pub struct Journal(Arc<Mutex<Connection>>);
#[derive(Clone, Debug)]
pub struct Running {
    pub task: Task,
    pub started_at: Option<i64>,
    pub pid: Option<u32>,
    pub start_ticks: Option<u64>,
    pub stdout_path: Option<String>,
    pub stderr_path: Option<String>,
}
impl Journal {
    pub fn open(path: &Path) -> Result<Self> {
        if path.exists() {
            ensure!(
                !fs::symlink_metadata(path)?.file_type().is_symlink(),
                "journal cannot be a symlink"
            );
        }
        let c = Connection::open(path)?;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
        c.busy_timeout(std::time::Duration::from_secs(5))?;
        c.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
          CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS tasks(task_id TEXT PRIMARY KEY,payload_hash TEXT NOT NULL,request TEXT NOT NULL,status TEXT NOT NULL,seq INTEGER NOT NULL DEFAULT 0,cancel_requested INTEGER NOT NULL DEFAULT 0,started_at INTEGER,pid INTEGER,start_ticks INTEGER,stdout_path TEXT,stderr_path TEXT,result TEXT);
          CREATE TABLE IF NOT EXISTS outbox(event_id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(task_id),seq INTEGER NOT NULL,event TEXT NOT NULL,UNIQUE(task_id,seq));
          CREATE TABLE IF NOT EXISTS local_audit(id INTEGER PRIMARY KEY,at INTEGER NOT NULL,task_id TEXT,kind TEXT NOT NULL,detail TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS network_events(event_id TEXT PRIMARY KEY,event TEXT NOT NULL,complete INTEGER NOT NULL,acked INTEGER NOT NULL DEFAULT 0);")?;
        Ok(Self(Arc::new(Mutex::new(c))))
    }
    pub fn metadata(&self, key: &str) -> Result<Option<String>> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .query_row("SELECT value FROM metadata WHERE key=?", [key], |r| {
                r.get(0)
            })
            .optional()?)
    }
    pub fn set_metadata(&self, key: &str, value: &str) -> Result<()> {
        let c = self.0.lock().unwrap();
        let existing: Option<String> = c
            .query_row("SELECT value FROM metadata WHERE key=?", [key], |r| {
                r.get(0)
            })
            .optional()?;
        if let Some(old) = existing {
            ensure!(old == value, "immutable identity metadata changed");
        } else {
            c.execute(
                "INSERT INTO metadata(key,value) VALUES(?,?)",
                params![key, value],
            )?;
        }
        Ok(())
    }
    pub fn set_platform_address(&self, value: &str) -> Result<()> {
        self.0.lock().unwrap().execute("INSERT INTO metadata(key,value) VALUES('platform_address',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[value])?;
        Ok(())
    }
    pub fn network_save(&self, state: &str, event: Option<&crate::network::Event>) -> Result<()> {
        let mut c = self.0.lock().unwrap();
        let tx = c.transaction()?;
        tx.execute("INSERT INTO metadata(key,value) VALUES('network_state',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[state])?;
        if let Some(e) = event {
            tx.execute("INSERT INTO network_events(event_id,event,complete) VALUES(?,?,?) ON CONFLICT(event_id) DO UPDATE SET event=excluded.event,complete=excluded.complete",params![e.event_id,serde_json::to_string(e)?,e.recovered_at.is_some()])?;
        }
        // Retain the newest 1,000 local observations; never prune unacknowledged records.
        tx.execute("DELETE FROM network_events WHERE acked=1 AND rowid NOT IN (SELECT rowid FROM network_events ORDER BY rowid DESC LIMIT 1000)",[])?;
        tx.commit()?;
        Ok(())
    }
    pub fn network_first(&self) -> Result<Option<crate::network::Event>> {
        let raw: Option<String> = self.0.lock().unwrap().query_row("SELECT event FROM network_events WHERE complete=1 AND acked=0 ORDER BY rowid LIMIT 1",[],|r|r.get(0)).optional()?;
        Ok(raw.map(|s| serde_json::from_str(&s)).transpose()?)
    }
    pub fn network_ack(&self, id: &str) -> Result<()> {
        self.0.lock().unwrap().execute(
            "UPDATE network_events SET acked=1 WHERE event_id=? AND complete=1",
            [id],
        )?;
        Ok(())
    }
    pub fn set_upgrade(&self, state: &str, release: Option<&str>) -> Result<()> {
        let mut c = self.0.lock().unwrap();
        let tx = c.transaction()?;
        tx.execute("INSERT INTO metadata(key,value) VALUES('agent_upgrade',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[state])?;
        if let Some(value) = release {
            tx.execute("INSERT INTO metadata(key,value) VALUES('agent_release',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[value])?;
        }
        tx.commit()?;
        Ok(())
    }
    pub fn upgrade_idle(&self) -> Result<bool> {
        Ok(self.0.lock().unwrap().query_row("SELECT NOT EXISTS(SELECT 1 FROM tasks WHERE status IN ('ACCEPTED','RUNNING')) AND NOT EXISTS(SELECT 1 FROM outbox)",[],|r|r.get(0))?)
    }
    pub fn accept(&self, t: &Task) -> Result<bool> {
        let mut c = self.0.lock().unwrap();
        let tx = c.transaction()?;
        let existing: Option<String> = tx
            .query_row(
                "SELECT payload_hash FROM tasks WHERE task_id=?",
                [&t.task_id],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(hash) = existing {
            if hash != t.payload_hash {
                tx.execute(
                    "INSERT INTO local_audit(at,task_id,kind,detail) VALUES(?,?,?,?)",
                    params![
                        now_ms(),
                        t.task_id,
                        "PAYLOAD_CONFLICT",
                        "same task ID with different payload"
                    ],
                )?;
                tx.commit()?;
                anyhow::bail!("same task ID with different immutable payload");
            }
            return Ok(false);
        }
        tx.execute(
            "INSERT INTO tasks(task_id,payload_hash,request,status) VALUES(?,?,?,'ACCEPTED')",
            params![t.task_id, t.payload_hash, serde_json::to_string(t)?],
        )?;
        append(&tx, &t.task_id, "accepted", json!({}))?;
        tx.commit()?;
        Ok(true)
    }
    pub fn next_accepted(&self) -> Result<Option<Task>> {
        let c = self.0.lock().unwrap();
        let s: Option<String> = c
            .query_row(
                "SELECT request FROM tasks WHERE status='ACCEPTED' ORDER BY rowid LIMIT 1",
                [],
                |r| r.get(0),
            )
            .optional()?;
        Ok(s.map(|s| serde_json::from_str(&s)).transpose()?)
    }
    pub fn cancelled(&self, id: &str) -> Result<bool> {
        Ok(self.0.lock().unwrap().query_row(
            "SELECT cancel_requested FROM tasks WHERE task_id=?",
            [id],
            |r| r.get::<_, bool>(0),
        )?)
    }
    pub fn cancel(&self, id: &str) -> Result<()> {
        self.0.lock().unwrap().execute("UPDATE tasks SET cancel_requested=1 WHERE task_id=? AND status IN ('ACCEPTED','RUNNING')",[id])?;
        Ok(())
    }
    pub fn start(&self, id: &str, stdout: &Path, stderr: &Path) -> Result<i64> {
        let mut c = self.0.lock().unwrap();
        let tx = c.transaction()?;
        let now = now_ms();
        ensure!(tx.execute("UPDATE tasks SET status='RUNNING',started_at=?,stdout_path=?,stderr_path=? WHERE task_id=? AND status='ACCEPTED'",params![now,stdout.to_string_lossy(),stderr.to_string_lossy(),id])?==1,"task not in accepted state");
        append(&tx, id, "started", json!({}))?;
        tx.commit()?;
        Ok(now)
    }
    pub fn set_process(&self, id: &str, pid: u32, start_ticks: u64) -> Result<()> {
        ensure!(
            self.0.lock().unwrap().execute(
                "UPDATE tasks SET pid=?,start_ticks=? WHERE task_id=? AND status='RUNNING'",
                params![pid, start_ticks, id]
            )? == 1,
            "cannot attach process to inactive task"
        );
        Ok(())
    }
    pub fn finish(&self, id: &str, payload: Value) -> Result<()> {
        let mut c = self.0.lock().unwrap();
        let tx = c.transaction()?;
        let status = payload
            .get("status")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("missing result status"))?;
        ensure!(
            matches!(
                status,
                "SUCCEEDED" | "FAILED" | "TIMED_OUT" | "CANCELLED" | "EXPIRED" | "UNKNOWN"
            ),
            "invalid terminal state"
        );
        ensure!(tx.execute("UPDATE tasks SET status=?,result=? WHERE task_id=? AND status IN ('ACCEPTED','RUNNING')",params![status,serde_json::to_string(&payload)?,id])?==1,"task already terminal or missing");
        append(&tx, id, "finished", payload)?;
        tx.commit()?;
        Ok(())
    }
    pub fn first_outbox(&self) -> Result<Option<Event>> {
        let c = self.0.lock().unwrap();
        let e: Option<String> = c
            .query_row("SELECT event FROM outbox ORDER BY rowid LIMIT 1", [], |r| {
                r.get(0)
            })
            .optional()?;
        Ok(e.map(|x| serde_json::from_str(&x)).transpose()?)
    }
    pub fn ack(&self, event_id: &str, task_id: &str, seq: i64) -> Result<bool> {
        Ok(self.0.lock().unwrap().execute(
            "DELETE FROM outbox WHERE event_id=? AND task_id=? AND seq=?",
            params![event_id, task_id, seq],
        )? == 1)
    }
    pub fn running(&self) -> Result<Vec<Running>> {
        let c = self.0.lock().unwrap();
        let mut q=c.prepare("SELECT request,started_at,pid,start_ticks,stdout_path,stderr_path FROM tasks WHERE status='RUNNING'")?;
        let rows = q.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
            ))
        })?;
        let mut result = Vec::new();
        for row in rows {
            let (s, started_at, pid, start_ticks, stdout_path, stderr_path) = row?;
            result.push(Running {
                task: serde_json::from_str(&s)?,
                started_at,
                pid,
                start_ticks,
                stdout_path,
                stderr_path,
            });
        }
        Ok(result)
    }
    pub fn artifacts(&self, id: &str) -> Result<(Option<String>, Option<String>)> {
        Ok(self.0.lock().unwrap().query_row(
            "SELECT stdout_path,stderr_path FROM tasks WHERE task_id=?",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?)
    }
    pub fn audit(&self, id: &str, kind: &str, detail: &str) -> Result<()> {
        self.0.lock().unwrap().execute(
            "INSERT INTO local_audit(at,task_id,kind,detail) VALUES(?,?,?,?)",
            params![now_ms(), id, kind, detail],
        )?;
        Ok(())
    }
    #[cfg(test)]
    pub fn status(&self, id: &str) -> String {
        self.0
            .lock()
            .unwrap()
            .query_row("SELECT status FROM tasks WHERE task_id=?", [id], |r| {
                r.get(0)
            })
            .unwrap()
    }
}
fn append(tx: &Transaction<'_>, id: &str, kind: &str, payload: Value) -> Result<()> {
    tx.execute("UPDATE tasks SET seq=seq+1 WHERE task_id=?", [id])?;
    let seq = tx.query_row("SELECT seq FROM tasks WHERE task_id=?", [id], |r| r.get(0))?;
    let event = Event {
        event_id: uuid::Uuid::new_v4().to_string(),
        task_id: id.into(),
        seq,
        kind: kind.into(),
        at: now_ms(),
        payload,
    };
    tx.execute(
        "INSERT INTO outbox(event_id,task_id,seq,event) VALUES(?,?,?,?)",
        params![event.event_id, id, seq, serde_json::to_string(&event)?],
    )?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn durable_dedupe_and_ack_identity() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("journal");
        let j = Journal::open(&path).unwrap();
        let t = crate::protocol::test_task();
        assert!(j.accept(&t).unwrap());
        assert!(!j.accept(&t).unwrap());
        let e = j.first_outbox().unwrap().unwrap();
        assert!(!j.ack(&e.event_id, "wrong", e.seq).unwrap());
        assert!(j.ack(&e.event_id, &t.task_id, e.seq).unwrap());
        drop(j);
        let j = Journal::open(&path).unwrap();
        assert!(!j.accept(&t).unwrap());
        assert!(j.first_outbox().unwrap().is_none());
        let mut altered = t.clone();
        altered.cwd = "/".into();
        altered.payload_hash = altered.hash();
        assert!(j.accept(&altered).is_err());
    }
    #[test]
    fn state_and_events_are_atomic_and_monotonic() {
        let d = tempfile::tempdir().unwrap();
        let j = Journal::open(&d.path().join("db")).unwrap();
        let t = crate::protocol::test_task();
        j.accept(&t).unwrap();
        j.start(&t.task_id, Path::new("/stdout"), Path::new("/stderr"))
            .unwrap();
        j.finish(&t.task_id, json!({"status":"UNKNOWN"})).unwrap();
        assert!(j
            .start(&t.task_id, Path::new("/a"), Path::new("/b"))
            .is_err());
        for seq in 1..=3 {
            let e = j.first_outbox().unwrap().unwrap();
            assert_eq!(e.seq, seq);
            j.ack(&e.event_id, &e.task_id, e.seq).unwrap();
        }
        assert_eq!(j.status(&t.task_id), "UNKNOWN");
    }
}
