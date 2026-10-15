use anyhow::{bail, ensure, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub const MAX_FRAME: usize = 64 * 1024;
pub const MAX_OUTPUT: u64 = 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Task {
    pub task_id: String,
    pub device_id: String,
    pub actor_id: String,
    pub action: String,
    pub argv: Vec<String>,
    pub cwd: String,
    pub created_at: i64,
    pub expires_at: i64,
    pub timeout_ms: u64,
    pub max_output_bytes: u64,
    pub payload_hash: String,
}
impl Task {
    pub fn hash(&self) -> String {
        let mut value = serde_json::to_value(self).expect("task serialization");
        value.as_object_mut().unwrap().remove("payload_hash");
        // serde_json's default Map is a BTreeMap: recursive lexicographic key order.
        hex::encode(Sha256::digest(serde_json::to_vec(&value).unwrap()))
    }
    pub fn validate(&self, device: &str) -> Result<()> {
        ensure!(
            !self.task_id.is_empty()
                && self.task_id.len() <= 128
                && self
                    .task_id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'),
            "invalid task ID"
        );
        ensure!(self.device_id == device, "task belongs to another device");
        ensure!(
            !self.actor_id.is_empty() && self.actor_id.len() <= 128,
            "invalid actor"
        );
        ensure!(self.action == "exec", "unsupported action");
        ensure!(
            !self.argv.is_empty() && self.argv.len() <= 128,
            "invalid argv length"
        );
        ensure!(
            self.argv
                .iter()
                .all(|x| !x.is_empty() && !x.contains('\0') && x.len() <= 8192),
            "invalid argv"
        );
        ensure!(
            self.argv.iter().map(String::len).sum::<usize>() <= 32 * 1024,
            "argv too large"
        );
        ensure!(
            (self.argv[0].starts_with('/') || !self.argv[0].contains('/'))
                && !self.argv[0].is_empty(),
            "executable must be absolute or a bare name"
        );
        ensure!(
            self.cwd.starts_with('/') && self.cwd.len() <= 4096 && !self.cwd.contains('\0'),
            "invalid cwd"
        );
        ensure!(
            self.created_at > 0 && self.expires_at > self.created_at,
            "invalid task timestamps"
        );
        ensure!(
            self.expires_at <= 9_007_199_254_740_991 && self.created_at <= 9_007_199_254_740_991,
            "timestamps outside interoperable integer range"
        );
        ensure!(
            self.timeout_ms >= 100 && self.timeout_ms <= 3_600_000,
            "invalid timeout"
        );
        ensure!(self.max_output_bytes <= MAX_OUTPUT, "invalid output cap");
        ensure!(
            self.hash() == self.payload_hash,
            "immutable payload hash mismatch"
        );
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Event {
    pub event_id: String,
    pub task_id: String,
    pub seq: i64,
    pub kind: String,
    pub at: i64,
    pub payload: Value,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Envelope {
    pub v: u32,
    pub r#type: String,
    pub body: Value,
}
impl Envelope {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > MAX_FRAME {
            bail!("frame exceeds 64 KiB");
        }
        let env: Self = serde_json::from_slice(bytes)?;
        ensure!(env.v == 1, "unsupported protocol version");
        ensure!(env.body.is_object(), "body must be an object");
        Ok(env)
    }
}
pub fn envelope(kind: &str, body: impl Serialize) -> Result<String> {
    let s = serde_json::to_string(&serde_json::json!({"v": 1, "type": kind, "body": body}))?;
    ensure!(s.len() <= MAX_FRAME, "outgoing frame exceeds limit");
    Ok(s)
}

#[cfg(test)]
pub fn test_task() -> Task {
    let mut t = Task {
        task_id: uuid::Uuid::new_v4().to_string(),
        device_id: "device".into(),
        actor_id: "actor".into(),
        action: "exec".into(),
        argv: vec!["/bin/true".into()],
        cwd: "/tmp".into(),
        created_at: 1,
        expires_at: 9_000_000_000_000,
        timeout_ms: 1000,
        max_output_bytes: 1024,
        payload_hash: String::new(),
    };
    t.payload_hash = t.hash();
    t
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hash_is_stable_and_binds_fields() {
        let mut t = test_task();
        assert_eq!(t.hash(), t.payload_hash);
        t.cwd = "/".into();
        assert!(t.validate("device").is_err());
    }
    #[test]
    fn rejects_wrong_identity_and_unknown_version() {
        assert!(test_task().validate("other").is_err());
        assert!(Envelope::parse(br#"{"v":2,"type":"task.assign","body":{}}"#).is_err());
    }
    #[test]
    fn rejects_injected_task_fields() {
        let mut v = serde_json::to_value(test_task()).unwrap();
        v["uid"] = 0.into();
        assert!(serde_json::from_value::<Task>(v).is_err());
    }
}
