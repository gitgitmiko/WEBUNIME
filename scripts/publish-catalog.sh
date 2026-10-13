#!/bin/bash
# Setelah scrape berhasil: pull dulu, commit public/data, lalu push.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export GIT_AUTHOR_NAME="${GIT_AUTHOR_NAME:-webunime-scraper[bot]}"
export GIT_AUTHOR_EMAIL="${GIT_AUTHOR_EMAIL:-webunime-scraper[bot]@users.noreply.github.com}"
export GIT_COMMITTER_NAME="${GIT_COMMITTER_NAME:-webunime-scraper[bot]}"
export GIT_COMMITTER_EMAIL="${GIT_COMMITTER_EMAIL:-webunime-scraper[bot]@users.noreply.github.com}"

echo "[publish] pull origin/main"
git pull --rebase --autostash origin main

git add -- public/data
if git diff --staged --quiet; then
  echo "[publish] tidak ada perubahan katalog"
  exit 0
fi

git commit -m "$(cat <<'EOF'
chore(data): sync katalog LK21 + Samehadaku + Anoboy TV+mobile (done)

EOF
)"

echo "[publish] pull ulang sebelum push"
git pull --rebase origin main
git push origin HEAD:main
echo "[publish] katalog sudah di-push"
