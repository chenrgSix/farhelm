#!/usr/bin/env python3
"""Package the committed release source, excluding local state and untracked files."""
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import subprocess
import sys
import tarfile
import zipfile

root = Path(__file__).resolve().parent.parent

def git(*args):
    return subprocess.check_output(['git', '-C', str(root), *args])

if git('status', '--porcelain', '--untracked-files=no').strip():
    raise SystemExit('Commit tracked changes before packaging a release.')
commit = git('rev-parse', 'HEAD').decode().strip()
excluded = {'node_modules', 'target', 'dist', '.dev', '.test-output', '.git',
            '.agents', '.codex', '.aws', '__pycache__', '.DS_Store'}
secret_suffixes = {'.key', '.pem', '.crt', '.csr', '.sqlite', '.sqlite3', '.db', '.p12', '.pfx'}
files = {}
modes = {}
with tarfile.open(fileobj=io.BytesIO(git('archive', '--format=tar', 'HEAD'))) as source:
    for item in source.getmembers():
        rel = PurePosixPath(item.name)
        if item.isdir():
            continue
        if item.issym() or item.islnk():
            raise SystemExit(f'Refusing source symlink: {rel}')
        if not item.isfile() or rel.is_absolute() or '..' in rel.parts:
            raise SystemExit(f'Invalid source path: {rel}')
        if any(part in excluded for part in rel.parts) or rel.name == 'source-manifest.json':
            continue
        if rel.suffix in secret_suffixes or rel.name == '.env' or rel.name.endswith(('-wal', '-shm')):
            raise SystemExit(f'Runtime/credential-like file found: {rel}')
        files[str(rel)] = source.extractfile(item).read()
        modes[str(rel)] = item.mode
version = json.loads(files['package.json'])['version']
if not isinstance(version, str) or not version or any(c not in '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-' for c in version):
    raise SystemExit('Invalid release version')
dest = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else root / '.dev/releases' / ('v' + version)
dest.mkdir(parents=True, exist_ok=True)
manifest = {'version': version, 'commit': commit, 'algorithm': 'SHA-256',
            'note': 'Committed source only. This manifest does not hash itself. Public test fixtures are not deployment credentials.',
            'files': [{'path': name, 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
                      for name, data in sorted(files.items())]}
archive = dest / f'farhelm-v{version}-source.zip'
with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as output:
    for name, data in sorted(files.items()):
        entry = zipfile.ZipInfo('farhelm/' + name)
        entry.external_attr = (0o100000 | modes[name]) << 16
        output.writestr(entry, data, compress_type=zipfile.ZIP_DEFLATED)
    output.writestr('farhelm/source-manifest.json', json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
with zipfile.ZipFile(archive) as output:
    assert output.testzip() is None
    for item in manifest['files']:
        data = output.read('farhelm/' + item['path'])
        assert len(data) == item['size'] and hashlib.sha256(data).hexdigest() == item['sha256']
    assert len(output.namelist()) == len(files) + 1
sha = hashlib.sha256(archive.read_bytes()).hexdigest()
archive.with_suffix('.zip.sha256').write_text(f'{sha}  {archive.name}\n')
print(json.dumps({'zip': str(archive), 'version': version, 'commit': commit,
                  'sha256': sha, 'bytes': archive.stat().st_size, 'source_files': len(files)}, indent=2))
