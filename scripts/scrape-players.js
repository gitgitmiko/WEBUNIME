#!/usr/bin/env node
/**
 * Scraper daftar player (server streaming) dari halaman film LK21.
 *
 * Cara pakai:
 *   node scripts/scrape-players.js <url-atau-slug> [<url-atau-slug> ...]
 *
 * Contoh:
 *   node scripts/scrape-players.js double-occupancy-2026
 *   node scripts/scrape-players.js https://tv12.lk21official.cc/double-occupancy-2026
 *
 * Hasil:
 *   - public/data/players.json  -> peta { slug: { film, source, scraped_at, players[] } }
 *   - public/data/movies.json   -> field `slug` + `players` ikut diperbarui bila slug cocok
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DATA_DIR = join(ROOT, "public", "data");
const PLAYERS_FILE = join(DATA_DIR, "players.json");
const MOVIES_FILE = join(DATA_DIR, "movies.json");

const BASE_URL = "https://tv12.lk21official.cc";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

/** Ubah teks menjadi slug (huruf kecil, tanpa simbol, dipisah tanda hubung). */
function slugify(text) {
  return String(text)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-");
}

/** Normalisasi argumen jadi { url, slug }. Terima URL penuh atau sekadar slug. */
function resolveTarget(arg) {
  let url = arg.trim();
  if (!/^https?:\/\//i.test(url)) {
    url = `${BASE_URL}/${url.replace(/^\/+/, "")}`;
  }
  const slug = new URL(url).pathname.replace(/^\/+|\/+$/g, "");
  return { url, slug };
}

/** Ambil HTML halaman film. */
async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} saat memuat ${url}`);
  }
  return res.text();
}

/** Ekstrak <option> di dalam <select id="player-select"> menjadi daftar player. */
function extractPlayers(html) {
  const selectMatch = html.match(
    /<select[^>]*id=["']player-select["'][^>]*>([\s\S]*?)<\/select>/i
  );
  const scope = selectMatch ? selectMatch[1] : html;

  const optionRe =
    /<option\s+value=["'](?<url>[^"']+)["']\s+data-server=["'](?<server>[^"']*)["'](?<rest>[^>]*)>(?<label>[\s\S]*?)<\/option>/gi;

  const players = [];
  let m;
  let no = 0;
  while ((m = optionRe.exec(scope)) !== null) {
    no += 1;
    const { url, server, rest, label } = m.groups;
    players.push({
      no,
      server,
      label: label.replace(/<[^>]*>/g, "").trim(),
      url,
      default: /\bselected\b/i.test(rest),
    });
  }
  return players;
}

/** Ambil judul film dari <title> atau <h1> sebagai info tambahan. */
function extractTitle(html) {
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) return h1[1].replace(/<[^>]*>/g, "").trim();
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return title ? title[1].replace(/\s*[-|].*$/, "").trim() : "";
}

async function readJson(file, fallback) {
  if (!existsSync(file)) return { data: fallback, ok: false };
  try {
    // buang BOM (UTF-8) agar JSON.parse tidak gagal
    const raw = (await readFile(file, "utf8")).replace(/^\uFEFF/, "");
    return { data: JSON.parse(raw), ok: true };
  } catch (err) {
    return { data: fallback, ok: false, error: err };
  }
}

async function scrapeOne(arg) {
  const { url, slug } = resolveTarget(arg);
  process.stdout.write(`→ Scraping ${slug} ... `);
  const html = await fetchHtml(url);
  const players = extractPlayers(html);
  const film = extractTitle(html) || slug;
  console.log(`${players.length} player ditemukan`);
  return { slug, source: url, film, scraped_at: new Date().toISOString(), players };
}

/** Gabungkan hasil scrape ke movies.json berdasarkan kecocokan slug. */
function mergeIntoMovies(movies, entry) {
  const movie = movies.find((mv) => {
    if (mv.slug) return mv.slug === entry.slug;
    return slugify(`${mv.nama} ${mv.tahun}`) === entry.slug;
  });
  if (!movie) return false;
  movie.slug = entry.slug;
  movie.source = entry.source;
  movie.players = entry.players;
  return true;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("Pemakaian: node scripts/scrape-players.js <url-atau-slug> [...]");
    process.exit(1);
  }

  await mkdir(DATA_DIR, { recursive: true });
  const playersRes = await readJson(PLAYERS_FILE, {});
  const playersMap = playersRes.data;
  const moviesRes = await readJson(MOVIES_FILE, []);
  const movies = moviesRes.data;

  // Pengaman: kalau movies.json ADA tapi gagal diparse, jangan sentuh file itu
  // supaya data yang ada tidak tertimpa array kosong.
  const moviesWritable = moviesRes.ok && Array.isArray(movies);
  if (existsSync(MOVIES_FILE) && !moviesRes.ok) {
    console.warn("! movies.json gagal diparse — file tidak akan diubah demi keamanan.");
  }

  let matched = 0;
  for (const arg of args) {
    try {
      const entry = await scrapeOne(arg);
      playersMap[entry.slug] = entry;
      if (moviesWritable && mergeIntoMovies(movies, entry)) {
        matched += 1;
        console.log(`   ✓ digabung ke movies.json`);
      } else {
        console.log(`   • tidak ada film cocok di movies.json (hanya disimpan ke players.json)`);
      }
    } catch (err) {
      console.error(`   ✗ gagal: ${err.message}`);
    }
  }

  await writeFile(PLAYERS_FILE, JSON.stringify(playersMap, null, 2) + "\n", "utf8");
  if (moviesWritable) {
    await writeFile(MOVIES_FILE, JSON.stringify(movies, null, 2) + "\n", "utf8");
  }

  console.log(
    `\nSelesai. players.json diperbarui (${Object.keys(playersMap).length} film), ${matched} film tergabung ke movies.json.`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
