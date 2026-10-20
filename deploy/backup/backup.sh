#!/bin/sh
# Nightly logical backup (custom format, compressed) with retention, optional encryption and an
# audit-chain anchor next to every dump.
#   sh /backup.sh          service loop (one backup a day at BACKUP_HOUR)
#   sh /backup.sh --once   one backup now
# Restore and anchor checks: see docs/deployment.md ("Backups").
set -eu
# Busybox ash supports pipefail; without it a failed pg_dump inside the encryption pipe would go unnoticed.
set -o pipefail
umask 077
mkdir -p /backups

if [ -n "${BACKUP_PASSPHRASE:-}" ]; then
  if ! command -v openssl >/dev/null 2>&1; then
    echo "BACKUP_PASSPHRASE is set but openssl is not installed in the backup image; refusing to write unencrypted dumps" >&2
    exit 1
  fi
  if [ "${#BACKUP_PASSPHRASE}" -lt 16 ]; then
    echo "BACKUP_PASSPHRASE must be at least 16 characters" >&2
    exit 1
  fi
  mode="encrypted (AES-256-CBC, PBKDF2)"
else
  mode="NOT encrypted (set BACKUP_PASSPHRASE to encrypt)"
fi

# Latest audit row as "seq hash"; empty when the table is empty.
audit_head() {
  psql --no-psqlrc -At -F ' ' -c 'SELECT seq, hash FROM audit_logs ORDER BY seq DESC LIMIT 1'
}

# One backup: anchor query, dump (optionally encrypted), then the anchor file.
run_backup() {
  stamp=$(date +%Y%m%d-%H%M%S)
  base="/backups/workforce-$stamp"
  # The anchor is read before the dump starts, so every row it names is inside the dump.
  head=$(audit_head)
  if [ -n "${BACKUP_PASSPHRASE:-}" ]; then
    file="$base.dump.enc"
    pg_dump --format=custom --no-owner \
      | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BACKUP_PASSPHRASE -out "$file.partial"
  else
    file="$base.dump"
    pg_dump --format=custom --no-owner --file="$file.partial"
  fi
  chmod 600 "$file.partial"
  mv "$file.partial" "$file"

  anchor="$base.anchor.txt"
  {
    echo "# Audit chain head at backup time. How to check: docs/deployment.md, \"Audit anchors\"."
    echo "taken_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "dump=$(basename "$file")"
    echo "dump_sha256=$(sha256sum "$file" | cut -d' ' -f1)"
    echo "audit_seq=${head%% *}"
    echo "audit_hash=${head#* }"
  } > "$anchor.partial"
  chmod 600 "$anchor.partial"
  mv "$anchor.partial" "$anchor"
  echo "backup ok: $file ($(du -h "$file" | cut -f1)), audit head seq=${head%% *}"
}

if [ "${1:-}" = "--once" ]; then
  run_backup
  exit 0
fi

echo "backup service started; daily at ${BACKUP_HOUR}:00 (${TZ}), keeping ${BACKUP_RETENTION_DAYS} days, $mode"
while true; do
  now_h=$(date +%H | sed 's/^0//'); now_m=$(date +%M | sed 's/^0//'); now_s=$(date +%S | sed 's/^0//')
  secs_now=$(( ${now_h:-0} * 3600 + ${now_m:-0} * 60 + ${now_s:-0} ))
  target=$(( BACKUP_HOUR * 3600 ))
  wait=$(( (target - secs_now + 86400) % 86400 ))
  [ "$wait" -eq 0 ] && wait=86400
  sleep "$wait"
  # A separate shell so `set -e` applies inside the run (it is ignored inside an `if` condition).
  if ! sh "$0" --once; then
    rm -f /backups/*.partial
    echo "backup FAILED at $(date)" >&2
  fi
  # Dumps expire; anchors are tiny and are kept, so a later cut of the audit tail stays detectable.
  find /backups \( -name 'workforce-*.dump' -o -name 'workforce-*.dump.enc' \) -mtime +"$BACKUP_RETENTION_DAYS" -delete
done
