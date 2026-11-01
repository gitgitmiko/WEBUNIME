/**
 * Anoboy /anime-movie/ → anime-movies.json (TV + mobile).
 *
 * Aturan merge:
 * 1. Judul sudah ada di anime-movies.json → tambah server Anoboy ke row tersebut.
 * 2. Hanya ada di anime.json (Samehadaku) → row movie baru + server Samehadaku + Anoboy.
 * 3. Belum ada → row movie baru dengan server Anoboy saja.
 *
 * Hanya server yang masih hidup yang disimpan (cek per link). Judul tanpa server hidup
 * dicatat di anoboy-movies-skipped.json supaya tidak memicu sync berulang.
 *
 * Full:   syncAnoboyMovies(dirs, { all: true })   ← semua halaman, manual
 * Latest: syncAnoboyMovies(dirs, { pages: 2 })    ← cron sync catalog
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isYupLive, normalizeAnimeKey, yupEmbedsFromPath } from "./anoboy-sync.js";

const BASE = "https://anoboy.quest";
const LIST_URL = `${BASE}/anime-movie/`;
const SKIP_FILE = "anoboy-movies-skipped.json";
const CONCURRENCY = 6;
const TIMEOUT_MS = 25000;
const HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  referer: `${BASE}/`,
};

/**
 * Judul yang tidak bisa dicocokkan otomatis (romaji vs Inggris).
 * Slug Anoboy → slug Samehadaku; null = jangan pernah di-merge.
 */
const ALIASES = {
  "ansatsu-kyoushitsu-movie-minna-no-jikan": "assassination-classroom-the-movie-our-time",
  "kimetsu-no-yaiba-movie-1-mugenjou-hen-akaza-sairai":
    "kimetsu-no-yaiba-the-movie-infinity-castle-part-1-akaza-returns",
};

const TITLE_STOP = new Set([
  "the", "no", "wa", "ga", "wo", "ni", "to", "of", "and", "a", "an",
  "movie", "film", "gekijouban", "index", "episode", "ep",
]);

function decodeEntities(text) {
  return String(text || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, " ")
    .trim();
}

function cleanTitle(text) {
  return decodeEntities(text).replace(/\s*Subtitle Indonesia.*$/i, "").trim();
}

function slugFromUrl(url) {
  const raw = new URL(url, BASE).pathname.split("/").filter(Boolean).pop() || "";
  return decodeURIComponent(raw).toLowerCase();
}

/** fetch teks; status 0 = gagal jaringan/timeout. */
async function fetchText(url, init = {}) {
  try {
    const res = await fetch(url, {
      headers: HEADERS,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      ...init,
    });
    return { status: res.status, text: await res.text() };
  } catch {
    return { status: 0, text: "" };
  }
}

async function fetchPage(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { status, text } = await fetchText(url);
    if (status === 200) return text;
    await new Promise((r) => setTimeout(r, attempt * 2000));
  }
  throw new Error(`gagal mengambil ${url}`);
}

async function mapPool(items, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return out;
}

export function parseListing(html) {
  const body = html.split("class='wp-pagenavi'")[0];
  const items = [];
  const seen = new Set();
  const re =
    /<a href="(https:\/\/anoboy\.(?:quest|xyz)\/\d{4}\/\d{2}\/[^"]+)" rel="bookmark" title="([^"]*)">[\s\S]*?<img[^>]+src="([^"]*)"/g;
  for (const m of body.matchAll(re)) {
    const href = m[1].replace(/anoboy\.xyz/i, "anoboy.quest");
    if (seen.has(href)) continue;
    seen.add(href);
    items.push({
      href,
      title: cleanTitle(m[2]),
      thumbnail: m[3] ? encodeURI(decodeURI(new URL(m[3], BASE).href)) : "",
    });
  }
  const max = html.match(/Page \d+ of (\d+)/i);
  return { items, maxPages: max ? Number(max[1]) : 1 };
}

