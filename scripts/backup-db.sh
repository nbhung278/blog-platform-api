#!/usr/bin/env bash
# Daily Postgres backup -> S3.
# Install as: sudo cp backup-db.sh /etc/cron.daily/blog-pg-backup && sudo chmod +x /etc/cron.daily/blog-pg-backup
# Requires: aws CLI configured, BACKUP_BUCKET env in /etc/environment or hardcoded below.
set -euo pipefail

APP_DIR=/opt/blog-platform-backend
BACKUP_BUCKET=${BACKUP_BUCKET:-strix-blog-backups}
RETENTION_DAYS=30

cd "$APP_DIR"
TS=$(date +%F)
DUMP_FILE="db-${TS}.sql.gz"

source .env

docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" | gzip | \
  aws s3 cp - "s3://${BACKUP_BUCKET}/postgres/${DUMP_FILE}"

# Retention: delete dumps older than RETENTION_DAYS (S3 lifecycle is preferred,
# this is a belt-and-braces fallback).
CUTOFF=$(date -d "${RETENTION_DAYS} days ago" +%F)
aws s3 ls "s3://${BACKUP_BUCKET}/postgres/" | awk '{print $4}' | while read -r f; do
  [ -z "$f" ] && continue
  FDATE=$(echo "$f" | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}' || true)
  [ -z "$FDATE" ] && continue
  if [[ "$FDATE" < "$CUTOFF" ]]; then
    aws s3 rm "s3://${BACKUP_BUCKET}/postgres/${f}"
  fi
done

echo "Backup complete: ${DUMP_FILE}"
