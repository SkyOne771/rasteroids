from pathlib import Path
import sqlite3
import tempfile
import unittest
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from deploy.backup import backup


class BackupTests(unittest.TestCase):
    def test_live_wal_database_is_backed_up_and_restores_with_retention(self):
        with tempfile.TemporaryDirectory() as temporary:
            database = Path(temporary) / 'live.sqlite3'
            snapshots = Path(temporary) / 'backups'
            with sqlite3.connect(database) as live:
                live.execute('PRAGMA journal_mode=WAL')
                live.execute('CREATE TABLE scores (score INTEGER)')
                live.execute('INSERT INTO scores VALUES (20)')
                live.commit()
                for _ in range(3):
                    latest = backup(database, snapshots, keep=2)
                with sqlite3.connect(latest) as restored:
                    self.assertEqual(restored.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
                    self.assertEqual(restored.execute('SELECT score FROM scores').fetchone()[0], 20)
            self.assertEqual(len(list(snapshots.glob('*.sqlite3'))), 2)
            self.assertEqual(latest.stat().st_mode & 0o777, 0o600)

    def test_missing_database_does_not_create_empty_backup(self):
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaises(FileNotFoundError):
                backup(Path(temporary) / 'missing.sqlite3', Path(temporary) / 'backups')


if __name__ == '__main__':
    unittest.main()
