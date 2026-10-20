#!/usr/bin/env bash
# Builds and starts the portal on a public VPS with a Let's Encrypt certificate.
# First run: writes deploy/.env with fresh random secrets, then seeds the admin account and
# Nouria's lines. Later runs (after copying a new release over the old one): rebuild and restart;
# deploy/.env and the database are kept.
# Usage (from the unpacked release folder, as root):
#   sudo bash deploy/vps/deploy.sh portal.manaralab.tech you@example.com
set -euo pipefail

DOMAIN="${1:?usage: deploy.sh <domain> <email for Let's Encrypt>}"
EMAIL="${2:?usage: deploy.sh <domain> <email for Let's Encrypt>}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="$ROOT/deploy/.env"
STATE_DIR=/opt/manara
COMPOSE=(docker compose -f "$ROOT/deploy/docker-compose.yml" --env-file "$ENV_FILE")

rand() { openssl rand -hex "$1"; }

# 1. Configuration with fresh secrets (only when there is none yet).
if [ ! -f "$ENV_FILE" ]; then
  mkdir -p "$STATE_DIR/backups"
  umask 077
  cat > "$ENV_FILE" <<EOF
POSTGRES_DB=workforce
POSTGRES_USER=workforce
POSTGRES_PASSWORD=$(rand 24)
APP_DB_PASSWORD=$(rand 24)
AUDIT_HMAC_KEY=$(rand 32)
AUDIT_HMAC_KEY_PREVIOUS=
LAN_BIND_IP=0.0.0.0
SITE_ADDRESS=$DOMAIN
CADDYFILE=Caddyfile.public
ACME_EMAIL=$EMAIL
TZ_COMPANY=Asia/Amman
BACKUP_DIR=$STATE_DIR/backups
BACKUP_RETENTION_DAYS=30
BACKUP_HOUR=2
BACKUP_PASSPHRASE=$(rand 24)
EOF
  chmod 600 "$ENV_FILE"
  echo "Created $ENV_FILE with new random secrets."
  echo "Copy AUDIT_HMAC_KEY and BACKUP_PASSPHRASE from it into the company password safe:"
  echo "without the passphrase the backups cannot be restored."
fi

# 2. The domain must already point at this server, or Let's Encrypt refuses the certificate.
server_ip="$(curl -fsS4 --max-time 10 https://api.ipify.org || true)"
dns_ip="$(getent ahostsv4 "$DOMAIN" | awk 'NR == 1 { print $1 }')"
if [ -z "$dns_ip" ]; then
  echo "$DOMAIN does not resolve yet. Add a DNS A record: $DOMAIN -> ${server_ip:-the VPS address}, wait a few minutes, run again." >&2
  exit 1
fi
if [ -n "$server_ip" ] && [ "$dns_ip" != "$server_ip" ]; then
  echo "$DOMAIN points to $dns_ip, but this server is $server_ip. Fix the DNS A record first." >&2
  exit 1
fi

# 3. Build and start.
"${COMPOSE[@]}" up -d --build

echo "Waiting for the app to start..."
for _ in $(seq 1 60); do
  if "${COMPOSE[@]}" exec -T app wget -qO- http://127.0.0.1:3000/api/v1/health 2>/dev/null | grep -q '"database":"up"'; then
    ready=1
    break
  fi
  sleep 5
done
if [ -z "${ready:-}" ]; then
  echo "The app did not become healthy. Logs:" >&2
  "${COMPOSE[@]}" logs --tail 80 app >&2
  exit 1
fi

# 4. First run only: reference data, the admin account and Nouria's lines.
if [ ! -f "$STATE_DIR/.seeded" ]; then
  admin_password="$(openssl rand -base64 18 | tr -dc 'A-Za-z0-9' | head -c 16)"
  "${COMPOSE[@]}" exec -T -e SEED_DEFAULT_PASSWORD="$admin_password" app node dist/prisma/seed.js
  "${COMPOSE[@]}" exec -T app node dist/prisma/import-mascot.js
  (umask 077; printf 'username: admin\ntemporary password: %s\n' "$admin_password" > "$STATE_DIR/admin-initial-password.txt")
  touch "$STATE_DIR/.seeded"
  echo
  echo "Admin account created. Username: admin"
  echo "Temporary password (must be changed at first sign-in): $admin_password"
  echo "Also saved in $STATE_DIR/admin-initial-password.txt (delete it after the first sign-in)."
fi

echo
echo "Done: https://$DOMAIN"
echo "The certificate is requested on the first visit and can take up to a minute."
echo "Next: sign in as admin, change the password, then Settings -> Office locations."
