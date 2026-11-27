/**
 * Oploverz → katalog WEBUNIME (TV + mobile).
 *
 * Oploverz adalah app SvelteKit: setiap halaman punya `<path>/__data.json`
 * (format devalue) berisi data lengkap, jadi tidak perlu browser:
 *   /series/__data.json          → allSeries (semua judul, ±1000)
 *   /series/<slug>/__data.json   → series + SEMUA episode + streamUrl
 *   /__data.json                 → latestEpisodes (beranda)
 *
 * Aturan merge (sama seperti Anoboy):
 * 1. Judul sudah ada di katalog → tambah server Oploverz ke episode yang cocok.
 * 2. Belum ada → tambah anime baru (source_site "oploverz").
 * Movie (releaseType "Movie") → anime-movies.json.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizeAnimeKey } from "./anoboy-sync.js";
import { pairMovies } from "./anoboy-movies.js";
import { isBrokenThumb } from "./samehadaku-sync.js";
import { oploverzDomain } from "./source-domains.js";

const CONCURRENCY = 4;
const TIMEOUT_MS = 60000;
const LABEL_PREFIX = "Oploverz";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const base = () => oploverzDomain.base();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- fetch + devalue ---------------- */

/** Bongkar format devalue (SvelteKit) menjadi objek biasa. */
export function unflatten(values) {
  const SPECIAL = { "-1": undefined, "-2": null, "-3": NaN, "-4": Infinity, "-5": -Infinity, "-6": -0 };
  const done = new Map();
  function h(i) {
    if (i < 0) return SPECIAL[i];
    if (done.has(i)) return done.get(i);
    const v = values[i];
    if (!v || typeof v !== "object") {
      done.set(i, v);
      return v;
    }
    if (Array.isArray(v)) {
      if (typeof v[0] === "string") {
        // Tipe khusus: ["Date", iso], ["Set", ...], ["Map", k, v, ...], dst.
        const out = v[0] === "Date" ? v[1] : v.slice(1).map(h);
        done.set(i, out);
        return out;
      }
      const arr = [];
      done.set(i, arr);
      for (const x of v) arr.push(h(x));
      return arr;
    }
    const obj = {};
    done.set(i, obj);
    for (const k of Object.keys(v)) obj[k] = h(v[k]);
    return obj;
  }
  return h(0);
}

/** Ambil data halaman (node terakhir = data milik halaman itu sendiri). */
export async function fetchPageData(path = "", tries = 3) {
  const url = `${base()}${path.replace(/\/$/, "")}/__data.json`;
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.type === "redirect") throw new Error(`redirect → ${json.location}`);
      const nodes = (json.nodes || []).filter((n) => n?.type === "data");
      if (!nodes.length) throw new Error("tidak ada node data");
      return unflatten(nodes.at(-1).data);
    } catch (err) {
      lastErr = err;
      if (/HTTP 404|redirect/.test(err.message)) break;
      await sleep(1500 * (i + 1));
    }
  }
  throw new Error(`${url}: ${lastErr?.message}`);
}

async function mapPool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

/* ---------------- parsing ---------------- */

const HOSTS = [
  // [regex host, nama server, prioritas (kecil = lebih dulu)]
  [/blogger\.com$/i, "Blogger", 0],
  [/abyssplayer\.com$|abyss\.to$/i, "Abyss", 1],
  [/yourupload\.com$/i, "YourUpload", 1],
  [/filedon\.co$/i, "Filedon", 2],
  [/4meplayer\./i, "4Me", 3],
  [/upbolt\./i, "Upbolt", 4],
  [/(^|\.)ok\.ru$/i, "OK.ru", 5],
];

/** Sebagian movie lama hanya menyimpan ID mentah + nama host di "source". */
const BARE_ID_EMBED = {
  yourupload: (id) => `https://www.yourupload.com/embed/${id}`,
  okru: (id) => `https://ok.ru/videoembed/${id}`,
};

