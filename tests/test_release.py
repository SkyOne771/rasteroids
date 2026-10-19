from pathlib import Path
import io
import json
import sqlite3
import sys
import tarfile
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.package_release import APP_FILES, ROOT, package_release
from deploy.update import validate_release, write_files, deploy_release


class ReleaseTests(unittest.TestCase):
    def test_release_has_exact_allowlist_and_matching_checksums(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = package_release(ROOT, Path(temporary) / 'release.tar.gz', 'a' * 40)
            commit, files = validate_release(path)
            self.assertEqual(commit, 'a' * 40)
            self.assertEqual(set(files), set(APP_FILES) | {'version.json'})
            self.assertEqual(json.loads(files['version.json'])['commit'], commit)
            self.assertFalse(any('sqlite' in name or '.ssh' in name for name in files))

    def test_invalid_archives_are_rejected_before_installation(self):
        for name, kind in [('server.py', tarfile.SYMTYPE), ('../server.py', tarfile.REGTYPE), ('data/rasteroids.sqlite3', tarfile.REGTYPE)]:
            with self.subTest(name=name, kind=kind), tempfile.TemporaryDirectory() as temporary:
                path = Path(temporary) / 'bad.tar.gz'
                with tarfile.open(path, 'w:gz') as archive:
                    entry = tarfile.TarInfo(name)
                    entry.type, entry.size, entry.linkname = kind, 1, '/etc/passwd'
                    archive.addfile(entry, io.BytesIO(b'x'))
                with self.assertRaises(ValueError):
                    validate_release(path)

    def test_tampered_manifest_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = package_release(ROOT, Path(temporary) / 'release.tar.gz', 'b' * 40)
            with tarfile.open(path) as source:
                entries = [(entry.name, source.extractfile(entry).read()) for entry in source]
            with tarfile.open(path, 'w:gz') as target:
                for name, data in entries:
                    if name == 'index.html':
                        data += b'changed'
                    entry = tarfile.TarInfo(name); entry.size = len(data)
                    target.addfile(entry, io.BytesIO(data))
            with self.assertRaises(ValueError):
                validate_release(path)

    def test_file_installation_preserves_existing_database(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            database = root / 'data' / 'scores.sqlite3'
            database.parent.mkdir()
            with sqlite3.connect(database) as db:
                db.execute('CREATE TABLE scores(score INTEGER)')
                db.execute('INSERT INTO scores VALUES (16800)')
            write_files(root, {'index.html': b'new release', 'assets/icon.svg': b'icon'})
            with sqlite3.connect(database) as db:
                self.assertEqual(db.execute('SELECT score FROM scores').fetchone()[0], 16800)
            self.assertEqual((root / 'index.html').read_bytes(), b'new release')
            self.assertEqual((root / 'index.html').stat().st_mode & 0o777, 0o644)

    def test_failed_health_check_restores_previous_application(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            app = root / 'app'; app.mkdir()
            previous = {name: b'previous release' for name in APP_FILES}
            write_files(app, previous)
            archive = package_release(ROOT, root / 'release.tar.gz', 'c' * 40)
            calls = []
            def run(command, **kwargs):
                calls.append(command)
            def unhealthy(commit):
                raise RuntimeError('Simulated failed health check')
            with self.assertRaises(RuntimeError):
                deploy_release(app, archive, root / 'backups', run=run, check_health=unhealthy)
            for name, expected in previous.items():
                self.assertEqual((app / name).read_bytes(), expected)
            self.assertEqual(calls[-1], ['systemctl', 'start', 'rasteroids.service'])

    def test_bad_release_never_stops_the_running_service(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            invalid = root / 'release.tar.gz'; invalid.write_bytes(b'not an archive')
            calls = []
            with self.assertRaises(tarfile.TarError):
                deploy_release(root / 'app', invalid, root / 'backups', run=lambda command, **kwargs: calls.append(command))
            self.assertEqual(calls, [])


if __name__ == '__main__':
    unittest.main()
