#!/usr/bin/env node
/**
 * Oploverz scraper → anime.json + anime-movies.json (TV + mobile).
 *
 * Semua seri (±1000 judul, fetch JSON biasa, tanpa browser):
 *   node scripts/scrape-oploverz.js
 *   node scripts/scrape-oploverz.js --limit 20 --dry-run
 *
 * Seri tertentu (slug Oploverz, pisahkan koma):
 *   node scripts/scrape-oploverz.js --series one-piece,black-clover
 *
 * Tambah --bulk agar judul baru ditaruh di akhir & tanpa tanda baru (impor susulan).
 *
 * Terbaru (episode terbaru di beranda):
 *   node scripts/scrape-oploverz.js --latest --pages 2
 *
 * Domain aktif: otomatis (lihat source-domains.js), override: OPLOVERZ_BASE=https://...
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { syncOploverz, syncOploverzLatest } from "./lib/oploverz-sync.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const argVal = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};

const dataDir = join(ROOT, "public", "data");
const dirs = [dataDir, join(dataDir, "mobile")];
const opts = {
  limit: Number(argVal("--limit", "0")) || 0,
  pages: Number(argVal("--pages", "2")) || 2,
  dryRun: argv.includes("--dry-run"),
  movies: !argv.includes("--no-movies"),
  // --bulk: judul baru di akhir katalog & tanpa is_new (default untuk impor penuh).
  ...(argv.includes("--bulk") ? { bulk: true } : {}),
  slugs: argVal("--series", "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
};

const result = argv.includes("--latest")
  ? await syncOploverzLatest(dirs, opts)
  : await syncOploverz(dirs, opts);

if (!argv.includes("--verbose")) {
  result.series.addedSlugs = `${result.series.addedSlugs.length} judul`;
}
console.log(JSON.stringify(result, null, 2));
if (opts.dryRun) console.log("[oploverz] dry-run: katalog tidak ditulis");
