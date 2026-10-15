#!/usr/bin/env python3
"""Package source only, with a per-file SHA-256 manifest and no runtime secrets/state."""
import hashlib,json,sys,zipfile
from pathlib import Path
root=Path(__file__).resolve().parent.parent
dest=Path(sys.argv[1]).resolve() if len(sys.argv)>1 else root.parent/'linux-fleet-deliverables'
dest.mkdir(parents=True,exist_ok=True)
excluded={'node_modules','target','dist','.dev','.test-output','.git','.agents','.codex','.aws','__pycache__'}
secret_suffixes={'.key','.pem','.crt','.csr','.sqlite','.sqlite3','.db','.p12','.pfx'}
files=[]
for file in root.rglob('*'):
 if not file.is_file():continue
 rel=file.relative_to(root)
 if any(part in excluded for part in rel.parts):continue
 if file.name=='source-manifest.json':continue
 if file.is_symlink():raise SystemExit(f'Refusing source symlink: {rel}')
 if file.suffix in secret_suffixes or file.name=='.env' or file.name.endswith(('-wal','-shm')):raise SystemExit(f'Runtime/credential-like file found: {rel}')
 files.append(file)
files.sort(key=lambda f:str(f.relative_to(root)))
manifest={'version':'0.1.0','algorithm':'SHA-256','note':'Source-only index. This manifest does not hash itself. Static RFC/test fixtures are public test data, not deployment credentials.','files':[{'path':str(f.relative_to(root)),'size':f.stat().st_size,'sha256':hashlib.sha256(f.read_bytes()).hexdigest()} for f in files]}
manifest_path=root/'source-manifest.json';manifest_path.write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
archive=dest/'linux-fleet-p0p1-source-20261014.zip'
with zipfile.ZipFile(archive,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as z:
 for f in files+[manifest_path]:z.write(f,arcname=str(Path('linux-fleet')/f.relative_to(root)))
with zipfile.ZipFile(archive) as z:
 assert z.testzip() is None
 for item in manifest['files']:
  data=z.read('linux-fleet/'+item['path']);assert len(data)==item['size'];assert hashlib.sha256(data).hexdigest()==item['sha256']
 assert len(z.namelist())==len(files)+1
sha=hashlib.sha256(archive.read_bytes()).hexdigest()
(archive.with_suffix('.zip.sha256')).write_text(f'{sha}  {archive.name}\n')
print(json.dumps({'zip':str(archive),'sha256':sha,'bytes':archive.stat().st_size,'source_files':len(files),'manifest':str(manifest_path)},indent=2))
