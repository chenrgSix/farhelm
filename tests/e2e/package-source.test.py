import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import zipfile

SCRIPT = Path(__file__).resolve().parents[2] / 'scripts/package-source.py'

class SourcePackageTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='farhelm-package-test-')
        self.root = Path(self.temp.name)
        (self.root / 'scripts').mkdir()
        shutil.copyfile(SCRIPT, self.root / 'scripts/package-source.py')
        (self.root / 'package.json').write_text('{"name":"farhelm","version":"0.2.6"}')
        (self.root / 'README.md').write_text('committed source\n')
        (self.root / 'scripts/package-source.py').chmod(0o755)
        self.git('init', '-q')
        self.git('config', 'user.name', 'Release Test')
        self.git('config', 'user.email', 'release-test@example.invalid')
        self.commit()

    def tearDown(self):
        self.temp.cleanup()

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.root), *args])

    def commit(self):
        self.git('add', '.')
        self.git('commit', '-qm', 'fixture')

    def package(self):
        return subprocess.run(['python3', str(self.root / 'scripts/package-source.py')], capture_output=True, text=True)

    def test_only_committed_source_and_exact_manifest(self):
        (self.root / '.env').write_text('UNTRACKED_SECRET=do-not-ship')
        (self.root / '.DS_Store').write_bytes(b'local metadata')
        (self.root / 'local.txt').write_text('not committed')
        result = self.package()
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        archive = Path(report['zip'])
        self.assertEqual(archive.name, 'farhelm-v0.2.6-source.zip')
        self.assertEqual(report['commit'], self.git('rev-parse', 'HEAD').decode().strip())
        with zipfile.ZipFile(archive) as output:
            self.assertTrue(output.getinfo('farhelm/scripts/package-source.py').external_attr >> 16 & 0o100)
            manifest = json.loads(output.read('farhelm/source-manifest.json'))
            self.assertEqual(manifest['version'], '0.2.6')
            self.assertEqual(manifest['commit'], report['commit'])
            self.assertEqual(len(output.namelist()), len(manifest['files']) + 1)
            self.assertFalse(any(n.endswith(('.env', '.DS_Store', 'local.txt')) for n in output.namelist()))
            for item in manifest['files']:
                self.assertEqual(hashlib.sha256(output.read('farhelm/' + item['path'])).hexdigest(), item['sha256'])
        self.assertFalse((self.root / 'source-manifest.json').exists())
        self.assertEqual(self.git('status', '--porcelain', '--untracked-files=no'), b'')

    def test_dirty_tracked_source_is_refused(self):
        (self.root / 'README.md').write_text('uncommitted modification')
        self.assertNotEqual(self.package().returncode, 0)

    def test_committed_secret_is_refused(self):
        (self.root / 'runtime.key').write_text('test-only fake credential')
        self.commit()
        self.assertNotEqual(self.package().returncode, 0)

    def test_committed_symlink_is_refused(self):
        (self.root / 'linked').symlink_to('README.md')
        self.commit()
        self.assertNotEqual(self.package().returncode, 0)

if __name__ == '__main__':
    unittest.main()
