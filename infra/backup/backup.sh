#!/bin/sh
# Nightly pg_dump with rotation, off-VM rclone push, and a Sentry alert on
# failure (spec §9: a backup that quietly stops running is worse than none).
# POSIX sh on purpose -- the postgres alpine image has no bash.
set -u

RETENTION="${BACKUP_RETENTION_DAYS:-14}"
BACKUP_DIR="${BACKUP_DIR:-/backups}"
INTERVAL_SECONDS=$(( 24 * 60 * 60 ))

# --- Sentry alerting (optional -- no-op without SENTRY_DSN) -----------------
# Posts a minimal event envelope to the DSN's store endpoint. Deliberately
# primitive: no SDK dependency, fixed message strings (no JSON-escaping risk).
alert() {
  [ -n "${SENTRY_DSN:-}" ] || return 0
  dsn_host="$(printf '%s' "$SENTRY_DSN" | sed -E 's#^https?://[^/]+@([^/]+)/.*$#\1#')"
  dsn_key="$(printf '%s' "$SENTRY_DSN" | sed -E 's#^https?://([^@/]+)@.*$#\1#')"
  dsn_project="$(printf '%s' "$SENTRY_DSN" | sed -E 's#^.*/([^/?]+)$#\1#')"
  event_id="$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  body="$(printf '{"event_id":"%s"}\n{"type":"event","content_type":"application/json"}\n{"message":"%s","level":"error","platform":"other","environment":"production"}' \
    "$event_id" "$1")"
  curl -fsS -m 10 -X POST "https://${dsn_host}/api/${dsn_project}/envelope/" \
    -H "X-Sentry-Key: ${dsn_key}" \
    -H "Content-Type: application/x-sentry-envelope" \
    -d "$body" >/dev/null 2>&1 \
    || echo "[$(date -u +%FT%TZ)] WARNING: failed to deliver Sentry alert" >&2
}

wait_for_pg() {
  until pg_isready -d "$DATABASE_URL" >/dev/null 2>&1; do
    echo "[$(date -u +%FT%TZ)] waiting for postgres..."
    sleep 5
  done
}

run_backup() {
  ts="$(date -u +%Y%m%d_%H%M%S)"
  dump="${BACKUP_DIR}/taakify_${ts}.sql"

  # Dump and gzip as separate steps: POSIX sh has no pipefail, and pg_dump's
  # own exit code is the one that matters.
  if ! pg_dump "$DATABASE_URL" -f "$dump"; then
    rm -f "$dump"
    echo "[$(date -u +%FT%TZ)] ERROR: pg_dump failed" >&2
    return 1
  fi
  if ! gzip -f "$dump"; then
    rm -f "$dump"
    echo "[$(date -u +%FT%TZ)] ERROR: gzip failed" >&2
    return 1
  fi
  echo "[$(date -u +%FT%TZ)] dumped ${dump}.gz ($(du -h "${dump}.gz" | cut -f1))"

  # Rotate: keep the newest $RETENTION dumps.
  ls -1t "${BACKUP_DIR}"/taakify_*.sql.gz 2>/dev/null \
    | tail -n "+$((RETENTION + 1))" \
    | while IFS= read -r stale; do
        echo "[$(date -u +%FT%TZ)] rotating out $stale"
        rm -f "$stale"
      done

  if [ -n "${RCLONE_REMOTE:-}" ]; then
    if ! rclone copy "${BACKUP_DIR}" "${RCLONE_REMOTE}" --include 'taakify_*.sql.gz'; then
      echo "[$(date -u +%FT%TZ)] ERROR: rclone push to ${RCLONE_REMOTE} failed" >&2
      return 1
    fi
    echo "[$(date -u +%FT%TZ)] pushed backups to ${RCLONE_REMOTE}"
  else
    # Loud on purpose: on-VM-only backups are exactly the false confidence
    # the spec calls out (losing the VM loses the backups too).
    echo "[$(date -u +%FT%TZ)] WARNING: RCLONE_REMOTE not set -- backups are on-VM only!" >&2
  fi
  return 0
}

mkdir -p "$BACKUP_DIR"
wait_for_pg

# First run fires immediately (so a fresh deploy proves itself), then daily.
# A failed cycle alerts and retries on the next one instead of dying -- but
# see docker-compose.prod.yml: restart policy covers a crashing loop too.
while :; do
  if run_backup; then
    :
  else
    alert "Taakify nightly backup failed (see backup sidecar logs)"
  fi
  sleep "$INTERVAL_SECONDS"
done
