//! Platform-managed terminal settings live in the private journal, not root-owned service files.
use crate::{config::Config, journal::Journal};
use anyhow::{ensure, Result};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct State {
    pub revision: u64,
    pub enabled: bool,
}
#[derive(Debug, Serialize)]
pub struct Status {
    pub revision: u64,
    pub enabled: bool,
    pub request_revision: Option<u64>,
    pub blocked: bool,
    pub reason: Option<&'static str>,
}
impl State {
    pub fn load(cfg: &Config, journal: &Journal) -> Result<Self> {
        let state = journal
            .metadata("terminal_privilege")?
            .map(|s| serde_json::from_str::<Self>(&s))
            .transpose()?
            .unwrap_or(Self {
                revision: 0,
                enabled: cfg.terminal_allow_privilege_escalation,
            });
        ensure!(
            state.revision <= 9_007_199_254_740_991,
            "invalid terminal privilege revision"
        );
        Ok(state)
    }
    pub fn blocked() -> bool {
        unsafe { libc::prctl(libc::PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0) != 0 }
    }
    pub fn enabled(&self) -> bool {
        self.enabled && !Self::blocked()
    }
    pub fn status(&self, requested: Option<u64>, reason: Option<&'static str>) -> Status {
        Status {
            revision: self.revision,
            enabled: self.enabled(),
            request_revision: requested,
            blocked: Self::blocked(),
            reason: reason.or(if self.enabled && Self::blocked() {
                Some("NO_NEW_PRIVS")
            } else {
                None
            }),
        }
    }
    pub fn apply(&mut self, update: Self, journal: &Journal, idle: bool) -> Result<Status> {
        ensure!(
            update.revision > 0 && update.revision <= 9_007_199_254_740_991,
            "invalid terminal privilege update"
        );
        let reason = if update.revision < self.revision {
            Some("STALE_REVISION")
        } else if update.revision == self.revision && update.enabled != self.enabled {
            Some("REVISION_CONFLICT")
        } else if update.revision == self.revision {
            None
        } else if !idle {
            Some("ACTIVE_TERMINALS")
        } else if update.enabled && Self::blocked() {
            Some("NO_NEW_PRIVS")
        } else if journal
            .set_terminal_privilege(&serde_json::to_string(&update)?)
            .is_err()
        {
            Some("PERSIST_FAILED")
        } else {
            *self = update.clone();
            None
        };
        Ok(self.status(Some(update.revision), reason))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn settings_are_durable_and_stale_or_busy_updates_do_not_apply() {
        let dir = tempfile::tempdir().unwrap();
        let j = Journal::open(&dir.path().join("journal.sqlite3")).unwrap();
        let mut s = State {
            revision: 0,
            enabled: false,
        };
        assert_eq!(
            s.apply(
                State {
                    revision: 1,
                    enabled: false
                },
                &j,
                false
            )
            .unwrap()
            .reason,
            Some("ACTIVE_TERMINALS")
        );
        assert!(j.metadata("terminal_privilege").unwrap().is_none());
        assert!(s
            .apply(
                State {
                    revision: 2,
                    enabled: false
                },
                &j,
                true
            )
            .unwrap()
            .reason
            .is_none());
        let restored: State =
            serde_json::from_str(&j.metadata("terminal_privilege").unwrap().unwrap()).unwrap();
        assert_eq!(restored, s);
        assert_eq!(
            s.apply(
                State {
                    revision: 1,
                    enabled: true
                },
                &j,
                true
            )
            .unwrap()
            .reason,
            Some("STALE_REVISION")
        );
        assert_eq!(
            s.apply(
                State {
                    revision: 2,
                    enabled: true
                },
                &j,
                true
            )
            .unwrap()
            .reason,
            Some("REVISION_CONFLICT")
        );
        assert!(!s.enabled);
    }
}