export function parseDetail(html) {
  const main = html.split('id="footer"')[0];
  const table = {};
  for (const m of main.matchAll(/<th[^>]*>([\s\S]*?)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/g)) {
    table[decodeEntities(m[1]).toLowerCase()] = decodeEntities(m[2]);
  }
  let sinopsis = "";
  for (const m of main.matchAll(/<div class="unduhan">([\s\S]*?)<\/div>/g)) {
    const t = decodeEntities(m[1]);
    if (t.length > sinopsis.length && !/^judul\b/i.test(t) && !/judi|slot|bandar/i.test(t)) {
      sinopsis = t;
    }
  }
  const sources = [];
  for (const m of main.matchAll(/data-video="([^"]*)"[^>]*>([^<]*)</g)) {
    sources.push({ label: decodeEntities(m[2]), url: m[1].replace(/&amp;/g, "&") });
  }
  // Iframe terakhir: link yang sama dari mirror lebih dulu supaya label kualitasnya terbawa.
  const iframe = main.match(/id="mediaplayer"[^>]*\ssrc="([^"]*)"/);
  if (iframe) sources.push({ label: "", url: iframe[1].replace(/&amp;/g, "&") });
  return {
    title: cleanTitle(main.match(/<h1>([\s\S]*?)<\/h1>/)?.[1] || ""),
    sinopsis: sinopsis.slice(0, 4000),
    genre: String(table.genre || "")
      .split(/[,/|]/)
      .map((s) => s.trim())
      .filter((s) => s && !/^(anime|ongoing)$/i.test(s)),
    rating: String(table.score || table.skor || "").replace(/[^\d.]/g, ""),
    studio: table.studio || "",
    sumber: table.source || table.sumber || "",
    sources,
  };
}

function qualityLabel(text) {
  const m = String(text).match(/(\d{3,4})\s*p?\s*$/i);
  return m ? `${m[1]}p` : "";
}

/** Link mentah halaman Anoboy → kandidat server. embed.php/filesim/zipy/play sudah mati. */
export function expandSources(sources) {
  const out = [];
  const add = (kind, name, url, quality) => out.push({ kind, name, url, quality });
  for (const { label, url } of sources) {
    if (/^\/uploads\/yup\/data\.php/i.test(url)) {
      for (const e of yupEmbedsFromPath(url)) add("yourupload", "YUP", e.url, e.quality);
    } else if (/yourupload\.com\/embed\//i.test(url)) {
      add("yourupload", "YUP", url, qualityLabel(label));
    } else if (/mega\.nz\/embed\//i.test(url)) {
      add("mega", "Mega", url, qualityLabel(label));
    } else if (/krakenfiles\.com\/embed-video\//i.test(url)) {
      add("kraken", "Kraken", url, qualityLabel(label));
    } else {
      const token = url.match(/[?&]url=(AD6v5[^&]+)/i)?.[1];
      if (token) {
        add(
          "blogger",
          "Blogspot",
          `https://www.blogger.com/video.g?token=${decodeURIComponent(token)}`,
          qualityLabel(label) || (/720/.test(label) ? "720p" : ""),
        );
      }
    }
  }
  const seen = new Set();
  return out.filter((c) => !seen.has(c.url) && seen.add(c.url));
}

