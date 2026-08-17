#!/usr/bin/env node
/**
 * Anoboy scraper (manual + terbaru).
 *
 * Full katalog /anime/ (resume):
 *   node scripts/scrape-anoboy.js
 *   node scripts/scrape-anoboy.js --pages 2 --limit 5
 *   node scripts/scrape-anoboy.js --resume
 *
 * Lengkapi metadata judul Anoboy (hub only, bukan episode):
 *   node scripts/scrape-anoboy.js --meta
 *   node scripts/scrape-anoboy.js --meta --limit 1
 *   node scripts/scrape-anoboy.js --meta --hub https://anoboy.xyz/2026/07/hanaori-san-wa-tensei-shitemo-kenka-ga-shitai/
 *
 * Terbaru (homepage, untuk uji GitHub Action):
 *   node scripts/scrape-anoboy.js --latest
 *   node scripts/scrape-anoboy.js --latest --pages 2
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  enrichAnoboyMeta,
  scrapeAnoboyFull,
  syncAnoboyLatest,
} from "./lib/anoboy-sync.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);

function argVal(name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
}

const latest = argv.includes("--latest");
const meta = argv.includes("--meta");
const pages = Number(argVal("--pages", latest ? "3" : "0")) || 0;

if (meta) {
  const result = await enrichAnoboyMeta(ROOT, {
    limit: Number(argVal("--limit", "0")) || 0,
    resume: argv.includes("--resume"),
    hub: argVal("--hub", "") || "",
  });
  console.log(JSON.stringify(result, null, 2));
} else if (latest) {
  const dataDir = join(ROOT, "public", "data");
  const mobileDir = join(dataDir, "mobile");
  const result = await syncAnoboyLatest(dataDir, [mobileDir], {
    pages: pages || 3,
    limit: Number(argVal("--limit", "0")) || 0,
  });
  console.log(JSON.stringify(result, null, 2));
} else {
  const result = await scrapeAnoboyFull(ROOT, {
    pages,
    start: Number(argVal("--start", "1")) || 1,
    limit: Number(argVal("--limit", "0")) || 0,
    resume: argv.includes("--resume"),
    maxEpsPerHub: Number(argVal("--max-eps", "80")) || 80,
  });
  console.log(JSON.stringify(result, null, 2));
}