function streamUrlOf(s) {
  const raw = String(s?.url || "").trim();
  if (/^https?:\/\//i.test(raw)) return raw;
  const make = BARE_ID_EMBED[String(s?.source || "").toLowerCase().replace(/[^a-z]/g, "")];
  return make && /^[\w-]{6,}$/.test(raw) ? make(raw) : "";
}
const QUALITY_ORDER = { "720p": 0, "1080p": 1, "480p": 2, "360p": 3, "": 4 };

function hostInfo(host) {
  for (const [re, name, prio] of HOSTS) if (re.test(host)) return { name, prio };
  return { name: host.replace(/^www\./, "").split(".")[0], prio: 9 };
}

function qualityOf(source) {
  const m = String(source || "").match(/(\d{3,4})\s*p/i);
  return m ? `${m[1]}p` : "";
}

/** streamUrl Oploverz → daftar player katalog (urut prioritas, tanpa duplikat). */
export function playersFromStreams(streams) {
  const seen = new Set();
  const items = [];
  for (const s of streams || []) {
    let u;
    try {
      u = new URL(streamUrlOf(s));
    } catch {
      continue;
    }
    if (!/^https?:$/.test(u.protocol)) continue;
    if (/(^|\.)blogger\.com$/i.test(u.hostname)) u.hostname = "www.blogger.com";
    const url = u.href;
    if (seen.has(url)) continue;
    seen.add(url);
    const { name, prio } = hostInfo(u.hostname);
    const quality = qualityOf(s.source);
    items.push({ name, prio, quality, url });
  }
  items.sort(
    (a, b) =>
      a.prio - b.prio || (QUALITY_ORDER[a.quality] ?? 5) - (QUALITY_ORDER[b.quality] ?? 5),
  );
  const labelCount = new Map();
  return items.map((it) => {
    let label = [LABEL_PREFIX, it.name, it.quality].filter(Boolean).join(" ");
    const n = (labelCount.get(label) || 0) + 1;
    labelCount.set(label, n);
    if (n > 1) label += ` ${n}`;
    return { server: "oploverz", label, url: it.url, default: false, source: "oploverz" };
  });
}

function episodeNumber(raw) {
  const n = Number.parseFloat(String(raw ?? "").replace(",", "."));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function yearOf(series) {
  const fromSeason = String(series?.season?.name || "").match(/\b(19|20)\d{2}\b/);
  if (fromSeason) return fromSeason[0];
  return "";
}

/** Metadata seri Oploverz → bentuk meta katalog. */
function metaFromSeries(s) {
  const poster = String(s.poster || "");
  return {
    title: String(s.title || "").trim(),
    japaneseTitle: String(s.japaneseTitle || "").trim(),
    slug: String(s.slug || "").trim(),
    sinopsis: String(s.description || "").replace(/\r/g, "").trim(),
    genre: (s.genres || []).map((g) => g?.name).filter(Boolean),
    rating: s.score ? String(s.score) : "",
    tahun: yearOf(s),
    studio: s.studio?.name || "",
    season_label: s.season?.name || "",
    durasi: s.duration || "",
    status: s.status || "",
    releaseType: s.releaseType || "",
    thumb: poster.startsWith("http") ? poster : poster ? `https://backapi.oploverz.ac/uploads/${poster}` : "",
    totalEpisodes: Number(s.totalEpisodes) || 0,
  };
}

/**
 * Satu seri lengkap: meta + Map<episode, {players, released_at}>.
 * Sejak Nov 2026 daftar episode di halaman seri tidak lagi membawa streamUrl; server diambil dari halaman
 * tiap episode. opts.recent: hanya N episode terbaru yang diambil begitu (sync rutin; episode lama sudah
 * punya server di katalog), tanpa opts.recent semua episode (sync penuh manual).
 */
export async function fetchSeries(slug, opts = {}) {
  const data = await fetchPageData(`/series/${slug}`);
  if (!data?.series) throw new Error(`series kosong: ${slug}`);
  const meta = metaFromSeries(data.series);
  const list = [...(data.episodes || [])];
  const byNewest = [...list].sort((a, b) => (episodeNumber(b.episodeNumber) ?? 0) - (episodeNumber(a.episodeNumber) ?? 0));
  const wanted = new Set(opts.recent ? byNewest.slice(0, opts.recent) : list);
  for (const e of list) {
    if (e.streamUrl || !wanted.has(e) || e.episodeNumber == null) continue;
    try {
      const page = await fetchPageData(`/series/${slug}/episode/${e.episodeNumber}`);
      e.streamUrl = page?.episode?.streamUrl;
    } catch (err) {
      console.warn(`[oploverz] gagal ${slug} episode ${e.episodeNumber}: ${err.message}`);
    }
  }
  const episodes = new Map();
  // Movie/OVA/special sering tanpa episodeNumber (null) → nomori urut dari 1.
  let unnumbered = 0;
  for (const e of [...list].reverse()) {
    const n = episodeNumber(e.episodeNumber) ?? ++unnumbered;
    const players = playersFromStreams(e.streamUrl);
    if (!players.length) continue;
    const prev = episodes.get(n);
    if (prev) {
      // Entri ganda untuk nomor yang sama → gabung server.
      const urls = new Set(prev.players.map((p) => p.url));
      for (const p of players) if (!urls.has(p.url)) prev.players.push(p);
    } else {
      episodes.set(n, { players, released_at: e.releasedAt || e.createdAt || "" });
    }
  }
  return { meta, episodes, href: `${base()}/series/${meta.slug || slug}` };
}

export async function listAllSeries() {
  const data = await fetchPageData("/series");
  const list = data?.allSeries?.data || [];
  if (!list.length) throw new Error("allSeries kosong");
  return list.map((s) => ({
    slug: s.slug,
    title: s.title,
    releaseType: s.releaseType || "",
    updatedAt: s.updatedAt || "",
    totalEpisodes: Number(s.totalEpisodes) || 0,
  }));
}

/** Slug seri dari episode terbaru di beranda (urut terbaru, unik). */
export async function listLatestSeriesSlugs(pages = 1) {
  const slugs = [];
  for (let p = 1; p <= pages; p++) {
    const data = await fetchPageData(p === 1 ? "" : `?page=${p}`).catch(() => null);
    for (const e of data?.latestEpisodes?.data || []) {
      const slug = e?.series?.slug;
      if (slug && !slugs.includes(slug)) slugs.push(slug);
    }
  }
  return slugs;
}

/* ---------------- merge katalog ---------------- */

const isOploverzPlayer = (p) => p?.source === "oploverz" || p?.server === "oploverz";

/**
 * Ganti server Oploverz lama dengan yang baru (link bisa berganti).
 * append=true: episode sudah diisi seri Oploverz lain di run ini (mis. TV + BD
 * cocok ke judul yang sama) → tambahkan saja, jangan timpa.
 */
function withOploverzPlayers(existing, fresh, append = false) {
  const kept = append ? [...(existing || [])] : (existing || []).filter((p) => !isOploverzPlayer(p));
  if (append) {
    const urls = new Set(kept.map((p) => p.url));
    fresh = fresh.filter((p) => !urls.has(p.url));
  }
  const hadDefault = kept.some((p) => p.default);
  return [...kept, ...fresh].map((p, i) => ({
    ...p,
    no: i + 1,
    default: hadDefault ? Boolean(p.default) && i < kept.length : i === 0,
  }));
}

function samePlayers(a, b) {
  const key = (list) => (list || []).map((p) => `${p.label}|${p.url}`).join("\n");
  return key(a) === key(b);
}

function epSlugNum(n) {
  return String(n).replace(".", "-");
}

function applyMeta(row, meta, href, isNew) {
  row.oploverz_source = href;
  // Satu judul bisa menerima beberapa seri Oploverz (mis. TV + BD) → catat semua slug.
  if (meta.slug) {
    const slugs = new Set(row.oploverz_slugs || []);
    slugs.add(meta.slug);
    row.oploverz_slugs = [...slugs];
  }
  if (isNew) return;
  // Judul lama: hanya isi field yang kosong / lemah.
  if (meta.sinopsis && (!row.sinopsis || row.sinopsis.length < 80)) row.sinopsis = meta.sinopsis;
  if (meta.genre.length && !row.genre?.length) row.genre = [...meta.genre];
  if (meta.rating && !row.rating) row.rating = meta.rating;
  if (meta.tahun && !row.tahun) row.tahun = meta.tahun;
  if (meta.studio && !row.studio) row.studio = meta.studio;
  // Poster kosong / banner iklan GIF dari sumber lain → pakai poster Oploverz.
  if (meta.thumb && isBrokenThumb(row.thumbnail)) row.thumbnail = meta.thumb;
}

function newSeriesRow(meta, href, markNew) {
  return {
    type: "anime",
    source_site: "oploverz",
    nama: meta.title,
    judul: meta.title,
    tahun: meta.tahun,
    thumbnail: meta.thumb,
    rating: meta.rating,
    votes: "",
    durasi: "",
    episodes_count: 0,
    genre: [...meta.genre],
    sinopsis: meta.sinopsis,
    studio: meta.studio,
    related: [],
    slug: meta.slug,
    source: href,
    oploverz_source: href,
    season_label: meta.season_label,
    episodes: [],
    players: [],
    ...(markNew ? { is_new: true } : {}),
  };
}

/** Terapkan satu seri ke satu katalog. row = baris tujuan (sudah ada / baru). */
function applySeries(row, series, isNew, touched) {
  const stats = { addedEps: 0, updatedEps: 0 };
  applyMeta(row, series.meta, series.href, isNew);
  if (!row.episodes) row.episodes = [];
  const byNum = new Map(row.episodes.map((e) => [Number(e.episode), e]));
  for (const [n, info] of series.episodes) {
    let ep = byNum.get(n);
    if (!ep) {
      ep = {
        episode: n,
        title: `${row.nama || row.judul} Episode ${n}`,
        slug: `${row.slug}-episode-${epSlugNum(n)}`,
        source: `${series.href}/episode/${n}`,
        date: "",
        released_at: info.released_at,
        players: [],
      };
      row.episodes.push(ep);
      byNum.set(n, ep);
      stats.addedEps += 1;
    }
    const merged = withOploverzPlayers(ep.players, info.players, touched.has(ep));
    touched.add(ep);
    if (!samePlayers(merged, ep.players)) {
      ep.players = merged;
      if (!isNew) stats.updatedEps += 1;
    }
  }
  if (stats.addedEps) {
    row.episodes.sort((a, b) => Number(a.episode) - Number(b.episode));
  }
  row.episodes_count = row.episodes.length;
  if (isNew || !row.durasi || /^\d+\s*eps$/i.test(String(row.durasi))) {
    row.durasi = `${row.episodes.length} eps`;
  }
  row.players = row.episodes.at(-1)?.players || row.players || [];
  return stats;
}

async function readArray(file) {
  try {
    const data = JSON.parse(await readFile(file, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writeCatalog(file, catalog) {
  const reindexed = catalog.map((row, idx) => ({ ...row, id: idx + 1 }));
  return writeFile(file, JSON.stringify(reindexed, null, 2) + "\n", "utf8");
}

/* ---- pencocokan judul (lebih ketat dari matchScore Anoboy) ----
 * Duplikat judul lebih ringan akibatnya daripada video salah di judul lain, jadi:
 * - season wajib sama (tanpa season = season 1; angka Romawi II–IX = season)
 * - nomor/tahun lain ("Movie 2", "(1999)", "Part 2") wajib sama
 * - season & nomor dihitung dari GABUNGAN slug + semua nama (tahun sering
 *   hanya ada di slug/judul, mis. captain-tsubasa-2018 = "Captain Tsubasa")
 * - token sama persis → cocok; subset → hanya bila judul KATALOG yang lebih
 *   pendek (slug Samehadaku sering terpotong) dan sisa token Oploverz bukan
 *   penanda spin-off (live action, OVA, dll.)
 */
const MATCH_STOP = new Set([
  "no", "wa", "ga", "wo", "ni", "to", "the", "of", "and", "an", "de", "e",
  "tv", "sub", "indo", "episode", "ep", "season", "part", "cour",
]);
const SPINOFF = new Set([
  "live", "action", "movie", "film", "gekijouban", "ova", "oad", "ona", "special",
  "specials", "sp", "recap", "picture", "drama", "darkness", "not", "plus", "first",
  "zero", "sns", "seifuku", "joshikou", "shorts", "mini", "chibi", "petit", "kanketsu",
  "bangai", "remake", "reboot", "re", "brotherhood", "smartphone", "go", "roku", "wan",
  "more", "ryusui", "beerus",
]);
const ROMAN = { ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9 };

function nameTokens(name) {
  return normalizeAnimeKey(
    String(name || "")
      .replace(/-/g, " ")
      .replace(/\b(\d+)(?:st|nd|rd|th)\s+season\b/gi, "season $1"),
  )
    .split(" ")
    .filter((t) => t && !MATCH_STOP.has(t));
}

/** Season + nomor untuk satu entitas (gabungan semua namanya). */
function entityNumbers(names) {
  let season = 0;
  let roman = 0;
  const nums = new Set();
  for (const name of names) {
    for (const t of nameTokens(name)) {
      const sm = t.match(/^s(\d+)$/);
      if (sm) season = Math.max(season, Number(sm[1]));
      else if (/^\d+$/.test(t)) nums.add(String(Number(t)));
      else if (ROMAN[t]) roman = Math.max(roman, ROMAN[t]);
    }
  }
  if (roman && !season) season = roman;
  else if (roman) nums.add(String(roman));
  return { season: season || 1, nums: [...nums].sort().join(",") };
}

function wordSet(name) {
  return new Set(
    nameTokens(name).filter((t) => !/^s\d+$/.test(t) && !/^\d+$/.test(t) && !ROMAN[t]),
  );
}

/** Skor satu nama katalog vs satu nama Oploverz (tanpa cek season/nomor). */
export function oploverzWordScore(rowName, candName) {
  const row = wordSet(rowName);
  const cand = wordSet(candName);
  if (row.size < 2 && cand.size < 2) {
    return row.size && [...row].join() === [...cand].join() ? 100 : 0;
  }
  for (const t of row) if (!cand.has(t)) return 0;
  if (row.size === cand.size) return 100;
  // Katalog ⊂ Oploverz: katalog harus cukup spesifik.
  if (row.size < 2 || [...row].some((t) => t.length < 3)) return 0;
  const extra = [...cand].filter((t) => !row.has(t));
  if (extra.some((t) => SPINOFF.has(t))) return 0;
  return Math.max(70, 90 - extra.length * 2);
}

function rowScore(row, series) {
  const m = series.meta;
  const rowNames = [row.slug, row.nama, row.judul].filter(Boolean);
  // Judul Jepang beraksara CJK kehilangan info saat dinormalisasi
  // ("Dr.STONE 龍水" → "dr stone") → hanya pakai yang beraksara Latin.
  const jp = /^[\u0000-\u024f\s]+$/.test(m.japaneseTitle) ? m.japaneseTitle : "";
  const candNames = [m.slug, m.title, jp].filter(Boolean);
  const rn = entityNumbers(rowNames);
  const cn = entityNumbers(candNames);
  if (rn.season !== cn.season || rn.nums !== cn.nums) return 0;
  let best = 0;
  for (const r of rowNames) {
    for (const c of candNames) best = Math.max(best, oploverzWordScore(r, c));
  }
  return best;
}

/** Cari baris tujuan: oploverz_source / slug sama dulu, lalu pencocokan judul. */
function findRow(items, series) {
  const slug = series.meta.slug;
  const direct =
    items.find((r) => r.oploverz_slugs?.includes(slug)) ||
    items.find((r) => r.oploverz_source === series.href || (r.slug && r.slug === slug));
  if (direct) return direct;
  let best = null;
  let bestScore = 0;
  for (const row of items) {
    if (!row?.slug) continue;
    const sc = rowScore(row, series);
    if (sc > bestScore) {
      bestScore = sc;
      best = row;
    }
  }
  return best;
}

/** bulk: impor massal → judul baru di akhir & tanpa is_new (jangan banjiri "terbaru"). */
function addRow(items, row, bulk) {
  if (bulk) items.push(row);
  else items.unshift(row);
}

function mergeSeriesIntoCatalogs(packs, series, touched, bulk) {
  const total = { matched: false, addedAnime: 0, addedEps: 0, updatedEps: 0, row: "" };
  // Template dari katalog mana pun (TV/mobile bisa beda isi) agar slug konsisten.
  let template = null;
  for (const pack of packs) {
    template = findRow(pack.items, series);
    if (template) break;
  }
  for (const [i, pack] of packs.entries()) {
    let row = template ? pack.items.find((r) => r.slug === template.slug) : null;
    let isNew = false;
    if (!row && template) {
      row = structuredClone(template);
      pack.items.unshift(row);
    } else if (!row) {
      row = newSeriesRow(series.meta, series.href, !bulk);
      addRow(pack.items, row, bulk);
      isNew = true;
    }
    const stats = applySeries(row, series, isNew, touched);
    if (i === 0) {
      total.matched = Boolean(template);
      total.addedAnime = isNew ? 1 : 0;
      total.addedEps = stats.addedEps;
      total.updatedEps = stats.updatedEps;
      total.row = row.slug;
    }
  }
  return total;
}

function movieRow(series, players, markNew) {
  const m = series.meta;
  return {
    type: "anime-movie",
    source_site: "oploverz",
    nama: m.title,
    judul: m.title,
    tahun: m.tahun,
    thumbnail: m.thumb,
    rating: m.rating,
    votes: null,
    durasi: "Movie",
    episodes_count: 0,
    genre: [...m.genre],
    sinopsis: m.sinopsis,
    studio: m.studio,
    sumber: "",
    related: [],
    slug: m.slug,
    source: series.href,
    oploverz_source: series.href,
    oploverz_slugs: [m.slug],
    season_label: "",
    episodes: [],
    players: withOploverzPlayers([], players),
    ...(markNew ? { is_new: true } : {}),
  };
}

function mergeMoviesIntoCatalogs(packs, movies, bulk) {
  const total = { matched: 0, added: 0, updated: 0 };
  const playable = movies
    .map((s) => {
      // Movie bisa terpecah beberapa "episode" → ambil episode pertama yang punya server.
      const first = [...s.episodes.values()][0];
      return first ? { series: s, players: first.players } : null;
    })
    .filter(Boolean);
  for (const [i, pack] of packs.entries()) {
    const keys = playable.map((p) => ({
      slug: p.series.meta.slug,
      title: p.series.meta.title,
      href: p.series.href,
      year: p.series.meta.tahun,
    }));
    // Baris yang sudah milik movie Oploverz lain tidak boleh dipasangkan ulang
    // (kalau tidak, server & slug-nya tertimpa movie yang mirip judulnya).
    const free = pack.items.filter((r) => !r.oploverz_slugs?.length);
    const open = keys.filter((k) => !pack.items.some((r) => r.oploverz_slugs?.includes(k.slug)));
    // Tahap 1: judul + tahun, hanya yang cocok persis ("Violet Evergarden Movie 2020"
    // → violet-evergarden-movie-2020, bukan Gaiden yang cocok sebagian).
    const pairs = new Map();
    const withYear = open
      .filter((k) => k.year)
      .map((k) => ({ ...k, title: `${k.title} ${k.year}` }));
    for (const [slug, hit] of pairMovies(free, withYear)) {
      if (hit && hit.score >= 100) pairs.set(slug, hit);
    }
    // Tahap 2: sisanya dengan pencocokan biasa (Anoboy).
    const taken = new Set([...pairs.values()].map((h) => h.row));
    const rest = pairMovies(
      free.filter((r) => !taken.has(r)),
      open.filter((k) => !pairs.has(k.slug)),
    );
    for (const [slug, hit] of rest) if (hit) pairs.set(slug, hit);
    for (const { series, players } of playable) {
      const slug = series.meta.slug;
      const pair =
        pack.items.find((r) => r.oploverz_slugs?.includes(slug)) ||
        free.find((r) => r.slug === slug) ||
        pairs.get(slug)?.row;
      if (pair) {
        const merged = withOploverzPlayers(pair.players, players);
        const changed = !samePlayers(merged, pair.players);
        pair.players = merged;
        pair.oploverz_source = series.href;
        pair.oploverz_slugs = [series.meta.slug];
        if (i === 0) {
          total.matched += 1;
          if (changed) total.updated += 1;
        }
      } else {
        addRow(pack.items, movieRow(series, players, !bulk), bulk);
        if (i === 0) total.added += 1;
      }
    }
  }
  return total;
}

/* ---------------- entry points ---------------- */

/**
 * Scrape seri Oploverz dan gabungkan ke anime.json + anime-movies.json
 * di semua dirs (TV + mobile).
 * opts.slugs: daftar slug (default: semua di /series)
 * opts.limit, opts.dryRun, opts.movies (default true)
 */
export async function syncOploverz(dirs, opts = {}) {
  await oploverzDomain.resolve();
  console.log(`[oploverz] domain: ${base()}`);

  const bulk = opts.bulk ?? !opts.slugs?.length;
  let targets;
  if (opts.slugs?.length) {
    targets = opts.slugs.map((slug) => ({ slug, releaseType: "" }));
  } else {
    targets = await listAllSeries();
  }
  if (opts.limit) targets = targets.slice(0, opts.limit);
  console.log(`[oploverz] ${targets.length} seri akan diambil`);

  const failed = [];
  let done = 0;
  const fetched = await mapPool(targets, CONCURRENCY, async (t) => {
    try {
      const s = await fetchSeries(t.slug, { recent: opts.recentEpisodes });
      done += 1;
      if (done % 25 === 0 || done === targets.length) {
        console.log(`[oploverz] ${done}/${targets.length} seri terambil`);
      }
      return s;
    } catch (err) {
      failed.push({ slug: t.slug, error: err.message });
      console.warn(`[oploverz] gagal ${t.slug}: ${err.message}`);
      return null;
    }
  });

  const ok = fetched.filter((s) => s && s.episodes.size);
  // "Movie" berisi banyak episode (mis. one-piece-movie = kumpulan 15 movie) → seri.
  const isMovie = (s) => /^movie$/i.test(s.meta.releaseType) && s.episodes.size <= 1;
  const series = ok.filter((s) => !isMovie(s));
  const movies = opts.movies === false ? [] : ok.filter(isMovie);

  const animePacks = await Promise.all(
    dirs.map(async (dir) => {
      const file = join(dir, "anime.json");
      return { file, items: await readArray(file) };
    }),
  );
  const result = {
    domain: base(),
    fetched: ok.length,
    empty: fetched.filter((s) => s && !s.episodes.size).length,
    failed,
    series: { matched: 0, added: 0, addedEps: 0, updatedEps: 0, addedSlugs: [], matches: [] },
    movies: null,
  };
  const touched = new WeakSet();
  for (const s of series) {
    const r = mergeSeriesIntoCatalogs(animePacks, s, touched, bulk);
    if (r.matched) {
      result.series.matched += 1;
      if (r.row !== s.meta.slug) result.series.matches.push(`${s.meta.slug} → ${r.row}`);
    }
    result.series.added += r.addedAnime;
    if (r.addedAnime) result.series.addedSlugs.push(s.meta.slug);
    result.series.addedEps += r.addedEps;
    result.series.updatedEps += r.updatedEps;
  }

  let moviePacks = [];
  if (movies.length) {
    moviePacks = await Promise.all(
      dirs.map(async (dir) => {
        const file = join(dir, "anime-movies.json");
        return { file, items: await readArray(file) };
      }),
    );
    result.movies = mergeMoviesIntoCatalogs(moviePacks, movies, bulk);
  }

  if (!opts.dryRun) {
    for (const pack of [...animePacks, ...moviePacks]) await writeCatalog(pack.file, pack.items);
  }
  // Ringkas log: tidak perlu daftar panjang di output sync.
  result.added = result.series.added + (result.movies?.added || 0);
  result.matched = result.series.matched + (result.movies?.matched || 0);
  return result;
}

/** Sinkron cepat: hanya seri yang muncul di episode terbaru beranda. */
export async function syncOploverzLatest(dirs, opts = {}) {
  await oploverzDomain.resolve();
  const slugs = await listLatestSeriesSlugs(Number(opts.pages) || 2);
  if (!slugs.length) throw new Error("episode terbaru kosong");
  return syncOploverz(dirs, { recentEpisodes: 3, ...opts, slugs });
}

/**
 * Cek beranda: episode terbaru yang belum punya server Oploverz di katalog.
 * Dipakai check-new-content (cron) untuk memutuskan perlu sync atau tidak.
 */
export async function checkOploverzFirstPage(dataDir) {
  await oploverzDomain.resolve();
  const data = await fetchPageData("");
  const have = new Set();
  for (const row of await readArray(join(dataDir, "anime.json"))) {
    if (!row?.oploverz_slugs?.length) continue;
    for (const ep of row.episodes || []) {
      if (!(ep.players || []).some(isOploverzPlayer)) continue;
      for (const slug of row.oploverz_slugs) have.add(`${slug}#${Number(ep.episode)}`);
    }
  }
  const fresh = [];
  for (const e of data?.latestEpisodes?.data || []) {
    const slug = e?.series?.slug;
    const n = episodeNumber(e?.episodeNumber);
    if (!slug || n == null || /^movie$/i.test(e?.series?.releaseType || "")) continue;
    if (!playersFromStreams(e.streamUrl).length) continue;
    const key = `${slug}#${n}`;
    if (!have.has(key) && !fresh.includes(key)) fresh.push(key);
  }
  return { fresh };
}
