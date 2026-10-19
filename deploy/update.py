#!/usr/bin/env python3
"""Restricted root deployment helper. Install once; CI cannot replace this helper."""
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile
import time
from urllib.request import urlopen

APP_FILES = ('server.py', 'index.html', 'web.css', 'account.js', 'assets/icon.svg', 'deploy/backup.py', 'version.json')
MAX_FILE_SIZE = 2 * 1024 * 1024


def validate_release(path):
    files = {}
    # Streaming avoids scanning/decompressing an unbounded archive before validation.
    with tarfile.open(path, 'r|gz') as archive:
        for member in archive:
            if member.name not in (*APP_FILES, 'release.json') or member.name in files:
                raise ValueError('Unexpected or duplicate release path: ' + member.name)
            if not member.isfile() or not 0 < member.size <= MAX_FILE_SIZE:
                raise ValueError('Invalid release file: ' + member.name)
            files[member.name] = archive.extractfile(member).read(MAX_FILE_SIZE + 1)
    if set(files) != set((*APP_FILES, 'release.json')):
        raise ValueError('Incomplete release.')
    manifest = json.loads(files.pop('release.json'))
    if not re.fullmatch(r'[0-9a-f]{40}', manifest.get('commit', '')):
        raise ValueError('Invalid release commit.')
    actual = {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}
    if actual != manifest.get('files'):
        raise ValueError('Release checksums do not match.')
    version = json.loads(files['version.json'])
    if version.get('commit') != manifest['commit']:
        raise ValueError('Release version does not match the manifest.')
    return manifest['commit'], files


def write_files(directory, files):
    directory = Path(directory)
    for name, data in files.items():
        destination = directory / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=destination.parent, prefix='.release-', delete=False) as temporary:
            temporary.write(data)
            pending = Path(temporary.name)
        try:
            pending.chmod(0o644)
            os.replace(pending, destination)
        finally:
            pending.unlink(missing_ok=True)


def health_check(commit):
    last_error = None
    for _ in range(10):
        try:
            with urlopen('http://127.0.0.1:8000/version.json', timeout=3) as response:
                if json.load(response)['commit'] != commit:
                    raise RuntimeError('The application reports a different commit.')
            with urlopen('http://127.0.0.1:8000/api/leaderboard', timeout=3) as response:
                if not isinstance(json.load(response)['entries'], list):
                    raise RuntimeError('Leaderboard is unavailable.')
            return
        except Exception as error:
            last_error = error
            time.sleep(.5)
    raise RuntimeError('Deployment health check failed.') from last_error


def deploy_release(application, archive, backup_parent, run=None, check_health=None):
    run = run or subprocess.run
    check_health = check_health or health_check
    commit, files = validate_release(archive)
    application = Path(application)
    previous = {name: (application / name).read_bytes() for name in APP_FILES if (application / name).is_file()}
    backup = Path(backup_parent) / ('auto-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'))
    backup.mkdir(parents=True, mode=0o700)
    write_files(backup, previous)
    run(['systemctl', 'start', 'rasteroids-backup.service'], check=True)
    run(['systemctl', 'stop', 'rasteroids.service'], check=True)
    try:
        write_files(application, files)
        run(['systemctl', 'start', 'rasteroids.service'], check=True)
        check_health(commit)
    except Exception:
        run(['systemctl', 'stop', 'rasteroids.service'], check=False)
        write_files(application, previous)
        for name in set(APP_FILES) - set(previous):
            (application / name).unlink(missing_ok=True)
        run(['systemctl', 'start', 'rasteroids.service'], check=True)
        print('Release failed; previous application files restored.', flush=True)
        raise
    backups = sorted(backup.parent.glob('auto-*'), reverse=True)
    for old in backups[5:]:
        if old.is_dir() and not old.is_symlink():
            shutil.rmtree(old)
    print(json.dumps({'state': 'deployed', 'commit': commit}), flush=True)


if __name__ == '__main__':
    if os.geteuid() != 0:
        raise PermissionError('The installed deployment helper must run as root.')
    deploy_release('/opt/rasteroids', '/var/lib/rasteroids-deploy/release.tar.gz', '/var/backups/rasteroids-releases')
