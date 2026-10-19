"""Real HTTP integration tests, each with an isolated persistent SQLite database."""
from concurrent.futures import ThreadPoolExecutor
import http.client
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import create_server


class WebTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.database = str(Path(self.temp.name) / 'test.sqlite3')
        self.server = create_server(port=0, database=self.database)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.cookie = ''

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def request(self, path, data=None, cookie=None, headers=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port)
        sent_headers = {'Cookie': self.cookie if cookie is None else cookie}
        if data is not None:
            sent_headers.update({'Content-Type': 'application/json', 'X-Rasteroids-Request': '1'})
        sent_headers.update(headers or {})
        conn.request('POST' if data is not None else 'GET', path,
                     body=json.dumps(data) if data is not None else None, headers=sent_headers)
        response = conn.getresponse()
        body = response.read()
        result = json.loads(body) if 'application/json' in response.getheader('Content-Type', '') else body
        cookie_header = response.getheader('Set-Cookie')
        if cookie_header:
            self.cookie = cookie_header.split(';')[0]
        status, response_headers = response.status, dict(response.getheaders())
        conn.close()
        return status, result, response_headers

    def register(self, name='TestPilot'):
        status, result, headers = self.request('/api/register', {'username': name, 'password': 'a long test password'})
        self.assertEqual(status, 201)
        self.assertIn('HttpOnly', headers['Set-Cookie'])
        self.assertIn('SameSite=Lax', headers['Set-Cookie'])
        return result['user']

    def save(self, score=100, sector=1):
        status, run, _ = self.request('/api/runs', {})
        self.assertEqual(status, 201)
        payload = {'runId': run['runId'], 'score': score, 'sector': sector, 'duration': 0}
        status, result, _ = self.request('/api/scores', payload)
        self.assertEqual(status, 201, result)
        return payload

    def test_account_authentication_and_logout(self):
        user = self.register()
        original_cookie = self.cookie
        self.assertEqual(self.request('/api/me')[1]['user'], user)
        self.assertEqual(self.request('/api/register', {'username': 'testpilot', 'password': 'another password'})[0], 409)
        self.assertEqual(self.request('/api/logout', {})[0], 200)
        self.assertIsNone(self.request('/api/me', cookie=original_cookie)[1]['user'])
        self.assertEqual(self.request('/api/scores')[0], 401)
        self.assertEqual(self.request('/api/login', {'username': 'TestPilot', 'password': 'incorrect password'})[0], 401)
        self.assertEqual(self.request('/api/login', {'username': 'testpilot', 'password': 'a long test password'})[0], 200)
        self.assertEqual(self.request('/api/me')[1]['user']['id'], user['id'])
        with sqlite3.connect(self.database) as db:
            stored = db.execute('SELECT password_hash FROM users').fetchone()[0]
            self.assertNotIn('a long test password', stored)
            self.assertNotEqual(db.execute('SELECT token_hash FROM sessions').fetchone()[0], self.cookie.split('=')[1])

    def test_scores_history_leaderboard_and_idempotency(self):
        self.register()
        payload = self.save(200)
        self.assertEqual(self.request('/api/scores', payload)[0], 200)
        self.assertEqual(self.request('/api/scores', {**payload, 'score': 300})[0], 409)
        self.save(100)
        self.save(400, 2)
        history = self.request('/api/scores')[1]
        self.assertEqual(history['stats'], {'flights': 3, 'best': 400, 'sector': 2})
        self.assertEqual([r['score'] for r in history['scores']], [400, 100, 200])
        self.register('OtherPilot')
        self.save(300)
        board = self.request('/api/leaderboard', cookie='')[1]['entries']
        self.assertEqual([(r['username'], r['score']) for r in board], [('TestPilot', 400), ('OtherPilot', 300)])

    def test_new_pilots_appear_before_their_first_flight(self):
        self.assertEqual(self.request('/api/leaderboard')[1]['entries'], [])
        self.register('NewPilot')
        entries = self.request('/api/leaderboard', cookie='')[1]['entries']
        self.assertEqual(entries, [{'username': 'NewPilot', 'score': None, 'sector': None, 'finished_at': None}])
        self.assertEqual(self.request('/api/scores')[1]['stats']['flights'], 0)
        # Merely starting a flight must not count as a completed score.
        self.request('/api/runs', {})
        self.assertIsNone(self.request('/api/leaderboard')[1]['entries'][0]['score'])
        self.register('ZeroPilot')
        self.save(0)
        entries = self.request('/api/leaderboard')[1]['entries']
        self.assertEqual([(r['username'], r['score']) for r in entries], [('ZeroPilot', 0), ('NewPilot', None)])
        self.assertEqual(self.request('/api/scores')[1]['stats']['flights'], 1)

    def test_run_ownership_validation_and_guest_access(self):
        self.assertEqual(self.request('/api/scores', {})[0], 401)
        self.register()
        payload = self.save()
        self.register('OtherPilot')
        self.assertEqual(self.request('/api/scores', payload)[0], 404)
        run = self.request('/api/runs', {})[1]['runId']
        base = {'runId': run, 'score': 100, 'sector': 1, 'duration': 0}
        for invalid in ({'score': -10}, {'score': True}, {'score': 111}, {'sector': 0}, {'duration': 999999}, {'score': 9999990}):
            self.assertEqual(self.request('/api/scores', {**base, **invalid})[0], 400)
        self.assertEqual(self.request('/api/scores', base)[0], 201)
        with sqlite3.connect(self.database) as db:
            db.execute('UPDATE sessions SET expires_at=0')
        self.assertEqual(self.request('/api/runs', {})[0], 401)

    def test_concurrent_submissions_cannot_change_a_saved_flight(self):
        self.register()
        run = self.request('/api/runs', {})[1]['runId']
        def submit(score):
            return self.request('/api/scores', {'runId': run, 'score': score, 'sector': 1, 'duration': 0})[0]
        with ThreadPoolExecutor(max_workers=2) as executor:
            statuses = list(executor.map(submit, [100, 200]))
        self.assertEqual(sorted(statuses), [201, 409])
        self.assertEqual(self.request('/api/scores')[1]['stats']['flights'], 1)

    def test_csrf_and_static_file_boundaries(self):
        self.assertEqual(self.request('/api/register', {}, headers={'X-Rasteroids-Request': ''})[0], 403)
        self.assertEqual(self.request('/api/register', {}, headers={'Origin': 'https://evil.example'})[0], 403)
        for path in ('/server.py', '/data/rasteroids.sqlite3', '/.git/config', '/../README.md'):
            self.assertEqual(self.request(path)[0], 404)
        status, page, headers = self.request('/')
        self.assertEqual(status, 200)
        self.assertIn(b'id="scoreboard"', page)
        self.assertEqual(headers['X-Content-Type-Options'], 'nosniff')
        self.assertEqual(self.request('/account.js')[0], 200)
        self.assertEqual(self.request('/web.css')[0], 200)

    def test_validation_rate_limits_and_secure_cookies(self):
        self.assertEqual(self.request('/api/register', {'username': '<script>', 'password': 'long test password'})[0], 400)
        self.assertEqual(self.request('/api/register', {'username': 'FineName', 'password': 'short'})[0], 400)
        self.server.secure_cookies = True
        self.register()
        status, _, headers = self.request('/api/login', {'username': 'TestPilot', 'password': 'a long test password'})
        self.assertEqual(status, 200)
        self.assertIn('; Secure', headers['Set-Cookie'])
        for _ in range(26):
            self.request('/api/login', {'username': 'FineName', 'password': 'short'})
        self.assertEqual(self.request('/api/login', {'username': 'FineName', 'password': 'short'})[0], 429)

    def test_proxy_rate_limits_trust_only_explicit_configuration(self):
        credentials = {'username': 'ProxyPilot', 'password': 'short'}
        self.request('/api/login', credentials, headers={'X-Real-IP': '192.0.2.10'})
        with sqlite3.connect(self.database) as db:
            self.assertEqual(db.execute('SELECT key FROM attempts').fetchone()[0], 'auth:127.0.0.1')
        self.server.trust_proxy = True
        self.request('/api/login', credentials, headers={'X-Real-IP': '192.0.2.10'})
        self.request('/api/login', credentials, headers={'X-Real-IP': '2001:db8::1'})
        self.request('/api/login', credentials, headers={'X-Real-IP': '192.0.2.10, 192.0.2.20'})
        with sqlite3.connect(self.database) as db:
            attempts = dict(db.execute('SELECT key, count FROM attempts'))
        self.assertEqual(attempts, {'auth:127.0.0.1': 2, 'auth:192.0.2.10': 1, 'auth:2001:db8::1': 1})

    def test_database_and_sessions_survive_server_restart(self):
        self.register()
        self.save(500)
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.server = create_server(port=0, database=self.database)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.assertEqual(self.request('/api/me')[1]['user']['username'], 'TestPilot')
        self.assertEqual(self.request('/api/scores')[1]['stats']['best'], 500)
        self.assertEqual(self.request('/api/leaderboard')[1]['entries'][0]['score'], 500)


if __name__ == '__main__':
    unittest.main()
