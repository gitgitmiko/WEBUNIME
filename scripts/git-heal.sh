#!/bin/bash
# Helper git untuk cron katalog (di-source oleh run-catalog-watch.sh dan publish-catalog.sh).
# Tujuannya: kalau run sebelumnya terputus (mis. internet mati di tengah pull/publish),
# repo dipulihkan otomatis sehingga run berikutnya bisa lanjut tanpa campur tangan manual.

# Batalkan rebase/merge yang tertinggal dan selesaikan file yang masih konflik.
# $1 = "upstream" (ambil versi origin/HEAD) atau "local" (ambil versi hasil scrape lokal).
git_heal() {
  local prefer="${1:-upstream}"
  local gitdir
  gitdir="$(git rev-parse --git-dir)"

  if [ -d "$gitdir/rebase-merge" ] || [ -d "$gitdir/rebase-apply" ]; then
    echo "[git-heal] rebase tertinggal, abort"
    git rebase --abort || true
  fi
  if [ -f "$gitdir/MERGE_HEAD" ]; then
    echo "[git-heal] merge tertinggal, abort"
    git merge --abort || true
  fi

  local files
  files="$(git diff --name-only --diff-filter=U)"
  [ -z "$files" ] && return 0

  echo "[git-heal] file konflik ($prefer menang):" $files
  local f
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    # Konflik autostash: stage 2 = HEAD (upstream), stage 3 = stash (lokal).
    # Kalau file di worktree sudah ditulis ulang oleh scrape (tanpa penanda konflik),
    # itulah data terbaru; kalau masih berisi penanda, pakai versi stash.
    if [ "$prefer" = "local" ] && [ -f "$f" ] && ! grep -qE '^(<<<<<<<|>>>>>>>) ' "$f"; then
      git add -- "$f"
    elif [ "$prefer" = "local" ] && git checkout --theirs -- "$f" 2>/dev/null; then
      git add -- "$f"
    else
      git checkout HEAD -- "$f" 2>/dev/null || git rm -q --cached -- "$f"
    fi
  done <<< "$files"
  # Lepas file dari index supaya pull/stash berikutnya tidak menolak.
  git reset -q
}

# Cetak file JSON di public/data (worktree) yang berubah dibanding $1 (default HEAD)
# tapi tidak bisa di-parse. Exit 1 bila ada yang rusak.
git_invalid_json() {
  local ref="${1:-HEAD}" bad=0 f
  command -v node >/dev/null || return 0
  while IFS= read -r f; do
    [ -f "$f" ] || continue
    if ! node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$f" 2>/dev/null; then
      echo "$f"
      bad=1
    fi
  done < <({ git diff --name-only "$ref" -- 'public/data/*.json'; git ls-files -o --exclude-standard -- 'public/data/*.json'; } | sort -u)
  return "$bad"
}

# Jumlah commit lokal yang belum di-push ke origin/main.
git_ahead_count() {
  git rev-list --count origin/main..HEAD 2>/dev/null || echo 0
}
