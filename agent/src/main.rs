use anyhow::Result;
use fleet_agent::{config::Config, connection, executor, identity::Identity, journal::Journal};

#[tokio::main]
async fn main() -> Result<()> {
    // One crypto provider for both HTTP and WebSocket rustls transports.
    let _ = rustls::crypto::ring::default_provider().install_default();
    // Private files include SQLite WAL/SHM and output captures, not only the key.
    unsafe {
        libc::umask(0o077);
    }
    anyhow::ensure!(
        unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) } == 0,
        "cannot enable child reaping"
    );
    let cfg = Config::from_env()?;
    let _instance_lock = cfg.prepare_state()?;
    let identity = Identity::load_or_create(&cfg.state)?;
    let journal = Journal::open(&cfg.state.join("journal.sqlite3"))?;
    fleet_agent::config::sync_dir(&cfg.state)?;
    let execution = tokio::spawn(executor::scheduler(cfg.clone(), journal.clone()));
    tokio::select! {
        result=connection::run(cfg,journal,identity)=>result,
        result=execution=>{result??;anyhow::bail!("execution scheduler stopped unexpectedly")},
    }
}
