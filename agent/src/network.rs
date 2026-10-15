//! Agent-local observations. Losing the platform connection is not proof of an Internet outage.
use crate::{journal::Journal, now_ms};
use anyhow::{ensure, Result};
use serde::{Deserialize, Serialize};
use std::{
    ffi::CStr,
    net::{Ipv4Addr, Ipv6Addr},
    ptr,
};

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Address {
    pub interface: String,
    pub address: String,
    pub family: String,
    pub up: bool,
}

pub fn addresses() -> Result<Vec<Address>> {
    let mut head = ptr::null_mut();
    ensure!(
        unsafe { libc::getifaddrs(&mut head) } == 0,
        "cannot enumerate network interfaces"
    );
    struct List(*mut libc::ifaddrs);
    impl Drop for List {
        fn drop(&mut self) {
            unsafe { libc::freeifaddrs(self.0) }
        }
    }
    let _list = List(head);
    let mut found = Vec::new();
    let mut next = head;
    while !next.is_null() {
        // getifaddrs owns these pointers until the guard frees the list.
        let item = unsafe { &*next };
        next = item.ifa_next;
        if item.ifa_addr.is_null()
            || item.ifa_name.is_null()
            || item.ifa_flags & libc::IFF_LOOPBACK as u32 != 0
        {
            continue;
        }
        let family = unsafe { (*item.ifa_addr).sa_family as i32 };
        let (address, family) = match family {
            libc::AF_INET => {
                let addr = unsafe { &*(item.ifa_addr as *const libc::sockaddr_in) };
                (
                    Ipv4Addr::from(addr.sin_addr.s_addr.to_ne_bytes()).to_string(),
                    "ipv4",
                )
            }
            libc::AF_INET6 => {
                let addr = unsafe { &*(item.ifa_addr as *const libc::sockaddr_in6) };
                (Ipv6Addr::from(addr.sin6_addr.s6_addr).to_string(), "ipv6")
            }
            _ => continue,
        };
        found.push(Address {
            interface: unsafe { CStr::from_ptr(item.ifa_name) }
                .to_string_lossy()
                .into_owned(),
            address,
            family: family.into(),
            up: item.ifa_flags & libc::IFF_UP as u32 != 0,
        });
    }
    found.sort();
    found.dedup();
    Ok(found)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Event {
    pub event_id: String,
    pub reason: String,
    pub last_contact_at: Option<i64>,
    pub detected_at: i64,
    pub recovered_at: Option<i64>,
}

#[derive(Default, Serialize, Deserialize)]
pub struct State {
    connected: bool,
    #[serde(default)]
    planned: bool,
    last_contact_at: Option<i64>,
    pending: Option<Event>,
}

pub struct Monitor {
    journal: Journal,
    state: State,
}
impl Monitor {
    pub fn start(journal: Journal) -> Result<Self> {
        let state = journal
            .metadata("network_state")?
            .map(|s| serde_json::from_str(&s))
            .transpose()?
            .unwrap_or_default();
        let mut monitor = Self { journal, state };
        // A dead process cannot observe when connectivity was lost. Preserve that distinction.
        if monitor.state.connected {
            monitor.failed("agent_restart", now_ms())?;
        }
        Ok(monitor)
    }
    pub fn failed(&mut self, reason: &str, at: i64) -> Result<bool> {
        let changed = self.state.pending.is_none();
        if changed {
            self.state.pending = Some(Event {
                event_id: uuid::Uuid::new_v4().to_string(),
                reason: reason.into(),
                last_contact_at: self.state.last_contact_at,
                detected_at: at,
                recovered_at: None,
            });
        }
        self.state.connected = false;
        self.state.planned = false;
        self.save()?;
        Ok(changed)
    }
    pub fn connected(&mut self, at: i64) -> Result<()> {
        if let Some(event) = &mut self.state.pending {
            event.recovered_at = Some(at.max(event.detected_at));
        }
        let completed = self.state.pending.take();
        self.state.connected = true;
        self.state.planned = false;
        self.state.last_contact_at = Some(at);
        self.journal
            .network_save(&serde_json::to_string(&self.state)?, completed.as_ref())
    }
    pub fn contact(&mut self, at: i64) -> Result<()> {
        self.state.last_contact_at = Some(at);
        self.save()
    }
    pub fn planned(&mut self) -> Result<()> {
        self.state.connected = false;
        self.state.planned = true;
        self.save()
    }
    fn save(&self) -> Result<()> {
        self.journal.network_save(
            &serde_json::to_string(&self.state)?,
            self.state.pending.as_ref(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn outage_survives_restart_and_replays_until_ack_without_duplicate() -> Result<()> {
        let tmp = tempfile::tempdir()?;
        let path = tmp.path().join("state.db");
        let j = Journal::open(&path)?;
        let mut m = Monitor::start(j.clone())?;
        m.connected(100)?;
        m.contact(110)?;
        m.failed("connection_lost", 120)?;
        m.failed("connection_failed", 130)?;
        drop(m);
        drop(j);
        let j = Journal::open(&path)?;
        let mut m = Monitor::start(j.clone())?;
        assert!(j.network_first()?.is_none());
        m.connected(200)?;
        let event = j.network_first()?.unwrap();
        assert_eq!(event.detected_at, 120);
        assert_eq!(event.last_contact_at, Some(110));
        assert_eq!(event.recovered_at, Some(200));
        m.connected(210)?;
        assert_eq!(j.network_first()?.unwrap().event_id, event.event_id);
        j.network_ack(&event.event_id)?;
        j.network_ack(&event.event_id)?;
        assert!(j.network_first()?.is_none());
        // Planned migrations/upgrades produce no outage; unexpected worker death is labelled.
        m.planned()?;
        drop(m);
        let mut m = Monitor::start(j.clone())?;
        m.connected(220)?;
        assert!(j.network_first()?.is_none());
        drop(m);
        let mut m = Monitor::start(j.clone())?;
        m.connected(now_ms())?;
        assert_eq!(j.network_first()?.unwrap().reason, "agent_restart");
        Ok(())
    }
    #[test]
    fn local_interfaces_are_valid_and_sorted() -> Result<()> {
        let list = addresses()?;
        assert!(list.windows(2).all(|x| x[0] < x[1]));
        for item in list {
            let ip: std::net::IpAddr = item.address.parse()?;
            assert!(!ip.is_loopback());
            assert_eq!(ip.is_ipv4(), item.family == "ipv4");
            assert!(!item.interface.is_empty());
        }
        Ok(())
    }
}
