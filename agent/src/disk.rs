//! Fixed read-only filesystem inventory; invoked only by an authenticated server request.
use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, process::Stdio, time::Duration};
use tokio::{io::AsyncReadExt, process::Command};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Usage {
    pub total_bytes: u64,
    pub used_bytes: u64,
    pub available_bytes: u64,
    pub filesystem_count: u64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub request_id: String,
}
pub fn parse(text: &str) -> Result<Usage> {
    ensure!(text.len() <= 65536, "disk output limit");
    let mut seen = HashSet::new();
    let mut result = Usage {
        total_bytes: 0,
        used_bytes: 0,
        available_bytes: 0,
        filesystem_count: 0,
    };
    for line in text.trim().lines().skip(1) {
        let fields: Vec<_> = line.split_whitespace().collect();
        if !matches!(
            fields.get(1).copied(),
            Some(
                "ext2"
                    | "ext3"
                    | "ext4"
                    | "xfs"
                    | "btrfs"
                    | "zfs"
                    | "f2fs"
                    | "jfs"
                    | "reiserfs"
                    | "bcachefs"
                    | "ntfs"
                    | "ntfs3"
                    | "vfat"
                    | "exfat"
                    | "fuseblk"
                    | "ufs"
            )
        ) {
            continue;
        }
        ensure!(fields.len() >= 7, "invalid disk row");
        if !seen.insert(fields[0]) {
            continue;
        }
        let number = |s: &str| -> Result<u64> {
            ensure!(
                !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()),
                "invalid disk number"
            );
            s.parse::<u64>()?
                .checked_mul(1024)
                .context("disk size overflow")
        };
        let (total, used, available) = (number(fields[2])?, number(fields[3])?, number(fields[4])?);
        ensure!(
            total > 0 && used.checked_add(available).is_some_and(|v| v <= total),
            "invalid disk capacity"
        );
        result.total_bytes = result
            .total_bytes
            .checked_add(total)
            .context("disk size overflow")?;
        result.used_bytes = result
            .used_bytes
            .checked_add(used)
            .context("disk size overflow")?;
        result.available_bytes = result
            .available_bytes
            .checked_add(available)
            .context("disk size overflow")?;
        result.filesystem_count += 1;
    }
    ensure!(
        result.filesystem_count > 0
            && result.filesystem_count <= 1024
            && result.total_bytes <= 9007199254740991,
        "no supported filesystems or capacity overflow"
    );
    Ok(result)
}
pub async fn collect() -> Result<Usage> {
    let mut child = Command::new("df")
        .args(["-P", "-k", "-l", "-T"])
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()?;
    let stdout = child.stdout.take().context("missing df output")?;
    tokio::time::timeout(Duration::from_secs(5), async {
        let mut bytes = Vec::new();
        stdout.take(65537).read_to_end(&mut bytes).await?;
        ensure!(bytes.len() <= 65536, "disk output limit");
        ensure!(child.wait().await?.success(), "df failed");
        parse(std::str::from_utf8(&bytes)?)
    })
    .await?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn aggregates_persistent_filesystems_without_duplicate_or_memory_mounts() {
        let text = include_str!("../../tests/fixtures/disk-usage.txt");
        assert_eq!(
            parse(text).unwrap(),
            Usage {
                total_bytes: 3072000,
                used_bytes: 1536000,
                available_bytes: 1331200,
                filesystem_count: 2
            }
        );
        assert!(parse("header\ntmpfs tmpfs 1000 20 980 2% /run").is_err());
        assert!(parse("header\n/dev/sda ext4 1000 1200 100 120% /").is_err());
        assert!(parse("header\n/dev/sda ext4 18446744073709551615 1 1 1% /").is_err());
    }
    #[tokio::test]
    async fn reads_real_linux_filesystem_totals_without_privilege() {
        let result = collect().await.unwrap();
        assert!(result.total_bytes > 0);
        assert!(result.used_bytes + result.available_bytes <= result.total_bytes);
    }
}
