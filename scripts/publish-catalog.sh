#!/bin/bash
# Setelah scrape berhasil: commit public/data, rebase ke origin/main, lalu push.
# Commit dulu sebelum pull supaya data hasil scrape tidak ikut autostash (autostash yang
# bentrok bikin repo macet dengan file "unmerged" setelah internet sempat mati).
# Commit yang gagal di-push tetap tersimpan dan di-push ulang oleh run berikutnya.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# shellcheck source=git-heal.sh
source "$ROOT/scripts/git-heal.sh"

export GIT_AUTHOR_NAME="${GIT_AUTHOR_NAME:-webunime-scraper[bot]}"
export GIT_AUTHOR_EMAIL="${GIT_AUTHOR_EMAIL:-webunime-scraper[bot]@users.noreply.github.com}"
export GIT_COMMITTER_NAME="${GIT_COMMITTER_NAME:-webunime-scraper[bot]}"
export GIT_COMMITTER_EMAIL="${GIT_COMMITTER_EMAIL:-webunime-scraper[bot]@users.noreply.github.com}"

git_heal local

# Jangan commit JSON rusak (commit rusak akan memblokir semua publish berikutnya);
# file itu dikembalikan ke versi terakhir, sisanya tetap di-publish.
if ! bad="$(git_invalid_json HEAD)"; then
  echo "[publish] JSON rusak, dikembalikan ke versi sebelumnya:" $bad
  for f in $bad; do git checkout HEAD -- "$f" 2>/dev/null || rm -f -- "$f"; done
fi

git add -- public/data
if git diff --staged --quiet; then
  echo "[publish] tidak ada perubahan katalog baru"
else
  git commit -q -m "$(cat <<'MSG'
chore(data): sync katalog dan refresh player film serta series terbaru

MSG
)"
  echo "[publish] katalog di-commit"
fi

for attempt in 1 2 3; do
  echo "[publish] pull origin/main (percobaan $attempt)"
  before_rebase="$(git rev-parse HEAD)"
  # -X theirs: saat rebase, "theirs" = commit lokal, jadi data hasil scrape terbaru menang.
  if ! git pull --rebase --autostash -X theirs origin main; then
    git_heal local
    echo "[publish] pull gagal, commit lokal disimpan untuk run berikutnya"
    exit 1
  fi
  git_heal upstream

  if [ "$(git_ahead_count)" -eq 0 ]; then
    echo "[publish] tidak ada commit untuk di-push"
    exit 0
  fi
  # Merge baris per baris saat rebase bisa (jarang) menghasilkan JSON tidak valid;
  # kalau terjadi, pakai utuh versi lokal sebelum rebase.
  if ! bad="$(git_invalid_json origin/main)"; then
    echo "[publish] JSON rusak setelah rebase, pakai versi lokal utuh:" $bad
    for f in $bad; do git checkout "$before_rebase" -- "$f"; done
    git commit -q -m "chore(data): perbaiki JSON katalog setelah rebase"
  fi

  if git push origin HEAD:main; then
    echo "[publish] katalog sudah di-push"
    exit 0
  fi
  echo "[publish] push gagal, coba lagi"
  sleep 5
done

echo "[publish] push gagal 3x, commit lokal disimpan untuk run berikutnya"
exit 1
