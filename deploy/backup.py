#!/usr/bin/env python3
"""Consistent SQLite snapshots, including committed WAL data, with retention."""
import argparse
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
import sqlite3
import tempfile


def backup(database, directory, keep=7):
    database, directory = Path(database).resolve(), Path(directory)
    if not database.is_file():
        raise FileNotFoundError(database)
    if keep < 1:
        raise ValueError('Keep at least one backup.')
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    destination = directory / f'rasteroids-{stamp}.sqlite3'
    with tempfile.NamedTemporaryFile(dir=directory, prefix='.backup-', delete=False) as file:
        temporary = Path(file.name)
    try:
        with closing(sqlite3.connect(database.as_uri() + '?mode=ro', uri=True)) as source:
            with closing(sqlite3.connect(temporary)) as target:
                source.backup(target)
                if target.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                    raise RuntimeError('Backup integrity check failed.')
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)
    snapshots = sorted(directory.glob('rasteroids-*.sqlite3'), reverse=True)
    for old in snapshots[keep:]:
        old.unlink()
    return destination


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database', required=True)
    parser.add_argument('--directory', required=True)
    parser.add_argument('--keep', type=int, default=7)
    args = parser.parse_args()
    print(backup(args.database, args.directory, args.keep))
