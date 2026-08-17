#!/usr/bin/env node
/**
 * Scrape film LK21 + detail player.
 *
 * Cara pakai:
 *   node scripts/scrape-latest.js --pages 50
 *   node scripts/scrape-latest.js --all-years --merge   # arsip per tahun (cap 50 hlm/tahun)
 *   node scripts/scrape-latest.js --year 2023 --pages 50 --merge
 *   node scripts/scrape-latest.js --refresh-desc
 *
 * Hasil: public/data/movies.json + players.json
 * --merge: judul lama tetap, hanya tambah slug baru (wajib untuk --year/--all-years).
 */

import { writeFile, mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { extractLk21Quality } from "./lib/lk21-quality.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DATA_DIR = join(ROOT, "public", "data");
const PLAYERS_FILE = join(DATA_DIR, "players.json");
const MOVIES_FILE = join(DATA_DIR, "movies.json");

const BASE_URL = "https://tv12.lk21official.cc";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const ARCHIVE_YEARS = [
  2026, 2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018, 2017, 2016, 2015, 2014,
  2013, 2012, 2011, 2010, 2009, 2008, 2007,
];

function parseArgs(argv) {
  const out = {
    pages: 0,
    delay: 350,
    start: 1,
    refreshDesc: false,
    merge: false,
    years: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--pages" && argv[i + 1]) out.pages = Math.max(1, Number(argv[++i]) || 10);
    else if (a === "--delay" && argv[i + 1]) out.delay = Math.max(0, Number(argv[++i]) || 350);
    else if (a === "--start" && argv[i + 1]) out.start = Math.max(1, Number(argv[++i]) || 1);
    else if (a === "--refresh-desc") out.refreshDesc = true;
    else if (a === "--merge") out.merge = true;
    else if (a === "--all-years") out.years = [...ARCHIVE_YEARS];
    else if ((a === "--year" || a === "--years") && argv[i + 1]) {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n >= 1900) out.years.push(n);
    }
  }
  if (out.years.length) out.merge = true;
  if (!out.pages) out.pages = out.years.length ? 50 : 10;
  return out;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchPage(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "id-ID,id;q=0.9,en;q=0.8",
      Referer: `${BASE_URL}/`,
    },
    redirect: "follow",
  });
  const html = await res.text();
  return { html, ok: res.ok, finalUrl: res.url, status: res.status };
}

async function fetchHtml(url) {
  const { html, ok, status, finalUrl } = await fetchPage(url);
  if (!ok) throw new Error(`HTTP ${status} ${url}`);
  if (looksLikeHome(finalUrl, html) && !/\/latest\/?$/.test(url) && !/\/[a-z0-9-]+-\d{4}\/?$/.test(url)) {
    throw new Error(`Redirect beranda — ${url}`);
  }
  return html;
}

function looksLikeHome(finalUrl, html) {
  try {
    const path = new URL(finalUrl).pathname;
    if (path === "/" || path === "") return html.length > 150000;
  } catch {
    /* ignore */
  }
  return false;
}

function listingPageUrl(page, year) {
  if (year) {
    if (page <= 1) return `${BASE_URL}/year/${year}`;
    return `${BASE_URL}/year/${year}/page/${page}`;
  }
  if (page <= 1) return `${BASE_URL}/latest`;
  return `${BASE_URL}/latest/page/${page}`;
}

