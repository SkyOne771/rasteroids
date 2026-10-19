# Deployment and operations

- Live site: https://vps-bbba68b4.vps.ovh.ca
- Source: https://github.com/SkyOne771/rasteroids
- Live commit and asset hashes: https://vps-bbba68b4.vps.ovh.ca/version.json

## Automatic updates

`.github/workflows/ci.yml` runs source-derived documentation checks, public-file checks, Python integration tests on 3.10/3.12/3.14, JavaScript regressions, and desktop/mobile browser tests. Only successful pushes to this repository's `main` branch deploy. Pull requests have no deployment credentials. The production environment is restricted to `main`.

The deployment job packages its exact `github.sha`, uploads a checksummed archive, invokes the installed helper, and verifies the public HTTPS commit and actual HTML/CSS/JavaScript hashes. A failed check blocks deployment. A failed application health check restores the previous code. Tests and documentation changes are versioned alongside the implementation.

### GitHub configuration

Environment: `production`, allowed deployment branch: `main`.

| Setting | Kind | Purpose |
| --- | --- | --- |
| `OVH_DEPLOY_KEY` | Production environment secret | Dedicated deployment account's private SSH key |
| `OVH_HOST` | Repository variable | VPS address |
| `OVH_HOST_KEY` | Repository variable | Previously verified SSH host-key entry; strict checking is enabled |

Credentials and runtime databases are excluded from Git. The CI key belongs to a separate `rasteroids-deploy` user. Its SSH key disallows forwarding and PTY allocation. The user can upload a release and invoke `/usr/local/sbin/rasteroids-deploy`; it cannot replace root-owned proxy, service, firewall, or deployment-helper configuration.

The installed helper is a root-owned copy of `deploy/update.py`, reached through a no-argument wrapper and a narrowly scoped sudoers rule. Bootstrap/update this host policy through an administrator session; it is deliberately not replaced by an incoming application release.

## Host layout

- App: `/opt/rasteroids`, owned by root and run as the `rasteroids` system user.
- App listener: `127.0.0.1:8000`; Caddy provides public HTTPS and redirects HTTP.
- Database: `/var/lib/rasteroids/rasteroids.sqlite3`, outside the code directory.
- Database snapshots: `/var/backups/rasteroids`, seven latest consistent snapshots.
- Previous automatic releases: `/var/backups/rasteroids-releases/auto-*`, five latest.
- Incoming release: `/var/lib/rasteroids-deploy/release.tar.gz`.
- Installed updater: `/usr/local/lib/rasteroids/update.py`.
- Proxy config: `/etc/caddy/Caddyfile`.
- Services: `rasteroids.service`, `caddy.service`, `rasteroids-backup.timer`.

Caddy overwrites `X-Real-IP` with the client's actual address. The backend enables Secure cookies and explicitly trusts that header only from loopback, avoiding a shared login-attempt limit for every player. The firewall permits SSH and HTTP/HTTPS; port 8000 is not exposed publicly.

## Initial installation

For a new dedicated Ubuntu VPS with administrator access, upload the project, run its checks, and then run:

```sh
sudo bash deploy/install.sh your.public.hostname
```

This installs Caddy, copies the application, configures services and firewall rules, and starts a first backup. Its optional initial database import only occurs when the production database does not already exist. Bootstrap the restricted CI user/helper and GitHub settings above separately; existing production accounts must never be reimported from a development database.

A custom domain can replace the VPS hostname in `/etc/caddy/Caddyfile` once DNS points to the VPS. Validate the configuration and reload Caddy. Keep the live URL in the README, workflow environment, checker default, and repository homepage consistent.

## Manual verified release

Usually GitHub Actions performs these steps. From a clean checked-out commit, administrators can package and deploy the same release format:

```sh
python3 scripts/generate_docs.py --check
python3 -m unittest discover -s tests -p 'test_*.py' -v
npm ci
npm test
npm run test:browser
npm run test:mobile
python3 scripts/package_release.py --commit "$(git rev-parse HEAD)"
scp release.tar.gz rasteroids-deploy@YOUR_VPS:/var/lib/rasteroids-deploy/release.tar.gz
ssh rasteroids-deploy@YOUR_VPS 'sudo -n /usr/local/sbin/rasteroids-deploy'
python3 scripts/check_deployment.py --commit "$(git rev-parse HEAD)"
```

Use the appropriate private SSH identity through your local SSH configuration. The archive includes only application files, version metadata, and a checksum manifest. Database files, credentials, and deployment policy are never included. The helper validates paths, file types, sizes, completeness, checksums, and commit identity before stopping the app.

## Operations

Run these from an administrator SSH session:

```sh
sudo systemctl status rasteroids caddy --no-pager
sudo journalctl -u rasteroids -n 50 --no-pager
sudo journalctl -u caddy -n 50 --no-pager
sudo systemctl restart rasteroids
sudo systemctl list-timers rasteroids-backup.timer
sudo systemctl start rasteroids-backup.service
sudo journalctl -u rasteroids-backup.service -n 10 --no-pager
```

A failed CI run is visible in [GitHub Actions](https://github.com/SkyOne771/rasteroids/actions). The job logs identify a documentation, test, connection, release-validation, or health-check failure. A green deployment run plus `scripts/check_deployment.py --commit SHA` verifies that the live public assets match that commit.

## Backups and recovery

`deploy/backup.py` uses SQLite's online backup API, checks integrity, creates mode-0600 snapshots, and retains seven copies. Both live WAL backup/restore and file permissions are tested. Daily snapshots are local to the VPS: copy snapshots off-host to protect against full server loss. OVH's system backups are separate.

Before restoring data, stop the app, take a fresh consistent snapshot of its current state, restore the selected verified snapshot as the `rasteroids` user with mode 0600, and restart the app. Do not copy only the main file of a running WAL database. Code rollback does not roll back account/score data; future schema changes need an explicit migration and recovery plan.

The standard-library app server targets a small deployment behind Caddy. Larger public traffic should move to a hardened application server and shared database.
