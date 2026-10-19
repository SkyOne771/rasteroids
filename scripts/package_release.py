#!/usr/bin/env python3
"""Build an allowlisted, checksummed release without databases or credentials."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import re
import tarfile

ROOT = Path(__file__).resolve().parents[1]
APP_FILES = ('server.py', 'index.html', 'web.css', 'account.js', 'assets/icon.svg', 'deploy/backup.py')
PUBLIC_FILES = ('index.html', 'web.css', 'account.js')
REPOSITORY = 'https://github.com/SkyOne771/rasteroids'


def package_release(root, output, commit):
    if not re.fullmatch(r'[0-9a-f]{40}', commit):
        raise ValueError('Supply a complete Git commit SHA.')
    root, output = Path(root), Path(output)
    files = {name: (root / name).read_bytes() for name in APP_FILES}
    version = {'commit': commit, 'repository': REPOSITORY,
               'assets': {name: hashlib.sha256(files[name]).hexdigest() for name in PUBLIC_FILES}}
    files['version.json'] = (json.dumps(version, sort_keys=True) + '\n').encode()
    manifest = {'commit': commit, 'files': {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}}
    files['release.json'] = (json.dumps(manifest, sort_keys=True) + '\n').encode()
    with tarfile.open(output, 'w:gz') as archive:
        for name, data in files.items():
            entry = tarfile.TarInfo(name)
            entry.size, entry.mode, entry.mtime = len(data), 0o644, 0
            archive.addfile(entry, io.BytesIO(data))
    return output


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--commit', required=True)
    parser.add_argument('--output', default='release.tar.gz')
    args = parser.parse_args()
    print(package_release(ROOT, args.output, args.commit))
