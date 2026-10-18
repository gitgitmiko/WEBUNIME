#!/bin/bash
# Dijalankan cron tiap 30 menit: cek halaman pertama sumber; kalau ada konten baru
# baru jalankan sync catalog + refresh player film/series, lalu publish.
# flock mencegah dua run saling tabrakan bila sync sebelumnya belum selesai.
set -uo pipefail

export PATH="/home/gitgitmiko/.hermes/tools/node-26.7.0-linux-x64/bin:$PATH"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR=/home/gitgitmiko/cron/scraper
LOG="$LOG_DIR/scraper.log"
LOCK="$LOG_DIR/catalog-watch.lock"
cd "$ROOT"

exec 9>"$LOCK"
if ! flock -n 9; then
  echo "[watch] $(date -u +%FT%TZ) run sebelumnya masih berjalan, lewati" >> "$LOG"
  exit 0
fi

# rotasi log sederhana (>5 MB)
if [ -f "$LOG" ] && [ "$(stat -c %s "$LOG")" -gt 5242880 ]; then
  mv "$LOG" "$LOG.1"
fi

log() { echo "[watch] $(date -u +%FT%TZ) $*" >> "$LOG"; }
run() { "$@" >> "$LOG" 2>&1; }

log "pull kode"
before_lock=$(sha1sum package-lock.json | cut -d' ' -f1)
run git pull --rebase --autostash origin main || { log "git pull gagal"; exit 1; }
[ "$before_lock" != "$(sha1sum package-lock.json | cut -d' ' -f1)" ] && run npm ci

log "cek halaman pertama"
node scripts/check-new-content.js >> "$LOG" 2>&1
code=$?
if [ "$code" -eq 10 ]; then log "tidak ada konten baru"; exit 0; fi
if [ "$code" -ne 0 ]; then log "cek gagal (exit $code)"; exit "$code"; fi

log "ada konten baru, sync catalog"
run npm run sync:catalog || { log "sync:catalog gagal, tidak di-commit"; exit 1; }

fail=0
log "refresh player film"
run npm run scrape:refresh-players || { log "refresh player film gagal"; fail=1; }
log "refresh player series"
run npm run scrape:refresh-series-players || { log "refresh player series gagal"; fail=1; }

log "publish"
run bash scripts/publish-catalog.sh || { log "publish gagal"; exit 1; }
if grep -qE '^DB_USER=.+' .env 2>/dev/null; then
  log "import katalog ke MySQL"
  run node server/import-catalog.js || { log "import MySQL gagal"; fail=1; }
fi
log "selesai (fail=$fail)"
exit "$fail"
