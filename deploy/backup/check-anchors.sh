#!/bin/sh
# Compares the live audit chain with the anchors written next to each backup.
# Every anchored row must still exist with the same hash. A missing row means the end of the
# chain was cut off (or rows were deleted); a different hash means rows were rewritten.
#   docker compose -f deploy/docker-compose.yml --env-file deploy/.env exec backup sh /check-anchors.sh
# Optional argument: a folder of anchors (default /backups), e.g. a copy kept off the server.
# Run GET /api/v1/audit-logs/verify as well: it checks every link between the anchors.
set -eu
dir="${1:-/backups}"
checked=0
failed=0
for anchor in $(ls "$dir"/workforce-*.anchor.txt 2>/dev/null | sort); do
  seq=$(sed -n 's/^audit_seq=//p' "$anchor")
  hash=$(sed -n 's/^audit_hash=//p' "$anchor")
  case "$seq" in
    '') continue ;;               # backup of an empty audit log
    *[!0-9]*) echo "BAD    $anchor: audit_seq is not a number" >&2; failed=$((failed + 1)); continue ;;
  esac
  live=$(psql --no-psqlrc -At -c "SELECT hash FROM audit_logs WHERE seq = $seq")
  if [ -z "$live" ]; then
    echo "MISSING $(basename "$anchor"): audit row seq=$seq no longer exists (chain cut or rows deleted)"
    failed=$((failed + 1))
  elif [ "$live" != "$hash" ]; then
    echo "CHANGED $(basename "$anchor"): audit row seq=$seq has a different hash"
    failed=$((failed + 1))
  fi
  checked=$((checked + 1))
done
head=$(psql --no-psqlrc -At -c 'SELECT coalesce(max(seq), 0) FROM audit_logs')
echo "checked $checked anchor(s) against the live chain (current head seq=$head): $failed problem(s)"
[ "$failed" -eq 0 ]
