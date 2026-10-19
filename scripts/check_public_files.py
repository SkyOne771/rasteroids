#!/usr/bin/env python3
"""Check tracked publication contents for private runtime files and key material."""
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
PRIVATE_PARTS = {'data', '.ssh', '.venv', 'node_modules', '__pycache__'}
PRIVATE_SUFFIXES = {'.sqlite', '.sqlite3', '.db', '.pem', '.key', '.p12', '.pyc'}


def check_public_files():
    paths = subprocess.check_output(['git', 'ls-files', '-z'], cwd=ROOT).decode().split('\0')
    problems = []
    key_pattern = re.compile(rb'-----BEGIN (?:OPENSSH |RSA |EC |DSA )?PRIVATE KEY-----')
    for name in filter(None, paths):
        path = Path(name)
        if set(path.parts) & PRIVATE_PARTS or path.suffix in PRIVATE_SUFFIXES or path.name.startswith('.env'):
            problems.append(name + ': private/runtime path')
        absolute = ROOT / path
        if absolute.is_file() and key_pattern.search(absolute.read_bytes()):
            problems.append(name + ': private key material')
    if problems:
        raise SystemExit('\n'.join(problems))
    print('Tracked public files contain no database, private key, or environment files.')


if __name__ == '__main__':
    check_public_files()
