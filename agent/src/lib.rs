#![cfg(target_os = "linux")]
pub mod address;
pub mod config;
pub mod connection;
pub mod executor;
pub mod health;
pub mod identity;
pub mod journal;
pub mod network;
pub mod network_probes;
pub mod protocol;
pub mod terminal;
pub mod upgrade;

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock predates Unix epoch")
        .as_millis() as i64
}
