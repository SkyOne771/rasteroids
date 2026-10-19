# Architecture

Rasteroids Web separates a client-side simulation from persistent account and score services. The browser renders and advances the game locally, so network latency affects online operations rather than steering or firing.

## Browser and input

`index.html` contains the game, Canvas renderer, keyboard handling, and Pointer Events handlers. `web.css` adds the responsive account/leaderboard layout and touch pad. Keyboard state and a pointer-ID map own their inputs independently, allowing multiple fingers and keyboard/touch combinations without one release cancelling another source.

Pointers are captured on held controls. Release, cancellation, and lost capture clear the corresponding pointer. Pause, restart, and game over clear held input; hidden-page and orientation events pause active play. Touch action buttons activate from pointer input because a non-primary finger does not reliably produce a compatibility click; duplicate clicks are suppressed while keyboard activation remains available.

The canvas uses a fixed 480×300 game space. CSS scales it, and landscape layouts keep the control pad next to the playfield. Static scenery is cached, expired particles are removed, and the simulation limits large animation time steps.

## Account and flight lifecycle

`account.js` owns forms, profile/history requests, leaderboard rendering, and score submission. A launch waits for the initial session lookup, then a signed-in pilot requests an opaque run ID. Restart abandons that run. The ordinary game-over path submits the run ID, score, sector, and elapsed duration.

The server associates the run with its account and verifies the session again when saving. A repeat of the same result succeeds without creating another flight; an attempt to change an already-saved result is rejected. Failed result submissions stay queued in tab memory and can be retried while signed in. A failure to register the run at launch cannot be reconstructed as a trusted run afterward.

UI updates use text content rather than injecting pilot names as HTML. Asynchronous profile and leaderboard requests guard against stale responses replacing a newer view.

## HTTP and authentication

`server.py` uses `ThreadingHTTPServer` and a fixed public file allowlist. JSON mutations require the custom request header, JSON content type, a small request body, and a matching Origin/Host when Origin is present. Public responses include framing, MIME-sniffing, referrer, and content-policy headers.

Pilot names are unique case-insensitively. Passwords use a per-account random salt and scrypt. Random session tokens are delivered through HttpOnly, SameSite cookies and stored only as hashes; production cookies are Secure. Logout removes the current server-side token. Sessions expire after the configured lifetime.

Request limits are recorded in SQLite by client IP. Direct requests ignore forwarded headers. With `--trust-proxy`, only loopback connections may supply `X-Real-IP`, which Caddy overwrites with the actual peer address. The backend binds to loopback in production.

## Persistence

SQLite stores users, sessions, runs, and rate-limit attempts. Foreign keys link sessions and runs to a user. WAL mode supports concurrent readers, while score finalization takes a write transaction so competing requests cannot change a saved flight.

The public leaderboard uses a window query to choose one best completed flight per pilot. Completed scores rank before new pilots, which appear without an invented score or rank. Personal history contains the most recent 20 completed flights.

Runtime data lives outside `/opt/rasteroids` in production. Online backups use SQLite's backup API, check integrity, keep a bounded snapshot history, and use restrictive file permissions. Tests restore a live WAL snapshot and verify its records.

## Delivery

The GitHub Actions workflow separates checks from the deployment job. Pull requests run without deployment secrets; only passing commits pushed to the owner repository's `main` branch reach production. Documentation is generated from source and checked for drift.

A release archive contains a strict set of application files, a commit identifier, and SHA-256 checksums. The installed deployment helper rejects unexpected paths, duplicates, links, oversized entries, incomplete releases, and checksum mismatches. It never executes an install script from the incoming archive or replaces its own root-owned helper.

Before applying a release, it creates database and code backups. It then restarts the app and checks the reported commit plus database-backed leaderboard. A failed check restores the previous application files. A separate public HTTPS check verifies the commit and actual HTML/CSS/JavaScript hashes after deployment.

CI deploys application files, not SSH/firewall/proxy/systemd policy. Administrative changes to that host configuration require the documented setup/update process.
