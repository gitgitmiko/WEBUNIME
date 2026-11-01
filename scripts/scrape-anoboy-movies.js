#!/usr/bin/env node
/**
 * Anime movie Anoboy → anime-movies.json (merge dengan Samehadaku).
 *
 *   node scripts/scrape-anoboy-movies.js --all            semua halaman
 *   node scripts/scrape-anoboy-movies.js --pages 2        halaman terbaru
 *   node scripts/scrape-anoboy-movies.js --all --dry-run  tanpa menulis file
 *   node scripts/scrape-anoboy-movies.js --report f.json  simpan hasil lengkap
 */
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { syncAnoboyMovies } from "./lib/anoboy-movies.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const argVal = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};

const dataDir = join(ROOT, "public", "data");
const result = await syncAnoboyMovies([dataDir, join(dataDir, "mobile")], {
  all: argv.includes("--all"),
  pages: Number(argVal("--pages", "2")) || 2,
  limit: Number(argVal("--limit", "0")) || 0,
  dryRun: argv.includes("--dry-run"),
});
const report = argVal("--report", "");
if (report) await writeFile(report, JSON.stringify(result, null, 2) + "\n", "utf8");
console.log(JSON.stringify({ ...result, addedSlugs: undefined, pairs: undefined, skippedTitles: undefined }, null, 2));
