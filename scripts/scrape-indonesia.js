#!/usr/bin/env node
/**
 * Scrape film Indonesia dari https://kconaz.com/country/indonesia/
 * + detail tiap film (sinopsis, tahun, genre, direksi, pemain, player, …).
 *
 * Cara pakai:
 *   node scripts/scrape-indonesia.js
 *   node scripts/scrape-indonesia.js --pages 3
 *   node scripts/scrape-indonesia.js --pages 0          # semua halaman
 *   node scripts/scrape-indonesia.js --delay 300
 *   node scripts/scrape-indonesia.js --refresh-desc
 *
 * Hasil:
 *   - public/data/indonesia.json          (urut tahun/rilis terbaru dulu)
 *   - public/data/indonesia-players.json
 *   - merge ke public/data/players.json
 */

import { writeFile, mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  fetchKconazHtml,
  scrapeIndonesiaListings,
  scrapeIndonesiaDetails,
  extractKconazDetail,
  sortIndonesiaNewestFirst,
} from "./lib/kconaz-indonesia.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DATA_DIR = join(ROOT, "public", "data");
const MOVIES_FILE = join(DATA_DIR, "indonesia.json");
const PLAYERS_FILE = join(DATA_DIR, "indonesia-players.json");
const GLOBAL_PLAYERS_FILE = join(DATA_DIR, "players.json");

function parseArgs(argv) {
  // pages=0 → semua halaman (deteksi dari pagination)
  const out = { pages: 0, delay: 280, start: 1, refreshDesc: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--pages" && argv[i + 1]) out.pages = Math.max(0, Number(argv[++i]) || 0);
    else if (a === "--delay" && argv[i + 1]) out.delay = Math.max(0, Number(argv[++i]) || 280);
    else if (a === "--start" && argv[i + 1]) out.start = Math.max(1, Number(argv[++i]) || 1);
    else if (a === "--refresh-desc") out.refreshDesc = true;
  }
  return out;
}

async function mergeIntoPlayersJson(playersMap) {
  let existing = {};
  try {
    existing = JSON.parse(await readFile(GLOBAL_PLAYERS_FILE, "utf8"));
  } catch {
    existing = {};
  }
  const merged = { ...existing, ...playersMap };
  await writeFile(GLOBAL_PLAYERS_FILE, JSON.stringify(merged, null, 2) + "\n", "utf8");
}

async function refreshDescriptions(opts) {
  let movies;
  try {
    movies = JSON.parse(await readFile(MOVIES_FILE, "utf8"));
  } catch {
    console.error("indonesia.json tidak ditemukan. Jalankan scrape penuh dulu.");
    process.exit(1);
  }

  let ok = 0;
  let failed = 0;
  for (let i = 0; i < movies.length; i++) {
    const movie = movies[i];
    const url = movie.source || `https://kconaz.com/${movie.slug}/`;
    process.stdout.write(`→ [${i + 1}/${movies.length}] ${movie.slug} ... `);
    try {
      const html = await fetchKconazHtml(url);
      const detail = extractKconazDetail(html, movie);
      movie.sinopsis = detail.sinopsis;
      movie.tahun = detail.tahun || movie.tahun;
      movie.rilis = detail.rilis || movie.rilis;
      movie.rilis_iso = detail.rilis_iso || movie.rilis_iso;
      movie.durasi = detail.durasi || movie.durasi;
      movie.genre = detail.genre?.length ? detail.genre : movie.genre;
      movie.negara = detail.negara || movie.negara;
      movie.bahasa = detail.bahasa || movie.bahasa;
      movie.direksi = detail.direksi || movie.direksi;
      movie.pemain = detail.pemain || movie.pemain;
      movie.content_rating = detail.content_rating || movie.content_rating;
      movie.anggaran = detail.anggaran || movie.anggaran;
      movie.pendapatan = detail.pendapatan || movie.pendapatan;
      if (detail.thumbnail) movie.thumbnail = detail.thumbnail;
      if (detail.rating) movie.rating = detail.rating;
      if (detail.players?.length) movie.players = detail.players;
      ok += 1;
      console.log(`OK tahun=${movie.tahun || "?"} (${detail.sinopsis.length} char)`);
    } catch (err) {
      failed += 1;
      console.log(`GAGAL: ${err.message}`);
    }
    if (i < movies.length - 1 && opts.delay) {
      await new Promise((r) => setTimeout(r, opts.delay));
    }
  }

  const sorted = sortIndonesiaNewestFirst(movies);
  sorted.forEach((m, idx) => {
    m.id = idx + 1;
  });
  await writeFile(MOVIES_FILE, JSON.stringify(sorted, null, 2) + "\n", "utf8");
  console.log(`\nSelesai refresh: ${ok} OK, ${failed} gagal, ${sorted.length} total.`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  await mkdir(DATA_DIR, { recursive: true });

  if (opts.refreshDesc) {
    console.log(`Refresh deskripsi film Indonesia (delay ${opts.delay}ms)\n`);
    await refreshDescriptions(opts);
    return;
  }

  const pagesLabel = opts.pages > 0 ? `${opts.pages} halaman` : "semua halaman";
  console.log(
    `Scrape kconaz.com/country/indonesia: ${pagesLabel}, start ${opts.start}, delay ${opts.delay}ms\n`
  );

  const listings = await scrapeIndonesiaListings(opts);
  if (!listings.length) {
    console.error("Tidak ada film ditemukan.");
    process.exit(1);
  }

  console.log(`\nAmbil detail ${listings.length} film...\n`);
  const { movies, playersMap, withPlayers } = await scrapeIndonesiaDetails(listings, opts);

  await writeFile(MOVIES_FILE, JSON.stringify(movies, null, 2) + "\n", "utf8");
  await writeFile(PLAYERS_FILE, JSON.stringify(playersMap, null, 2) + "\n", "utf8");
  await mergeIntoPlayersJson(playersMap);

  const years = [...new Set(movies.map((m) => m.tahun).filter(Boolean))].sort().reverse();
  console.log(
    `\nSelesai.\n` +
      `  indonesia.json         : ${movies.length} film (terbaru dulu)\n` +
      `  indonesia-players.json : ${Object.keys(playersMap).length} entri\n` +
      `  punya player           : ${withPlayers}/${movies.length}\n` +
      `  tahun tersedia         : ${years.slice(0, 8).join(", ")}${years.length > 8 ? ", …" : ""}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