function stripTags(html) {
  return String(html || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeEntities(text) {
  return String(text || "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/** HTML → teks, jaga baris baru dari <br>/<p> */
function htmlToMultilineText(html) {
  return decodeEntities(
    String(html || "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<\/div>/gi, "\n")
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/gi, " ")
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** PT2H11M / PT22M → 2j 11m / 22m */
function formatDuration(isoOrText) {
  const raw = String(isoOrText || "").trim();
  if (!raw) return "";
  const iso = raw.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
  if (iso) {
    const h = Number(iso[1] || 0);
    const m = Number(iso[2] || 0);
    if (h && m) return `${h}j ${m}m`;
    if (h) return `${h}j`;
    if (m) return `${m}m`;
    return "";
  }
  const hm = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (hm) {
    const h = Number(hm[1]);
    const m = Number(hm[2]);
    if (h === 0) return `${m}m`;
    return `${h}j ${m}m`;
  }
  return raw;
}

function slugFromPath(pathname) {
  return String(pathname || "")
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter(Boolean)
    .pop();
}

function cleanTitle(title) {
  let t = decodeEntities(stripTags(title));
  t = t
    .replace(/^Nonton\s+/i, "")
    .replace(/\s+Sub\s+Indo.*$/i, "")
    .replace(/\s+di\s+Lk21.*$/i, "")
    .replace(/^Lk21\s+Nonton\s+/i, "")
    .trim();
  return t;
}

function splitNamaTahun(judul) {
  const m = judul.match(/^(.*?)(?:\s*\((\d{4})\))\s*$/);
  if (m) return { nama: m[1].trim(), tahun: m[2] };
  const y = judul.match(/\b(19|20)\d{2}\b/);
  return { nama: judul.replace(/\s*\(\d{4}\)\s*$/, "").trim(), tahun: y?.[0] || "" };
}

/** Ekstrak kartu film dari halaman /latest */
function extractListings(html) {
  const items = [];
  const re =
    /<article\b[^>]*itemtype=["']https?:\/\/schema\.org\/Movie["'][^>]*>([\s\S]*?)<\/article>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const block = m[0];
    const href = block.match(/itemprop=["']url["'][^>]*href=["']([^"']+)["']/i)?.[1]
      || block.match(/href=["']([^"']+)["']/i)?.[1];
    if (!href) continue;

    let path;
    try {
      path = new URL(href, BASE_URL).pathname;
    } catch {
      continue;
    }
    const slug = slugFromPath(path);
    if (!slug || /^(latest|search|genre|year|page)/i.test(slug)) continue;

    const genreRaw =
      block.match(/itemprop=["']genre["'][^>]*content=["']([^"']+)["']/i)?.[1] || "";
    const rating =
      block.match(/itemprop=["']ratingValue["'][^>]*>([^<]+)/i)?.[1]?.trim() ||
      block.match(/itemprop=["']ratingValue["'][^>]*content=["']([^"']+)["']/i)?.[1] ||
      "";
    const year =
      block.match(/itemprop=["']datePublished["'][^>]*>([^<]+)/i)?.[1]?.trim() ||
      block.match(/class=["']year["'][^>]*>([^<]+)/i)?.[1]?.trim() ||
      "";
    const durationIso =
      block.match(/itemprop=["']duration["'][^>]*content=["']([^"']+)["']/i)?.[1] || "";
    const durationText =
      block.match(/itemprop=["']duration["'][^>]*content=["'][^"']*["'][^>]*>([^<]+)/i)?.[1]?.trim() ||
      block.match(/class=["']duration["'][^>]*>([^<]+)/i)?.[1]?.trim() ||
      "";
    // Di listing LK21, atribut content sering template (PT2H7M) — utamakan teks tampilan HH:MM
    const durasi = formatDuration(durationText) || formatDuration(durationIso);

    const poster =
      block.match(/itemprop=["']image["'][^>]*content=["']([^"']+)["']/i)?.[1] ||
      block.match(/<img[^>]+src=["']([^"']+)["']/i)?.[1] ||
      "";
    const title =
      block.match(/itemprop=["']name["'][^>]*content=["']([^"']+)["']/i)?.[1] ||
      block.match(/alt=["']([^"']+)["']/i)?.[1] ||
      slug;

    items.push({
      slug,
      path,
      source: `${BASE_URL}/${slug}`,
      title: cleanTitle(title),
      tahun: year,
      rating: rating || null,
      quality: extractLk21Quality(block) || null,
      durasi,
      genre: genreRaw
        .split(",")
        .map((g) => g.trim())
        .filter(Boolean),
      thumbnail: poster,
    });
  }
  return items;
}

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
      label: stripTags(label),
      url,
      default: /\bselected\b/i.test(rest),
    });
  }
  return players;
}

function extractSynopsisBlock(html) {
  const m = html.match(
    /<div[^>]*class=["'][^"']*\bsynopsis\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i
  );
  return m ? htmlToMultilineText(m[1]) : "";
}

function extractDetailLines(html) {
  const m = html.match(
    /<div[^>]*class=["'][^"']*\bdetail\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i
  );
  if (!m) return [];
  const lines = [];
  const pRe = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let pm;
  while ((pm = pRe.exec(m[1])) !== null) {
    const text = htmlToMultilineText(pm[1])
      .replace(/[ \t]+/g, " ")
      .replace(/\s+,/g, ",")
      .replace(/,\s*/g, ", ")
      .trim();
    if (text) lines.push(text);
  }
  return lines;
}

function buildFullDescription(html, judul) {
  const synopsis = extractSynopsisBlock(html);
  const detailLines = extractDetailLines(html);
  if (synopsis || detailLines.length) {
    return [synopsis, ...detailLines].filter(Boolean).join("\n\n");
  }

  // Fallback: meta description (sering pendek / hanya cast)
  const metaDesc = decodeEntities(
    html.match(/property=["']og:description["'][^>]*content=["']([^"']+)["']/i)?.[1] ||
      html.match(/name=["']description["'][^>]*content=["']([^"']+)["']/i)?.[1] ||
      ""
  ).trim();

  let sinopsis = metaDesc;
  if (/^Saksikan aksi seru/i.test(sinopsis.replace(/^Streaming\s+.+?\.\s*/i, ""))) {
    const cast = sinopsis
      .replace(/^Streaming\s+.+?\.\s*/i, "")
      .replace(/^Saksikan aksi seru\s*/i, "");
    sinopsis = cast ? `${judul}. Dibintangi ${cast}.` : `Nonton ${judul} subtitle Indonesia.`;
  } else {
    sinopsis =
      sinopsis
        .replace(/^Streaming\s+.+?\s+gratis[^.]*\.\s*/i, "")
        .replace(/^Nonton\s+.+?\s+gratis[^.]*\.\s*/i, "")
        .trim() || metaDesc;
  }
  return sinopsis || `Film ${judul}.`;
}

function extractDetailMeta(html, fallback = {}) {
  const h1 = cleanTitle(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || "");
  const ogTitle = cleanTitle(
    html.match(/property=["']og:title["'][^>]*content=["']([^"']+)["']/i)?.[1] || ""
  );
  const judul = h1 || ogTitle || fallback.title || fallback.judul || fallback.slug;

  const poster =
    html.match(/property=["']og:image["'][^>]*content=["']([^"']+)["']/i)?.[1] ||
    fallback.thumbnail ||
    "";

  return {
    judul,
    sinopsis: buildFullDescription(html, judul),
    thumbnail: poster,
    durasi: fallback.durasi || "",
  };
}

async function scrapeListingPages({ start, pages, delay, year }) {
  const bySlug = new Map();
  const end = start + pages - 1;
  const label = year ? `year/${year}` : "latest";

  for (let page = start; page <= end; page++) {
    const url = listingPageUrl(page, year);
    process.stdout.write(`→ ${label} ${page}/${end} ... `);
    try {
      const { html, finalUrl, ok } = await fetchPage(url);
      if (!ok || looksLikeHome(finalUrl, html)) {
        console.log("beranda/kosong — stop");
        break;
      }
      const items = extractListings(html);
      if (!items.length) {
        console.log("0 kartu — stop");
        break;
      }
      let added = 0;
      for (const item of items) {
        if (!bySlug.has(item.slug)) {
          bySlug.set(item.slug, item);
          added += 1;
        }
      }
      console.log(`${items.length} kartu, +${added} unik (total ${bySlug.size})`);
    } catch (err) {
      console.log(`GAGAL: ${err.message}`);
    }
    if (page < end && delay) await sleep(delay);
  }

  return [...bySlug.values()];
}

async function scrapeDetails(listings, { delay }) {
  const movies = [];
  const playersMap = {};
  let withPlayers = 0;

  for (let i = 0; i < listings.length; i++) {
    const item = listings[i];
    const n = i + 1;
    process.stdout.write(`→ [${n}/${listings.length}] ${item.slug} ... `);
    try {
      const html = await fetchHtml(item.source);
      const players = extractPlayers(html);
      const detail = extractDetailMeta(html, item);
      const { nama, tahun } = splitNamaTahun(detail.judul);

      const movie = {
        id: n,
        nama: nama || item.title || item.slug,
        judul: detail.judul.includes("(") ? detail.judul : `${nama || item.title} (${tahun || item.tahun || ""})`.replace(/\(\s*\)/, "").trim(),
        tahun: tahun || item.tahun || "",
        thumbnail: detail.thumbnail || item.thumbnail,
        rating: item.rating || null,
        quality: item.quality || null,
        durasi: detail.durasi || item.durasi || "",
        genre: item.genre?.length ? item.genre : [],
        sinopsis: detail.sinopsis,
        slug: item.slug,
        source: item.source,
        players,
      };

      movies.push(movie);
      playersMap[item.slug] = {
        slug: item.slug,
        film: movie.judul,
        source: item.source,
        scraped_at: new Date().toISOString(),
        players,
      };

      if (players.length) withPlayers += 1;
      console.log(`${players.length} player`);
    } catch (err) {
      console.log(`GAGAL: ${err.message}`);
      // Tetap masukkan listing dasar tanpa players
      const { nama, tahun } = splitNamaTahun(item.title);
      movies.push({
        id: n,
        nama: nama || item.title,
        judul: item.title,
        tahun: tahun || item.tahun || "",
        thumbnail: item.thumbnail,
        rating: item.rating,
        quality: item.quality || null,
        durasi: item.durasi,
        genre: item.genre,
        sinopsis: `Film ${item.title}.`,
        slug: item.slug,
        source: item.source,
        players: [],
      });
    }

    if (i < listings.length - 1 && delay) await sleep(delay);
  }

  return { movies, playersMap, withPlayers };
}

/** Perbarui sinopsis lengkap dari halaman detail, tanpa scrape ulang listing/player */
async function refreshDescriptions({ delay }) {
  let movies;
  try {
    movies = JSON.parse(await readFile(MOVIES_FILE, "utf8"));
  } catch {
    console.error("movies.json tidak ditemukan. Jalankan scrape penuh dulu.");
    process.exit(1);
  }
  if (!Array.isArray(movies) || !movies.length) {
    console.error("movies.json kosong.");
    process.exit(1);
  }

  let ok = 0;
  let failed = 0;
  for (let i = 0; i < movies.length; i++) {
    const movie = movies[i];
    const url = movie.source || `${BASE_URL}/${movie.slug}`;
    process.stdout.write(`→ [${i + 1}/${movies.length}] ${movie.slug} ... `);
    try {
      const html = await fetchHtml(url);
      const detail = extractDetailMeta(html, movie);
      movie.sinopsis = detail.sinopsis;
      if (detail.thumbnail) movie.thumbnail = detail.thumbnail;
      ok += 1;
      const preview = detail.sinopsis.replace(/\s+/g, " ").slice(0, 70);
      console.log(`OK (${detail.sinopsis.length} char) ${preview}…`);
    } catch (err) {
      failed += 1;
      console.log(`GAGAL: ${err.message}`);
    }
    if (i < movies.length - 1 && delay) await sleep(delay);
  }

  await writeFile(MOVIES_FILE, JSON.stringify(movies, null, 2) + "\n", "utf8");
  console.log(`\nSelesai refresh deskripsi: ${ok} OK, ${failed} gagal, ${movies.length} total.`);
}

async function readJsonArray(file) {
  try {
    const data = JSON.parse(await readFile(file, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function readJsonObject(file) {
  try {
    const data = JSON.parse(await readFile(file, "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  await mkdir(DATA_DIR, { recursive: true });

  if (opts.refreshDesc) {
    console.log(`Refresh deskripsi lengkap (delay ${opts.delay}ms)\n`);
    await refreshDescriptions(opts);
    return;
  }

  const years = opts.years;
  const existingMovies = opts.merge ? await readJsonArray(MOVIES_FILE) : [];
  const existingPlayers = opts.merge ? await readJsonObject(PLAYERS_FILE) : {};
  const have = new Set(existingMovies.map((m) => m.slug).filter(Boolean));

  const bySlug = new Map();
  if (years.length) {
    console.log(
      `Scrape LK21 arsip tahun ${years[years.length - 1]}–${years[0]} (${opts.pages} hlm/tahun, merge, delay ${opts.delay}ms)\n`
    );
    for (let i = 0; i < years.length; i++) {
      const year = years[i];
      const items = await scrapeListingPages({ ...opts, year });
      for (const item of items) {
        if (!bySlug.has(item.slug)) bySlug.set(item.slug, item);
      }
      if (i < years.length - 1 && opts.delay) await sleep(opts.delay);
    }
  } else {
    console.log(
      `Scrape LK21 latest: halaman ${opts.start}–${opts.start + opts.pages - 1}` +
        `${opts.merge ? " (merge)" : ""} (delay ${opts.delay}ms)\n`
    );
    for (const item of await scrapeListingPages(opts)) {
      bySlug.set(item.slug, item);
    }
  }

  let listings = [...bySlug.values()];
  if (opts.merge) {
    const skipped = listings.filter((l) => have.has(l.slug)).length;
    listings = listings.filter((l) => l.slug && !have.has(l.slug));
    console.log(
      `\nListing unik ${bySlug.size}. Skip ${skipped} yang sudah ada. Detail ${listings.length} film baru.\n`
    );
  } else {
    console.log(`\nAmbil detail ${listings.length} film...\n`);
  }

  if (!listings.length) {
    console.log("Tidak ada film baru.");
    return;
  }

  const { movies, playersMap, withPlayers } = await scrapeDetails(listings, opts);

  if (opts.merge) {
    const maxId = existingMovies.reduce((n, m) => Math.max(n, Number(m.id) || 0), 0);
    const added = movies.map((m, i) => ({ ...m, id: maxId + 1 + i }));
    const mergedMovies = [...existingMovies, ...added];
    const mergedPlayers = { ...existingPlayers, ...playersMap };
    await writeFile(MOVIES_FILE, JSON.stringify(mergedMovies, null, 2) + "\n", "utf8");
    await writeFile(PLAYERS_FILE, JSON.stringify(mergedPlayers, null, 2) + "\n", "utf8");
    console.log(
      `\nSelesai (merge).\n` +
        `  baru         : ${added.length} (player ${withPlayers})\n` +
        `  movies.json  : ${mergedMovies.length} film\n` +
        `  players.json : ${Object.keys(mergedPlayers).length} entri`
    );
    return;
  }

  await writeFile(MOVIES_FILE, JSON.stringify(movies, null, 2) + "\n", "utf8");
  await writeFile(PLAYERS_FILE, JSON.stringify(playersMap, null, 2) + "\n", "utf8");

  console.log(
    `\nSelesai.\n` +
      `  movies.json  : ${movies.length} film\n` +
      `  players.json : ${Object.keys(playersMap).length} entri\n` +
      `  punya player : ${withPlayers}/${movies.length}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
