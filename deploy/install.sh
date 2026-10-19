#!/usr/bin/env bash
# Run as root from an uploaded release. Existing production data is preserved.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo 'Run this installer with sudo.' >&2
  exit 1
fi
site_hostname="${1:-vps-bbba68b4.vps.ovh.ca}"
if [[ ! "$site_hostname" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]+$ ]]; then
  echo 'Supply a DNS hostname.' >&2
  exit 1
fi
release_source="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
test -f "$release_source/server.py"
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y caddy

if ! id rasteroids >/dev/null 2>&1; then
  useradd --system --user-group --home-dir /var/lib/rasteroids --no-create-home --shell /usr/sbin/nologin rasteroids
fi
install -d -m 755 /opt/rasteroids /opt/rasteroids/assets /opt/rasteroids/deploy
for asset in server.py index.html account.js web.css version.json; do
  install -m 644 "$release_source/$asset" "/opt/rasteroids/$asset"
done
install -m 644 "$release_source/assets/icon.svg" /opt/rasteroids/assets/icon.svg
install -m 644 "$release_source/deploy/backup.py" /opt/rasteroids/deploy/backup.py
install -d -o rasteroids -g rasteroids -m 700 /var/lib/rasteroids /var/backups/rasteroids
# Optional migration snapshot alongside the release; never overwrite live accounts.
if [[ -f "$release_source/rasteroids.sqlite3" && ! -e /var/lib/rasteroids/rasteroids.sqlite3 ]]; then
  install -o rasteroids -g rasteroids -m 600 "$release_source/rasteroids.sqlite3" /var/lib/rasteroids/rasteroids.sqlite3
fi
install -m 644 "$release_source/deploy/rasteroids.service" /etc/systemd/system/rasteroids.service
install -m 644 "$release_source/deploy/rasteroids-backup.service" /etc/systemd/system/rasteroids-backup.service
install -m 644 "$release_source/deploy/rasteroids-backup.timer" /etc/systemd/system/rasteroids-backup.timer
if [[ -f /etc/caddy/Caddyfile && ! -e /etc/caddy/Caddyfile.pre-rasteroids ]]; then
  cp -p /etc/caddy/Caddyfile /etc/caddy/Caddyfile.pre-rasteroids
fi
sed "s/vps-bbba68b4.vps.ovh.ca/$site_hostname/g" "$release_source/deploy/Caddyfile" > /etc/caddy/Caddyfile
chmod 644 /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl daemon-reload
systemctl enable rasteroids.service caddy.service rasteroids-backup.timer
systemctl restart rasteroids.service
systemctl reload-or-restart caddy.service
systemctl start rasteroids-backup.timer
systemctl start rasteroids-backup.service
# Keep SSH accessible before applying the firewall to IPv4 and IPv6.
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw --force enable
systemctl is-active rasteroids.service caddy.service rasteroids-backup.timer
printf 'Site: https://%s\n' "$site_hostname"
