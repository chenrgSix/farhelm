//! Read-only EasyTier observation in the collector's actual network namespace.
use anyhow::{ensure, Result};
use serde_json::{json, Value};
use std::{net::IpAddr, process::Stdio, time::Duration};
use tokio::{io::AsyncReadExt, process::Command};

#[derive(Clone, Debug, PartialEq)]
pub struct Config {
    pub cli: String,
    pub rpc: String,
    pub container: Option<String>,
}
impl Config {
    pub fn new(cli: &str, rpc: &str, container: Option<&str>) -> Result<Self> {
        let cli = if cli.is_empty() { "easytier-cli" } else { cli };
        let rpc = if rpc.is_empty() {
            "127.0.0.1:15888"
        } else {
            rpc
        };
        let container = container.filter(|v| !v.is_empty());
        let name = |v: &str| {
            v.as_bytes().first().is_some_and(u8::is_ascii_alphanumeric)
                && v.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
        };
        ensure!(
            cli.len() <= 4096
                && !cli.bytes().any(|b| b < 32 || b == 127)
                && (cli.starts_with('/') || name(cli)),
            "invalid FLEET_EASYTIER_CLI"
        );
        let endpoint = rpc.rsplit_once(':');
        ensure!(
            endpoint.is_some() && rpc.len() <= 260,
            "invalid FLEET_EASYTIER_RPC"
        );
        let (host, port) = endpoint.unwrap();
        let host_ok = if host.starts_with('[') && host.ends_with(']') {
            host[1..host.len() - 1]
                .parse::<std::net::Ipv6Addr>()
                .is_ok()
        } else {
            host.as_bytes()
                .first()
                .is_some_and(u8::is_ascii_alphanumeric)
                && host
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b".-".contains(&b))
        };
        ensure!(
            host_ok
                && !port.is_empty()
                && port.len() <= 5
                && port.bytes().all(|b| b.is_ascii_digit())
                && port.parse::<u16>().is_ok_and(|v| v > 0),
            "invalid FLEET_EASYTIER_RPC"
        );
        ensure!(
            container.is_none_or(|v| v.len() <= 128 && name(v)),
            "invalid FLEET_EASYTIER_CONTAINER"
        );
        Ok(Self {
            cli: cli.into(),
            rpc: rpc.into(),
            container: container.map(str::to_owned),
        })
    }
    pub fn from_env() -> Result<Self> {
        let get = |key| match std::env::var(key) {
            Ok(v) => Ok(v),
            Err(std::env::VarError::NotPresent) => Ok(String::new()),
            Err(e) => Err(e),
        };
        Self::new(
            &get("FLEET_EASYTIER_CLI")?,
            &get("FLEET_EASYTIER_RPC")?,
            Some(&get("FLEET_EASYTIER_CONTAINER")?),
        )
    }
    fn docker_args(&self, command: &[&str]) -> Vec<String> {
        let mut args = vec![
            "exec".into(),
            "--user".into(),
            format!("{}:{}", unsafe { libc::geteuid() }, unsafe {
                libc::getegid()
            }),
            self.container.as_ref().unwrap().clone(),
            "timeout".into(),
            "-s".into(),
            "KILL".into(),
            "2".into(),
        ];
        args.extend(command.iter().map(|s| (*s).to_owned()));
        args
    }
    fn route_command(&self) -> (String, Vec<String>) {
        let args = ["--rpc-portal", &self.rpc, "--output", "json", "route"];
        if self.container.is_some() {
            // The inner timeout also terminates the container process if the
            // Docker client is killed/disconnected. Never request elevated UID/caps.
            let mut command = vec![self.cli.as_str()];
            command.extend(args);
            ("docker".into(), self.docker_args(&command))
        } else {
            (
                self.cli.clone(),
                args.into_iter().map(str::to_owned).collect(),
            )
        }
    }
}
async fn command_output(program: &str, args: &[String]) -> Result<String> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()?;
    let timeout = if program == "docker" { 4000 } else { 1500 };
    tokio::time::timeout(Duration::from_millis(timeout), async {
        let mut bytes = Vec::new();
        child
            .stdout
            .take()
            .unwrap()
            .take(1_048_577)
            .read_to_end(&mut bytes)
            .await?;
        ensure!(bytes.len() <= 1_048_576, "diagnostic output too large");
        ensure!(child.wait().await?.success(), "diagnostic unavailable");
        Ok::<_, anyhow::Error>(String::from_utf8(bytes)?)
    })
    .await?
}
async fn verify_namespace(config: &Config) -> Result<()> {
    let boot = tokio::fs::read_to_string("/proc/sys/kernel/random/boot_id").await?;
    let net = tokio::fs::read_link("/proc/self/ns/net").await?;
    let remote_boot = command_output(
        "docker",
        &config.docker_args(&["cat", "/proc/sys/kernel/random/boot_id"]),
    )
    .await?;
    let remote_net = command_output(
        "docker",
        &config.docker_args(&["readlink", "/proc/self/ns/net"]),
    )
    .await?;
    ensure!(
        !boot.trim().is_empty()
            && boot.trim() == remote_boot.trim()
            && net.to_str() == Some(remote_net.trim()),
        "different Docker network namespace"
    );
    Ok(())
}
async fn routes(config: &Config) -> Result<Value> {
    if config.container.is_some() {
        verify_namespace(config).await?;
    }
    let (program, args) = config.route_command();
    Ok(serde_json::from_str(
        &command_output(&program, &args).await?,
    )?)
}
pub async fn observe(target: &str) -> Value {
    let unknown = json!({"state":"unknown","latency_ms":null});
    if target.parse::<IpAddr>().is_err() {
        return unknown;
    }
    let Ok(config) = Config::from_env() else {
        return unknown;
    };
    let routes = match routes(&config).await {
        Ok(routes) => routes,
        Err(e) => {
            return json!({"state":if e.downcast_ref::<std::io::Error>()
                .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound) {"not_detected"} else {"unknown"}, "latency_ms":null});
        }
    };
    let args = ["-j", "route", "get", target].map(str::to_owned);
    let Ok(output) = command_output("ip", &args).await else {
        return unknown;
    };
    let Ok(os) = serde_json::from_str::<Value>(&output) else {
        return unknown;
    };
    let Some(rows) = os.as_array().filter(|rows| rows.len() == 1) else {
        return unknown;
    };
    let Some(dev) = rows[0]["dev"].as_str() else {
        return unknown;
    };
    let Ok(addresses) = crate::network::addresses() else {
        return unknown;
    };
    crate::routes::parse_easytier(
        &routes,
        target,
        &addresses
            .into_iter()
            .filter(|a| a.interface == dev && a.up)
            .map(|a| a.address)
            .collect::<Vec<_>>(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn config_accepts_executable_paths_and_rpc_but_not_commands_or_docker_options() {
        let default = Config::new("", "", None).unwrap();
        assert_eq!(default.cli, "easytier-cli");
        assert_eq!(default.rpc, "127.0.0.1:15888");
        for rpc in ["127.0.0.1:15888", "[::1]:15889", "easy-tier.local:1234"] {
            Config::new("/opt/easy tier/cli", rpc, Some("vpn-1.test")).unwrap();
        }
        for cli in [
            "sudo easytier-cli",
            "./cli",
            "-bad",
            "/bin/cli\n",
            "/bin/cli\0",
        ] {
            assert!(Config::new(cli, "", None).is_err(), "{cli}");
        }
        for rpc in [
            "localhost",
            "http://localhost:80",
            "host:0",
            "host:65536",
            "[bad]:80",
            "host:80/",
            "a b:80",
            "host:-1",
        ] {
            assert!(Config::new("", rpc, None).is_err(), "{rpc}");
        }
        for container in ["--privileged", "a b", "a;id", "/vpn", "a\n"] {
            assert!(Config::new("", "", Some(container)).is_err(), "{container}");
        }
    }
    #[test]
    fn ambiguous_local_instances_cannot_prove_egress_ownership() {
        let rows = json!([
            {"ipv4":"10.1.1.1/24", "path_len":0},
            {"ipv4":"10.9.9.1/24", "path_len":0},
            {"ipv4":"10.1.1.2/24", "path_len":1}
        ]);
        assert_eq!(
            crate::routes::parse_easytier(&rows, "10.1.1.2", &["10.1.1.1".into()])["state"],
            "unknown"
        );
    }
    #[test]
    fn docker_command_keeps_the_collectors_identity_and_bounds_the_container_process() {
        let config = Config::new("/opt/et/cli", "[::1]:15889", Some("vpn")).unwrap();
        let (program, args) = config.route_command();
        assert_eq!(program, "docker");
        assert_eq!(
            args,
            [
                "exec",
                "--user",
                &format!("{}:{}", unsafe { libc::geteuid() }, unsafe {
                    libc::getegid()
                }),
                "vpn",
                "timeout",
                "-s",
                "KILL",
                "2",
                "/opt/et/cli",
                "--rpc-portal",
                "[::1]:15889",
                "--output",
                "json",
                "route"
            ]
        );
        let (program, args) = Config::new("/opt/et/cli", "localhost:15889", None)
            .unwrap()
            .route_command();
        assert_eq!(program, "/opt/et/cli");
        assert_eq!(
            args,
            [
                "--rpc-portal",
                "localhost:15889",
                "--output",
                "json",
                "route"
            ]
        );
    }
}
