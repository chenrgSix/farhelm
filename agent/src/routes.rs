//! Explicit network policy is durable and never silently falls back in private-only mode.
pub use crate::easytier::observe as easytier;
use crate::{address::origin, config::Config, journal::Journal};
use anyhow::{ensure, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::net::IpAddr;
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AgentEndpoints {
    pub vpn_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vpn_ip: Option<String>,
    pub public_url: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Policy {
    pub mode: String,
    pub agent: Option<AgentEndpoints>,
    pub ssh: Option<Value>,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    pub revision: u64,
    pub policy: Option<Policy>,
}
pub fn private_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(a) => {
            let o = a.octets();
            a.is_private() || a.is_loopback() || (o[0] == 100 && (64..=127).contains(&o[1]))
        }
        IpAddr::V6(a) => a.is_loopback() || (a.segments()[0] & 0xfe00) == 0xfc00,
    }
}
impl Settings {
    pub fn load(journal: &Journal) -> Result<Self> {
        let s = match journal.metadata("network_route")? {
            Some(v) => serde_json::from_str(&v)?,
            None => Self {
                revision: 0,
                policy: None,
            },
        };
        s.validate()?;
        Ok(s)
    }
    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.revision <= 9_007_199_254_740_991,
            "invalid route revision"
        );
        if let Some(p) = &self.policy {
            ensure!(
                ["vpn_preferred", "private_only"].contains(&p.mode.as_str()),
                "invalid route mode"
            );
            let a = p
                .agent
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("Agent VPN endpoint required"))?;
            let vpn = origin(&a.vpn_url)?;
            let host = vpn.host_str().unwrap_or("").trim_matches(['[', ']']);
            let host_ip = host.parse::<IpAddr>().ok();
            let ip: IpAddr = a.vpn_ip.as_deref().unwrap_or(host).parse()?;
            ensure!(
                private_ip(ip),
                "VPN connection must use a literal private IP"
            );
            ensure!(
                host_ip.is_none_or(|h| h == ip),
                "VPN IP must match a literal URL host"
            );
            if let Some(public) = &a.public_url {
                ensure!(
                    p.mode == "vpn_preferred"
                        && (origin(public)? != vpn || (a.vpn_ip.is_some() && host_ip.is_none())),
                    "invalid public fallback"
                );
            }
        }
        Ok(())
    }
    pub fn save(&self, journal: &Journal) -> Result<()> {
        self.validate()?;
        journal.set_network_route(&serde_json::to_string(self)?)?;
        Ok(())
    }
    pub fn candidates(&self, base: &Config) -> Result<Vec<(Config, &'static str)>> {
        if let Some(p) = &self.policy {
            let a = p
                .agent
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("Agent VPN endpoint required"))?;
            let mut vpn = base.clone();
            vpn.server = origin(&a.vpn_url)?;
            vpn.connect_ip = a.vpn_ip.as_ref().map(|ip| ip.parse()).transpose()?;
            let mut v = vec![(vpn, "vpn")];
            if p.mode == "vpn_preferred" {
                if let Some(u) = &a.public_url {
                    let mut c = base.clone();
                    c.server = origin(u)?;
                    c.connect_ip = None;
                    v.push((c, "public"));
                }
            }
            Ok(v)
        } else {
            Ok(vec![(base.clone(), "configured")])
        }
    }
}
pub fn parse_easytier(routes: &Value, target: &str, addresses: &[String]) -> Value {
    let unknown = json!({"state":"unknown","latency_ms":null});
    let Some(rows) = routes.as_array() else {
        return unknown;
    };
    let local: Vec<_> = rows
        .iter()
        .filter(|r| r["path_len"].as_i64() == Some(0))
        .collect();
    if local.len() != 1 {
        return unknown;
    }
    let local = local[0];
    let Some(ip) = local["ipv4"].as_str() else {
        return unknown;
    };
    if !addresses
        .iter()
        .any(|a| a == ip.split('/').next().unwrap_or(""))
    {
        return unknown;
    }
    let matches: Vec<_> = rows
        .iter()
        .filter(|r| {
            r["ipv4"]
                .as_str()
                .map(|ip| ip.split('/').next() == Some(target))
                .unwrap_or(false)
        })
        .collect();
    if matches.len() != 1 {
        return unknown;
    }
    let row = matches[0];
    let Some(hops) = row["path_len"].as_i64() else {
        return unknown;
    };
    let latency_hops = row["path_len_lat_first"].as_i64().unwrap_or(0);
    if hops < 1 || (latency_hops > 0 && (hops == 1) != (latency_hops == 1)) {
        return unknown;
    }
    let latency = if hops == 1 {
        row["next_hop_lat"]
            .as_f64()
            .filter(|n| n.is_finite() && *n >= 0.0)
    } else {
        None
    };
    json!({"state":if hops==1{"p2p"}else{"relay"},"latency_ms":latency})
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn policy_updates_survive_restart_without_changing_identity() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("journal.sqlite3");
        let j = Journal::open(&path).unwrap();
        j.set_metadata("server_instance", "original").unwrap();
        let mut s = Settings {
            revision: 1,
            policy: Some(Policy {
                mode: "private_only".into(),
                agent: Some(AgentEndpoints {
                    vpn_ip: None,
                    vpn_url: "https://10.10.0.1".into(),
                    public_url: None,
                }),
                ssh: None,
            }),
        };
        s.save(&j).unwrap();
        s.revision = 2;
        s.policy.as_mut().unwrap().agent.as_mut().unwrap().vpn_url = "https://10.10.0.2".into();
        s.save(&j).unwrap();
        drop(j);
        let j = Journal::open(&path).unwrap();
        assert_eq!(Settings::load(&j).unwrap(), s);
        assert_eq!(
            j.metadata("server_instance").unwrap().as_deref(),
            Some("original")
        );
    }
    #[test]
    fn private_only_never_has_public_candidates() {
        assert!(Settings {
            revision: 1,
            policy: Some(Policy {
                mode: "private_only".into(),
                agent: Some(AgentEndpoints {
                    vpn_ip: None,
                    vpn_url: "https://10.10.0.1".into(),
                    public_url: Some("https://example.com".into())
                }),
                ssh: None
            })
        }
        .validate()
        .is_err());
        assert!(!private_ip("8.8.8.8".parse().unwrap()));
        assert!(private_ip("100.64.0.1".parse().unwrap()));
    }
    #[test]
    fn pinned_vpn_keeps_tls_hostname_and_rejects_public_override() {
        let mut value = json!({"revision":1,"policy":{"mode":"vpn_preferred","agent":{"vpn_url":"https://fleet.example.com","vpn_ip":"10.1.2.3","public_url":"https://fleet.example.com"},"ssh":null}});
        let settings: Settings = serde_json::from_value(value.clone()).unwrap();
        settings.validate().unwrap();
        for bad in ["8.8.8.8", "vpn.example.com", "::ffff:10.1.2.3"] {
            value["policy"]["agent"]["vpn_ip"] = json!(bad);
            assert!(serde_json::from_value::<Settings>(value.clone())
                .unwrap()
                .validate()
                .is_err());
        }
        value["policy"]["agent"]["vpn_ip"] = json!("10.1.2.3");
        value["policy"]["agent"]["vpn_url"] = json!("https://10.1.2.4");
        assert!(serde_json::from_value::<Settings>(value)
            .unwrap()
            .validate()
            .is_err());
    }
    #[test]
    fn observed_routes_need_os_interface_and_consistent_paths() {
        let mut routes = json!([{"ipv4":"10.1.1.1/24","path_len":0},{"ipv4":"10.1.1.2/24","path_len":1,"path_len_lat_first":1,"next_hop_lat":2.1}]);
        assert_eq!(
            parse_easytier(&routes, "10.1.1.2", &["10.1.1.1".into()])["state"],
            "p2p"
        );
        assert_eq!(
            parse_easytier(&routes, "10.1.1.2", &["192.168.1.1".into()])["state"],
            "unknown"
        );
        routes[1]["path_len_lat_first"] = json!(2);
        assert_eq!(
            parse_easytier(&routes, "10.1.1.2", &["10.1.1.1".into()])["state"],
            "unknown"
        );
        routes[1]["path_len"] = json!(2);
        assert_eq!(
            parse_easytier(&routes, "10.1.1.2", &["10.1.1.1".into()])["state"],
            "relay"
        );
    }
}
