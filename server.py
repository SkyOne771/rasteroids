#!/usr/bin/env python3
"""Rasteroids web server. Python 3.10+, standard library only."""
import argparse
from contextlib import closing, contextmanager
import hashlib
import hmac
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import time
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent
SESSION_AGE = 30 * 24 * 60 * 60
SCHEMA = """
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS users (
 id INTEGER PRIMARY KEY, username TEXT NOT NULL COLLATE NOCASE UNIQUE,
 password_hash TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
 token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
 id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
 started_at INTEGER NOT NULL, finished_at INTEGER, score INTEGER, sector INTEGER, duration INTEGER
);
CREATE INDEX IF NOT EXISTS runs_scores ON runs(score DESC, finished_at);
CREATE INDEX IF NOT EXISTS runs_user ON runs(user_id, finished_at DESC);
CREATE TABLE IF NOT EXISTS attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
"""


def password_hash(password, salt=None):
    salt = salt or secrets.token_hex(16)
    digest = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1).hex()
    return f"{salt}:{digest}"


def token_hash(token):
    return hashlib.sha256(token.encode()).hexdigest()


class APIError(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message


class Handler(BaseHTTPRequestHandler):
    @contextmanager
    def db(self):
        connection = sqlite3.connect(self.server.database, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute('PRAGMA foreign_keys=ON')
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def log_message(self, fmt, *args):
        # Do not log credentials, cookies, or run tokens.
        if not self.path.startswith('/api/'):
            super().log_message(fmt, *args)

    def reply(self, status, data, cookie=None):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.security_headers()
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        if cookie:
            self.send_header('Set-Cookie', cookie)
        self.end_headers()
        self.wfile.write(body)

    def security_headers(self):
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Referrer-Policy', 'same-origin')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")

    def cookie(self, token='', age=SESSION_AGE):
        secure = '; Secure' if self.server.secure_cookies else ''
        return f'rasteroids_session={token}; HttpOnly; SameSite=Lax; Path=/; Max-Age={age}{secure}'

    def session_token(self):
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get('Cookie', ''))
            return cookie['rasteroids_session'].value if 'rasteroids_session' in cookie else ''
        except Exception:
            return ''

    def user(self, db, required=True):
        row = db.execute('SELECT u.id, u.username FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?',
                         (token_hash(self.session_token()), int(time.time()))).fetchone()
        if row is None and required:
            raise APIError(401, 'Sign in to save your flights.')
        return dict(row) if row else None

    def body(self):
        if self.headers.get('X-Rasteroids-Request') != '1':
            raise APIError(403, 'Request verification failed. Reload and try again.')
        origin = self.headers.get('Origin')
        if origin and urlsplit(origin).netloc != self.headers.get('Host'):
            raise APIError(403, 'Cross-origin requests are not allowed.')
        if self.headers.get_content_type() != 'application/json':
            raise APIError(415, 'Send a JSON request.')
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 4096:
                raise ValueError()
            value = json.loads(self.rfile.read(size))
            if not isinstance(value, dict):
                raise ValueError()
            return value
        except (ValueError, UnicodeDecodeError):
            raise APIError(400, 'Invalid request body.')

    def limit(self, db, category, maximum, window):
        now = int(time.time())
        address = self.client_address[0]
        # Only an explicitly trusted loopback proxy may supply the real client IP.
        if self.server.trust_proxy and ipaddress.ip_address(address).is_loopback:
            try:
                address = str(ipaddress.ip_address(self.headers.get('X-Real-IP', '')))
            except ValueError:
                pass
        key = f'{category}:{address}'
        db.execute('DELETE FROM attempts WHERE expires_at<=?', (now,))
        db.execute('INSERT INTO attempts VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1', (key, now + window))
        count = db.execute('SELECT count FROM attempts WHERE key=?', (key,)).fetchone()[0]
        db.commit()
        if count > maximum:
            raise APIError(429, 'Too many attempts. Please try again later.')

    def do_GET(self):
        path = urlsplit(self.path).path
        if path.startswith('/api/'):
            self.api('GET', path)
            return
        # Explicit public allowlist: never expose the database, sources, or repository.
        files = {'/': ('index.html', 'text/html'), '/version.json': ('version.json', 'application/json'), '/index.html': ('index.html', 'text/html'),
                 '/account.js': ('account.js', 'text/javascript'), '/web.css': ('web.css', 'text/css'),
                 '/assets/icon.svg': ('assets/icon.svg', 'image/svg+xml')}
        if path not in files:
            self.reply(404, {'error': 'Not found.'})
            return
        name, content_type = files[path]
        body = (ROOT / name).read_bytes()
        self.send_response(200)
        self.security_headers()
        self.send_header('Content-Type', content_type + '; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-cache')
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        self.api('POST', urlsplit(self.path).path)

    def api(self, method, path):
        try:
            with self.db() as db:
                if method == 'GET' and path == '/api/me':
                    return self.reply(200, {'user': self.user(db, False)})
                if method == 'GET' and path == '/api/leaderboard':
                    # Include registered pilots before their first completed flight.
                    rows = db.execute('''WITH ranked AS (
                      SELECT r.*, ROW_NUMBER() OVER(PARTITION BY user_id ORDER BY score DESC, finished_at, id) AS place
                      FROM runs r WHERE finished_at IS NOT NULL
                    ) SELECT u.username, r.score, r.sector, r.finished_at FROM users u
                    LEFT JOIN ranked r ON r.user_id=u.id AND r.place=1
                    ORDER BY r.score IS NULL, r.score DESC, r.finished_at, u.created_at, u.username COLLATE NOCASE
                    LIMIT 50''').fetchall()
                    return self.reply(200, {'entries': [dict(row) for row in rows]})
                if method == 'GET' and path == '/api/scores':
                    user = self.user(db)
                    stats = dict(db.execute('SELECT COUNT(*) AS flights, COALESCE(MAX(score),0) AS best, COALESCE(MAX(sector),0) AS sector FROM runs WHERE user_id=? AND finished_at IS NOT NULL', (user['id'],)).fetchone())
                    rows = db.execute('SELECT score, sector, duration, finished_at FROM runs WHERE user_id=? AND finished_at IS NOT NULL ORDER BY finished_at DESC, rowid DESC LIMIT 20', (user['id'],)).fetchall()
                    return self.reply(200, {'stats': stats, 'scores': [dict(row) for row in rows]})
                if method != 'POST':
                    raise APIError(404, 'Not found.')
                data = self.body()
                if path in ('/api/register', '/api/login'):
                    self.limit(db, 'auth', 30, 15 * 60)
                    username, password = data.get('username'), data.get('password')
                    if not isinstance(username, str) or not re.fullmatch(r'[a-zA-Z0-9_]{3,20}', username):
                        raise APIError(400, 'Pilot name must be 3–20 letters, numbers, or underscores.')
                    if not isinstance(password, str) or not 10 <= len(password) <= 128:
                        raise APIError(400, 'Password must be 10–128 characters.')
                    if path == '/api/register':
                        try:
                            cursor = db.execute('INSERT INTO users(username,password_hash,created_at) VALUES (?,?,?)', (username, password_hash(password), int(time.time())))
                        except sqlite3.IntegrityError:
                            raise APIError(409, 'That pilot name is already taken.')
                        user = {'id': cursor.lastrowid, 'username': username}
                    else:
                        row = db.execute('SELECT * FROM users WHERE username=?', (username,)).fetchone()
                        stored = row['password_hash'] if row else '00' * 16 + ':' + '00' * 64
                        computed = password_hash(password, stored.split(':')[0])
                        if not hmac.compare_digest(computed, stored):
                            raise APIError(401, 'Pilot name or password is incorrect.')
                        user = {'id': row['id'], 'username': row['username']}
                    token = secrets.token_urlsafe(32)
                    db.execute('DELETE FROM sessions WHERE expires_at<=? OR token_hash=?', (int(time.time()), token_hash(self.session_token())))
                    db.execute('INSERT INTO sessions VALUES (?,?,?)', (token_hash(token), user['id'], int(time.time()) + SESSION_AGE))
                    db.commit()
                    return self.reply(201 if path == '/api/register' else 200, {'user': user}, self.cookie(token))
                if path == '/api/logout':
                    db.execute('DELETE FROM sessions WHERE token_hash=?', (token_hash(self.session_token()),))
                    db.commit()
                    return self.reply(200, {'ok': True}, self.cookie(age=0))
                user = self.user(db)
                if path == '/api/runs':
                    self.limit(db, f'runs:{user["id"]}', 120, 60 * 60)
                    now = int(time.time())
                    db.execute('DELETE FROM runs WHERE finished_at IS NULL AND started_at<?', (now - 86400,))
                    run_id = secrets.token_urlsafe(24)
                    db.execute('INSERT INTO runs(id,user_id,started_at) VALUES (?,?,?)', (run_id, user['id'], now))
                    db.commit()
                    return self.reply(201, {'runId': run_id})
                if path == '/api/scores':
                    run_id, score, sector, duration = (data.get(k) for k in ('runId', 'score', 'sector', 'duration'))
                    if not isinstance(run_id, str) or any(type(v) is not int for v in (score, sector, duration)):
                        raise APIError(400, 'Invalid flight result.')
                    db.execute('BEGIN IMMEDIATE')
                    row = db.execute('SELECT * FROM runs WHERE id=? AND user_id=?', (run_id, user['id'])).fetchone()
                    if row is None:
                        raise APIError(404, 'Flight not found. Start a new game while signed in.')
                    now = int(time.time())
                    age = now - row['started_at']
                    if not (0 <= score <= 10000000 and score % 10 == 0 and 1 <= sector <= 10000 and 0 <= duration <= age + 2 and age <= 86400 and score <= (duration + 2) * 3000):
                        raise APIError(400, 'Flight result is outside the allowed limits.')
                    if row['finished_at'] is not None:
                        if (row['score'], row['sector'], row['duration']) != (score, sector, duration):
                            raise APIError(409, 'This flight has already been saved.')
                        return self.reply(200, {'saved': True})
                    db.execute('UPDATE runs SET score=?,sector=?,duration=?,finished_at=? WHERE id=? AND finished_at IS NULL', (score, sector, duration, now, run_id))
                    db.commit()
                    return self.reply(201, {'saved': True})
                raise APIError(404, 'Not found.')
        except APIError as error:
            self.reply(error.status, {'error': error.message})
        except sqlite3.Error:
            self.reply(503, {'error': 'Storage is temporarily unavailable. Please retry.'})


def create_server(host='127.0.0.1', port=8000, database=None, secure_cookies=False, trust_proxy=False):
    database = str(database or ROOT / 'data' / 'rasteroids.sqlite3')
    Path(database).parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(database)) as db:
        db.executescript(SCHEMA)
    server = ThreadingHTTPServer((host, port), Handler)
    server.database, server.secure_cookies = database, secure_cookies
    server.trust_proxy = trust_proxy
    return server


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', default=os.environ.get('HOST', '127.0.0.1'))
    parser.add_argument('--port', type=int, default=int(os.environ.get('PORT', '8000')))
    parser.add_argument('--database', default=os.environ.get('DATABASE_PATH'))
    parser.add_argument('--secure-cookies', action='store_true', default=os.environ.get('SECURE_COOKIES') == '1')
    parser.add_argument('--trust-proxy', action='store_true', default=os.environ.get('TRUST_PROXY') == '1', help='Trust X-Real-IP from a loopback reverse proxy')
    args = parser.parse_args()
    server = create_server(args.host, args.port, args.database, args.secure_cookies, args.trust_proxy)
    print(f'Rasteroids: http://{args.host}:{server.server_port}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