async function isLive(candidate) {
  if (candidate.kind === "mega") {
    const id = candidate.url.match(/embed\/([^#?]+)/)?.[1];
    const { status, text } = await fetchText("https://g.api.mega.co.nz/cs", {
      method: "POST",
      body: JSON.stringify([{ a: "g", p: id }]),
    });
    return status === 200 && /"s":\d+/.test(text);
  }
  if (candidate.kind === "yourupload") return isYupLive(candidate.url);
  const { status, text } = await fetchText(candidate.url);
  if (status !== 200) return false;
  if (candidate.kind === "blogger") return /googlevideo/.test(text) && !/Video is unavailable/.test(text);
  return true;
}

function toPlayers(candidates) {
  const rank = (c) => -(parseInt(c.quality, 10) || 0);
  const order = { blogger: 0, mega: 1, kraken: 2, yourupload: 3 };
  return [...candidates]
    .sort((a, b) => order[a.kind] - order[b.kind] || rank(a) - rank(b))
    .map((c) => ({
      server: "anoboy",
      label: `Anoboy ${c.name}${c.quality ? ` ${c.quality}` : ""}`,
      url: c.url,
      default: false,
      source: "anoboy",
    }));
}

function titleTokens(s) {
  return [
    ...new Set(
      normalizeAnimeKey(s)
        .split(" ")
        .filter((t) => t && !TITLE_STOP.has(t)),
    ),
  ];
}

const numbersOf = (tokens) => tokens.filter((t) => /^\d+$/.test(t)).sort().join(",");

/** Lebih ketat dari matchScore: nomor movie wajib sama (Movie 2 ≠ Movie 3). */
export function movieMatchScore(a, b) {
  const ta = titleTokens(a);
  const tb = titleTokens(b);
  if (!ta.length || !tb.length || numbersOf(ta) !== numbersOf(tb)) return 0;
  const [small, big] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const bigSet = new Set(big);
  if (!small.every((t) => bigSet.has(t))) return 0;
  if (small.length === big.length) return 100;
  if (small.filter((t) => !/^\d+$/.test(t)).length < 2) return 0;
  return 60 + Math.round((small.length / big.length) * 30);
}

function rowNames(row) {
  return [row.slug, row.nama, row.judul].filter(Boolean);
}

function bestScore(row, movie) {
  let best = 0;
  for (const name of rowNames(row)) {
    for (const cand of [movie.slug, movie.title]) {
      best = Math.max(best, movieMatchScore(name, cand));
    }
  }
  return best;
}

/** Pasangkan movie Anoboy ↔ row satu lawan satu (skor tertinggi dulu). */
export function pairMovies(rows, movies) {
  const bySlug = new Map(rows.map((r) => [r.slug, r]));
  const pairs = new Map();
  const taken = new Set();
  const scored = [];
  for (const movie of movies) {
    if (Object.prototype.hasOwnProperty.call(ALIASES, movie.slug)) {
      const row = bySlug.get(ALIASES[movie.slug]);
      if (row) {
        pairs.set(movie.slug, { row, score: 999 });
        taken.add(row.slug);
      } else {
        pairs.set(movie.slug, null);
      }
      continue;
    }
    for (const row of rows) {
      const fixed = row.anoboy_source && row.anoboy_source === movie.href;
      const score = fixed ? 500 : bestScore(row, movie);
      if (score) scored.push({ movie, row, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  for (const { movie, row, score } of scored) {
    if (pairs.has(movie.slug) || taken.has(row.slug)) continue;
    pairs.set(movie.slug, { row, score });
    taken.add(row.slug);
  }
  return pairs;
}

function latestEpisodePlayers(row) {
  const eps = [...(row?.episodes || [])].reverse();
  return eps.find((e) => e.players?.length)?.players || row?.players || [];
}

function withAnoboyPlayers(existing, fresh) {
  const kept = (existing || []).filter((p) => p.source !== "anoboy" && p.server !== "anoboy");
  const all = [...kept, ...fresh];
  return all.map((p, i) => ({ ...p, no: i + 1, default: i === 0 }));
}

function newRow(movie, players, base) {
  return {
    type: "anime-movie",
    source_site: base ? base.source_site || "samehadaku" : "anoboy",
    nama: base?.nama || movie.title,
    judul: base?.judul || movie.title,
    tahun: base?.tahun || movie.title.match(/\((\d{4})\)/)?.[1] || "",
    thumbnail: base?.thumbnail || movie.thumbnail,
    rating: base?.rating || movie.rating,
    votes: base?.votes ?? null,
    durasi: "Movie",
    episodes_count: 0,
    genre: base?.genre?.length ? base.genre : movie.genre,
    sinopsis: base?.sinopsis || movie.sinopsis,
    studio: base?.studio || movie.studio,
    sumber: base?.sumber || movie.sumber,
    related: [],
    slug: base?.slug || movie.slug,
    source: base?.source || movie.href,
    anoboy_source: movie.href,
    season_label: "",
    episodes: [],
    players: withAnoboyPlayers(latestEpisodePlayers(base), players),
  };
}

function mergeRow(row, movie, players) {
  row.players = withAnoboyPlayers(row.players, players);
  row.anoboy_source = movie.href;
  if (!row.sinopsis || row.sinopsis.length < 80) row.sinopsis = movie.sinopsis || row.sinopsis;
  if (!row.genre?.length) row.genre = movie.genre;
  if (!row.rating) row.rating = movie.rating;
  if (!row.thumbnail) row.thumbnail = movie.thumbnail;
  if (!row.studio) row.studio = movie.studio;
  if (!row.sumber) row.sumber = movie.sumber;
}

async function readArray(file) {
  try {
    const data = JSON.parse(await readFile(file, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

async function scrapeMovie(item) {
  const detail = parseDetail(await fetchPage(item.href));
  const candidates = expandSources(detail.sources);
  const live = (
    await mapPool(candidates, async (c) => ((await isLive(c)) ? c : null))
  ).filter(Boolean);
  const { sources, ...meta } = detail;
  return {
    ...item,
    ...meta,
    title: detail.title || item.title,
    slug: slugFromUrl(item.href),
    candidates: candidates.length,
    players: toPlayers(live),
  };
}

/** Halaman pertama: ada post yang belum tercatat di katalog / daftar skip? */
export async function checkAnoboyMoviesFirstPage(dataDir) {
  const { items } = parseListing(await fetchPage(LIST_URL));
  const rows = await readArray(join(dataDir, "anime-movies.json"));
  const known = new Set([
    ...rows.map((r) => r.anoboy_source).filter(Boolean),
    ...(await readArray(join(dataDir, SKIP_FILE))).map((s) => s.href),
  ]);
  return { fresh: items.map((i) => i.href).filter((href) => !known.has(href)) };
}

export async function syncAnoboyMovies(dirs, opts = {}) {
  const first = parseListing(await fetchPage(LIST_URL));
  const maxPages = opts.all
    ? first.maxPages
    : Math.min(first.maxPages, Math.max(1, Number(opts.pages) || 2));
  const listed = [...first.items];
  for (let n = 2; n <= maxPages; n++) {
    listed.push(...parseListing(await fetchPage(`${LIST_URL}page/${n}/`)).items);
  }
  const seen = new Set();
  let items = listed.filter((i) => !seen.has(i.href) && seen.add(i.href));
  if (opts.limit) items = items.slice(0, opts.limit);
  console.log(`[anoboy-movie] ${maxPages} halaman, ${items.length} judul`);

  const movies = [];
  const failed = [];
  for (let i = 0; i < items.length; i++) {
    try {
      const movie = await scrapeMovie(items[i]);
      movies.push(movie);
      console.log(
        `[anoboy-movie] ${i + 1}/${items.length} ${movie.slug}: ${movie.players.length}/${movie.candidates} server hidup`,
      );
    } catch (err) {
      failed.push(items[i].href);
      console.warn(`[anoboy-movie] ${items[i].href}: ${err.message}`);
    }
  }

  const playable = movies.filter((m) => m.players.length);
  // Movie Samehadaku yang tercatat di anime.json: maksimal 2 episode, selain itu seri TV.
  const animeRows = (await readArray(join(dirs[0], "anime.json"))).filter((r) => {
    const eps = r.episodes || [];
    return eps.length <= 2 && eps.some((e) => e.players?.some((p) => p.source !== "anoboy"));
  });
  const totals = {
    checked: movies.length,
    failed: failed.length,
    matched: 0,
    fromAnime: 0,
    added: 0,
    updated: 0,
    skipped: movies.length - playable.length,
    addedSlugs: [],
    pairs: [],
  };

  for (const [dirIdx, dir] of dirs.entries()) {
    const file = join(dir, "anime-movies.json");
    const rows = await readArray(file);
    const pairs = pairMovies(rows, playable);
    const left = playable.filter((m) => !pairs.get(m.slug));
    // anime.json: hanya kecocokan persis, banyak judul seri yang mirip judul movie.
    const fromAnime = new Map();
    for (const [movieSlug, hit] of pairMovies(animeRows, left)) {
      if (hit && hit.score >= 100 && hit.score < 500) fromAnime.set(movieSlug, hit);
    }
    const created = [];
    for (const movie of playable) {
      const pair = pairs.get(movie.slug);
      const log = dirIdx === 0;
      if (pair) {
        const before = JSON.stringify(pair.row);
        mergeRow(pair.row, movie, movie.players);
        if (log) {
          totals.matched += 1;
          if (before !== JSON.stringify(pair.row)) totals.updated += 1;
          totals.pairs.push({ anoboy: movie.slug, row: pair.row.slug, score: pair.score });
        }
        continue;
      }
      const base = fromAnime.get(movie.slug);
      const row = newRow(movie, movie.players, base?.row);
      if (opts.markNew) row.is_new = true;
      created.push(row);
      if (log) {
        totals.added += 1;
        totals.addedSlugs.push(row.slug);
        if (base) {
          totals.fromAnime += 1;
          totals.pairs.push({ anoboy: movie.slug, row: base.row.slug, score: base.score, anime: true });
        }
      }
    }
    if (!opts.dryRun) {
      const merged = (opts.markNew ? [...created, ...rows] : [...rows, ...created]).map(
        (row, idx) => ({ ...row, id: idx + 1 }),
      );
      await writeFile(file, JSON.stringify(merged, null, 2) + "\n", "utf8");
    }
  }

  if (!opts.dryRun && !opts.limit) {
    const skipFile = join(dirs[0], SKIP_FILE);
    const skipped = new Map((await readArray(skipFile)).map((s) => [s.href, s]));
    for (const m of movies) {
      if (m.players.length) skipped.delete(m.href);
      else skipped.set(m.href, { href: m.href, title: m.title });
    }
    await writeFile(skipFile, JSON.stringify([...skipped.values()], null, 2) + "\n", "utf8");
  }
  totals.skippedTitles = movies.filter((m) => !m.players.length).map((m) => m.href);
  console.log(
    `[anoboy-movie] selesai: cek ${totals.checked}, merge ${totals.matched}, baru ${totals.added}, tanpa server ${totals.skipped}, gagal ${totals.failed}`,
  );
  return totals;
}
