#!/usr/bin/env python3
"""Verify HTTPS, the deployed commit, and the exact public asset checksums."""
import argparse
import hashlib
import json
from urllib.parse import urlsplit
from urllib.request import urlopen


def check_deployment(url, commit=None):
    if urlsplit(url).scheme != 'https':
        raise ValueError('Use the public HTTPS URL.')
    url = url.rstrip('/')
    with urlopen(url + '/version.json', timeout=15) as response:
        version = json.load(response)
    if commit and version.get('commit') != commit:
        raise RuntimeError('The live site is not running the requested commit.')
    expected = version.get('assets', {})
    if set(expected) != {'index.html', 'web.css', 'account.js'}:
        raise RuntimeError('Missing public asset checksums.')
    for name, digest in expected.items():
        with urlopen(url + '/' + name, timeout=15) as response:
            actual = hashlib.sha256(response.read()).hexdigest()
        if actual != digest:
            raise RuntimeError('Live asset differs from this release: ' + name)
    with urlopen(url + '/api/leaderboard', timeout=15) as response:
        assert isinstance(json.load(response)['entries'], list)
    print('Verified live HTTPS release:', version['commit'])
    return version


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', default='https://vps-bbba68b4.vps.ovh.ca')
    parser.add_argument('--commit')
    args = parser.parse_args()
    check_deployment(args.url, args.commit)
