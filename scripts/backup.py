#!/usr/bin/env python3
"""Consistent OFFLINE Farhelm data backup. Stop the server first; never copy live WAL files."""
import argparse, hashlib, json, shutil, sqlite3
from pathlib import Path
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('source',type=Path);p.add_argument('destination',type=Path);p.add_argument('--server-stopped',action='store_true',required=True)
a=p.parse_args()
if a.destination.exists():p.error('destination must not exist')
if not (a.source/'fleet.sqlite').is_file():p.error('source/fleet.sqlite missing')
a.destination.mkdir(mode=0o700,parents=True)
source=sqlite3.connect(f'file:{a.source / "fleet.sqlite"}?mode=ro',uri=True)
with sqlite3.connect(a.destination/'fleet.sqlite') as dest:source.backup(dest)
source.close()
if (a.source/'objects').exists():shutil.copytree(a.source/'objects',a.destination/'objects')
index=[]
for file in sorted(a.destination.rglob('*')):
 if file.is_file():index.append({'path':str(file.relative_to(a.destination)),'size':file.stat().st_size,'sha256':hashlib.sha256(file.read_bytes()).hexdigest()})
(a.destination/'backup-manifest.json').write_text(json.dumps(index,indent=2)+'\n')
print(f'Offline backup created: {len(index)} files; restore to a separate directory and verify before use')
