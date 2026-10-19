# Contributing

The game has no third-party runtime dependencies. Python 3.10+ runs the application; Node.js 22+ and Playwright are development/test tools.

## Set up

```sh
python3 server.py
npm ci
npx playwright install --with-deps chromium
```

Use a separate temporary database for experiments, for example `python3 server.py --database /tmp/rasteroids-dev.sqlite3`. Never commit production databases, session data, credentials, or private SSH keys.

## Before proposing a change

```sh
python3 scripts/generate_docs.py
python3 scripts/generate_docs.py --check
python3 -m unittest discover -s tests -p 'test_*.py' -v
npm test
npm run test:browser
npm run test:mobile
```

The documentation generator derives interface details from the actual Python and HTML source and records a hash of runtime files. CI rejects stale generated documentation. Review the explanatory README and architecture/deployment guides whenever behavior changes; generated references cannot validate prose or replace review.

Browser tests create their own isolated server/database. Mobile tests use Chromium touch input and eight viewport sizes, including simultaneous gestures, cancellation, rotation, pause/restart, touch-earned scores, and persistence. Physical iOS/Safari coverage is separate and must be reported honestly. `NATURAL_GAME=1 npm run test:browser` optionally plays a full game without editing game state.

Keep fixes focused, describe the behavior and validation, and include screenshots for visible changes. Update screenshots with `npm run screenshots` when the layout changes. Pull requests run checks without production credentials. Passing pushes to `main` deploy automatically to the live OVH site; a failed test or stale reference prevents deployment.

See [NOTICE.md](NOTICE.md) for project attribution and licensing context.
