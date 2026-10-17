#!/usr/bin/env python3
"""Consistent OFFLINE Farhelm data backup. Stop the server first; never copy live WAL files."""
import argparse
import hashlib
import json
import shutil
import sqlite3
import stat
import tempfile
from pathlib import Path

# SQLite is snapshotted using its backup API; its transient sidecars are not files
# to restore. All other persistent state is included, including future additions.
SKIP = {"fleet.sqlite", "fleet.sqlite-wal", "fleet.sqlite-shm", "fleet.sqlite-journal", "backup-manifest.json", "lost+found"}


def copy_state(source, destination):
    for item in sorted(source.iterdir()):
        mode = item.lstat().st_mode
        target = destination / item.name
        if stat.S_ISLNK(mode):
            raise ValueError(f"symbolic links are not supported: {item}")
        if stat.S_ISDIR(mode):
            target.mkdir(mode=0o700)
            copy_state(item, target)
        elif stat.S_ISREG(mode):
            shutil.copyfile(item, target)
            target.chmod(0o600)
        else:
            raise ValueError(f"non-regular data entry is not supported: {item}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--server-stopped", action="store_true", required=True)
    args = parser.parse_args()
    source, destination = args.source.resolve(), args.destination.absolute()
    if destination.exists() or destination.is_symlink():
        parser.error("destination must not exist")
    if destination.resolve() == source or source in destination.resolve().parents:
        parser.error("destination must be outside the source data directory")
    db_path = source / "fleet.sqlite"
    if not db_path.is_file() or db_path.is_symlink():
        parser.error("source/fleet.sqlite must be a regular database file")
    staging = None
    db = sqlite3.connect(db_path.as_uri() + "?mode=ro", uri=True)
    try:
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        for table, filename in [("device_connections", "credentials.key"), ("private_certificate_authority", "certificates/private-ca.json")]:
            if table in tables and db.execute(f'SELECT 1 FROM "{table}" LIMIT 1').fetchone() and not (source / filename).is_file():
                raise ValueError(f"{filename} missing; cannot restore persisted identities")
        destination.parent.mkdir(parents=True, exist_ok=True)
        staging = Path(tempfile.mkdtemp(prefix=".farhelm-backup-", dir=destination.parent))
        with sqlite3.connect(staging / "fleet.sqlite") as snapshot:
            db.backup(snapshot)
        (staging / "fleet.sqlite").chmod(0o600)
        for entry in sorted(source.iterdir()):
            if entry.name in SKIP:
                continue
            if entry.name in {"admin.sock", "deployment.sock"} and stat.S_ISSOCK(entry.lstat().st_mode):
                continue
            if entry.is_symlink():
                raise ValueError(f"symbolic links are not supported: {entry}")
            target = staging / entry.name
            if entry.is_dir():
                target.mkdir(mode=0o700)
                copy_state(entry, target)
            elif entry.is_file():
                shutil.copyfile(entry, target)
                target.chmod(0o600)
            else:
                raise ValueError(f"non-regular data entry is not supported: {entry}")
        manifest = []
        for file in sorted(staging.rglob("*")):
            if file.is_file():
                digest = hashlib.sha256()
                with file.open("rb") as stream:
                    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                        digest.update(chunk)
                manifest.append({"path": str(file.relative_to(staging)), "size": file.stat().st_size, "sha256": digest.hexdigest()})
        (staging / "backup-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        (staging / "backup-manifest.json").chmod(0o600)
        # A failed copy must never leave a destination that looks like a backup.
        if destination.exists():
            raise ValueError("destination appeared during backup")
        staging.rename(destination)
        staging = None
    except (OSError, ValueError, sqlite3.Error) as error:
        parser.error(str(error))
    finally:
        db.close()
        if staging is not None:
            shutil.rmtree(staging)
    print(f"Offline backup created: {len(manifest)} files; restore to a separate directory and verify before use")


if __name__ == "__main__":
    main()
