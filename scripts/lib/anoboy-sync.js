/**
 * Anoboy → katalog WEBUNIME (TV + mobile).
 *
 * Aturan merge (seperti Naruto):
 * 1. Cek apakah judul sudah ada di katalog Samehadaku.
 * 2. Kalau ada  → hanya tambah server Anoboy ke episode yang cocok.
 * 3. Kalau belum → tambah anime baru + episode + server Anoboy.
 *
 * Full:   scrapeAnoboyFull()      ← semua halaman /anime/
 * Latest: syncAnoboyLatest()      ← homepage, untuk GitHub Actions
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";

const BASE = "https://anoboy.xyz";
const LIST_URL = `${BASE}/anime/`;
const HOME_URL = `${BASE}/`;
const DETAIL_DELAY_MS = 400;
const ANOBOY_LABEL = "Anoboy B-Tube";
const STATE_DIR = "scripts/_anoboy-scrape";

const STOP = new Set([
  "no",
  "wa",
  "ga",
  "wo",
  "ni",
  "to",
  "the",
  "of",
  "and",
  "a",
  "an",
  "season",
  "episode",
  "ep",
  "streaming",
  "tamat",
  "sub",
  "indo",
  "subtitle",
  "indonesia",
  "movie",
  "ova",
  "bd",
  "batch",
]);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function slugFromUrl(url) {
  try {
    const path = new URL(url, BASE).pathname.replace(/\/+$/, "");
    return path.split("/").filter(Boolean).pop() || "";
  } catch {
    return "";
  }
}

function yearFromUrl(url) {
  const m = String(url || "").match(/anoboy\.xyz\/(20\d{2})\//i);
  return m ? m[1] : "";
}

/** Episode URL → halaman hub seri (tanpa -episode-N). */
function resolveHubUrl(url) {
  try {
    const u = new URL(url, BASE);
    u.hash = "";
    u.search = "";
    let path = u.pathname.replace(/\/+$/, "");
    path = path.replace(/-episode-\d+(?:-.*)?$/i, "");
    u.pathname = `${path}/`;
    return u.href;
  } catch {
    return url;
  }
}

function isAnoboyOnly(row) {
  return String(row?.source_site || "").toLowerCase() === "anoboy";
}

function absUrl(href, base = BASE) {
  try {
    return new URL(href, base).href;
  } catch {
    return href;
  }
}

function bloggerFromAnoboyPath(videoPath) {
  if (!videoPath) return null;
  const m = String(videoPath).match(/[?&]url=([^&]+)/i);
  if (!m) return null;
  const token = decodeURIComponent(m[1]);
  if (!/^AD6v5/i.test(token)) return null;
  return `https://www.blogger.com/video.g?token=${token}`;
}

function isAnoboyPlayer(p) {
  const t = `${p?.server || ""} ${p?.label || ""} ${p?.source || ""}`.toLowerCase();
  return t.includes("anoboy");
}

function parseEpisodeNumbers(text) {
  const raw = String(text || "")
    .replace(/^(EP|Yup)\s*/i, "")
    .replace(/episode\s*/i, "")
    .trim();
  if (!raw) return [];
  if (/&/.test(raw)) {
    return [
      ...new Set(
        [...raw.matchAll(/(\d+)/g)].map((m) => Number(m[1])).filter((n) => n > 0),
      ),
    ];
  }
  const range = raw.match(/^(\d+)\s*[-–]\s*(\d+)$/);
  if (range) {
    const a = Number(range[1]);
    const b = Number(range[2]);
    if (b >= a && b - a < 20) {
      return Array.from({ length: b - a + 1 }, (_, i) => a + i);
    }
    if (b < 10) {
      const end = Math.floor(a / 10) * 10 + b;
      if (end >= a) return end === a ? [a] : [a, end];
    }
    return [a];
  }
  const n = Number((raw.match(/(\d+)/) || [])[1]);
  return n > 0 ? [n] : [];
}

function parseEpisodeFromUrl(url, title = "") {
  const slug = slugFromUrl(url);
  const m =
    slug.match(/^(.*?)-episode-(\d+)(?:-.*)?$/i) ||
    slug.match(/^(.*?)-ep-(\d+)$/i);
  if (m) {
    return { seriesSlug: m[1], episode: Number(m[2]), batch: false };
  }
  const batch = slug.match(/^(.*?)-episode-(\d+)-(\d+)/i);
  if (batch) {
    return {
      seriesSlug: batch[1],
      episode: null,
      batch: true,
      from: Number(batch[2]),
      to: Number(batch[3]),
    };
  }
  const fromTitle = String(title).match(/episode\s+(\d+)/i);
  return {
    seriesSlug: slug,
    episode: fromTitle ? Number(fromTitle[1]) : null,
    batch: false,
  };
}

export function normalizeAnimeKey(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[’']/g, "")
    .replace(/&/g, " and ")
    .replace(/season\s*(\d+)/g, "s$1")
    .replace(/\bs(\d+)\b/g, "s$1")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(
      /\b(subtitle|indonesia|sub|indo|streaming|tamat|bd|batch|nonton)\b/g,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(s) {
  return [
    ...new Set(
      normalizeAnimeKey(s)
        .split(" ")
        .filter((t) => t && !STOP.has(t) && t.length > 1),
    ),
  ];
}

function seasonOf(s) {
  const n = String(s || "");
  const m = n.match(/\b(?:season|s)\s*(\d+)\b/i) || n.match(/-s(\d+)(?:-|$)/i);
  return m ? Number(m[1]) : 0;
}

/**
 * Cari judul Samehadaku yang sudah ada. null = belum ada.
 */
export function findExistingAnime(catalog, candidate) {
  const candSlug = String(candidate.slug || "").toLowerCase();
  const candTitle = candidate.title || candidate.nama || "";
  if (!candSlug && !candTitle) return null;

  let best = null;
  let bestScore = 0;
  for (const row of catalog) {
    if (!row?.slug) continue;
    const score = matchScore(row, { slug: candSlug, title: candTitle });
    if (score > bestScore) {
      bestScore = score;
      best = row;
    }
  }
  return bestScore >= 72 ? best : null;
}

export function matchScore(catalog, cand) {
  const cSlug = String(catalog.slug || "").toLowerCase();
  const aSlug = String(cand.slug || "").toLowerCase();
  if (cSlug && aSlug && cSlug === aSlug) return 100;

  const cSeason = seasonOf(`${cSlug} ${catalog.nama || ""} ${catalog.judul || ""}`);
  const aSeason = seasonOf(`${aSlug} ${cand.title || ""}`);
  if (cSeason && aSeason && cSeason !== aSeason) return 0;

  const cTok = tokens(`${cSlug} ${catalog.nama || ""} ${catalog.judul || ""}`);
  const aTok = tokens(`${aSlug} ${cand.title || ""}`);
  if (!cTok.length || !aTok.length) return 0;

  const cSet = new Set(cTok);
  const aSet = new Set(aTok);

  // Katalog lebih pendek (singkatan Samehadaku) ⊂ judul Anoboy yang lebih panjang.
  if (cTok.length >= 2 && cTok.every((t) => aSet.has(t))) return 88;
  // Semua token Anoboy ada di katalog (judul Anoboy lebih pendek / sama).
  if (aTok.length >= 2 && aTok.every((t) => cSet.has(t))) return 86;

  // Satu token: hanya jika katalog juga satu token yang sama (hindari naruto→shippuden).
  if (aTok.length === 1 && cTok.length === 1 && aTok[0] === cTok[0]) return 80;

  const hit = aTok.filter((t) => cSet.has(t)).length;
  const recall = hit / aTok.length;
  if (recall >= 0.85 && hit >= 3) return 74;
  return 0;
}

function nextId(list) {
  let max = 0;
  for (const row of list) {
    const n = Number(row?.id) || 0;
    if (n > max) max = n;
  }
  return max + 1;
}

async function readJsonArray(filePath) {
  try {
    const data = JSON.parse(await readFile(filePath, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function launchBrowser() {
  const opts = {
    headless: true,
    args: ["--disable-blink-features=AutomationControlled"],
  };
  try {
    return await chromium.launch({ ...opts, channel: "chrome" });
  } catch {
    return await chromium.launch(opts);
  }
}

async function makePage(browser) {
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1365, height: 900 },
    locale: "id-ID",
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  return context.newPage();
}

function makeAnoboyPlayer(url, label = ANOBOY_LABEL) {
  return {
    server: "anoboy",
    label,
    url,
    default: false,
    source: "anoboy",
  };
}

function mergePlayerIntoEpisode(ep, player) {
  if (!ep.players) ep.players = [];
  const exists = ep.players.some(
    (x) => isAnoboyPlayer(x) && (x.url === player.url || x.label === player.label),
  );
  if (exists) return false;
  ep.players = ep.players.filter(
    (x) => !(isAnoboyPlayer(x) && x.label === player.label),
  );
  ep.players.push({
    no: ep.players.length + 1,
    ...player,
    default: ep.players.length === 0 ? true : false,
  });
  ep.players.forEach((x, i) => {
    x.no = i + 1;
  });
  return true;
}

function ensureEpisode(anime, episode, meta = {}) {
  if (!anime.episodes) anime.episodes = [];
  let ep = anime.episodes.find((e) => Number(e.episode) === Number(episode));
  if (ep) return { ep, created: false };
  ep = {
    episode: Number(episode),
    title: `${anime.nama || anime.judul || "Episode"} Episode ${episode}`,
    slug: `${anime.slug}-episode-${episode}`,
    source: meta.source || "",
    date: "",
    players: [],
  };
  anime.episodes.push(ep);
  anime.episodes.sort((a, b) => Number(a.episode) - Number(b.episode));
  anime.episodes_count = anime.episodes.length;
  anime.durasi = `${anime.episodes.length} eps`;
  return { ep, created: true };
}

/**
 * Terapkan player Anoboy ke 1 judul di 1 file katalog.
 * existingRow: row yang sudah ada (Samehadaku) atau null = buat baru.
 */
function applyPlayersToCatalog(catalog, payload, existingRow = undefined) {
  const { candidate, playersByEp, thumbnail, hubUrl, title, meta } = payload;
  const existing =
    existingRow === undefined
      ? findExistingAnime(catalog, candidate)
      : existingRow;
  const stats = { matched: Boolean(existing), addedAnime: 0, addedEps: 0, addedPlayers: 0 };

  if (existing) {
    applyAnoboyMeta(existing, meta);
    for (const [epNum, list] of playersByEp) {
      const { ep, created } = ensureEpisode(existing, epNum, {
        source: list[0]?.source_page || hubUrl,
      });
      if (created) stats.addedEps += 1;
      for (const p of list) {
        if (mergePlayerIntoEpisode(ep, makeAnoboyPlayer(p.url, p.label))) {
          stats.addedPlayers += 1;
        }
      }
    }
    return { row: existing, stats };
  }

  const episodes = [];
  for (const [epNum, list] of [...playersByEp.entries()].sort((a, b) => a[0] - b[0])) {
    const players = list.map((p, i) => ({
      no: i + 1,
      ...makeAnoboyPlayer(p.url, p.label),
      default: i === 0,
    }));
    episodes.push({
      episode: epNum,
      title: `${title} Episode ${epNum}`,
      slug: `${candidate.slug}-episode-${epNum}`,
      source: list[0]?.source_page || hubUrl,
      date: "",
      players,
    });
    stats.addedEps += 1;
    stats.addedPlayers += players.length;
  }

  const displayTitle = meta?.title || title;
  const row = {
    type: "anime",
    source_site: "anoboy",
    nama: displayTitle,
    judul: displayTitle,
    tahun: "",
    thumbnail: thumbnail || meta?.thumb || "",
    rating: "",
    votes: "",
    durasi: episodes.length ? `${episodes.length} eps` : "",
    episodes_count: episodes.length,
    genre: [],
    sinopsis: "",
    related: [],
    slug: candidate.slug,
    source: hubUrl,
    season_label: "",
    episodes,
    players: episodes.at(-1)?.players || [],
    id: nextId(catalog),
    is_new: true,
  };
  applyAnoboyMeta(row, meta);
  catalog.unshift(row);
  stats.addedAnime = 1;
  return { row, stats };
}

async function scrapeListingPage(page, n) {
  const url = n <= 1 ? LIST_URL : `${BASE}/anime/page/${n}/`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(1800);
  return page.evaluate(() => {
    const cards = [...document.querySelectorAll(".column-content a")].filter(
      (a) => a.querySelector("img") && /anoboy\.xyz\/\d{4}\/\d{2}\//.test(a.href),
    );
    const seen = new Set();
    const items = [];
    for (const a of cards) {
      if (seen.has(a.href)) continue;
      seen.add(a.href);
      const img = a.querySelector("img");
      const raw = (a.textContent || "").replace(/\s+/g, " ").trim();
      const title = raw.replace(/\s+UP\s+\S+.*$/i, "").trim();
      items.push({
        href: a.href,
        title,
        thumbnail: img?.src || img?.getAttribute("data-src") || "",
      });
    }
    const pagText = document.body?.innerText || "";
    const max = pagText.match(/Laman\s+\d+\s+dari\s+(\d+)/i);
    return { items, maxPages: max ? Number(max[1]) : 0 };
  });
}

async function scrapeLatestPage(page, n) {
  const url = n <= 1 ? HOME_URL : `${BASE}/page/${n}/`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(1800);
  return page.evaluate(() => {
    const cards = [...document.querySelectorAll(".home_index a")].filter(
      (a) => a.querySelector("img") && /anoboy\.xyz\/\d{4}\/\d{2}\//.test(a.href),
    );
    const seen = new Set();
    const items = [];
    for (const a of cards) {
      if (seen.has(a.href)) continue;
      seen.add(a.href);
      const img = a.querySelector("img");
      const raw = (a.textContent || "").replace(/\s+/g, " ").trim();
      const title = raw.replace(/\s+UP\s+\S+.*$/i, "").trim();
      items.push({
        href: a.href,
        title,
        thumbnail: img?.src || img?.getAttribute("data-src") || "",
      });
    }
    return items;
  });
}

async function scrapeHub(page, hubUrl) {
  await page.goto(hubUrl, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(1800);
  const hubSlug = decodeURIComponent(slugFromUrl(hubUrl));
  return page.evaluate(
    ({ hubSlug, hubUrl }) => {
      const h1 = (document.querySelector("h1")?.textContent || "")
        .replace(/\s*Subtitle Indonesia.*$/i, "")
        .trim();
      const thumb =
        document.querySelector('meta[property="og:image"]')?.content ||
        document.querySelector(".entry-content img")?.src ||
        "";
      const servers = [...document.querySelectorAll("button.server")].map((b) => ({
        id: b.id,
        label: (b.textContent || "").replace(/\s+/g, " ").trim(),
      }));
      const batch = [];
      for (const s of servers.filter((x) => x.label)) {
        const box = document.querySelector(`div.${s.id}`);
        if (!box) continue;
        for (const a of box.querySelectorAll("a[data-video]")) {
          batch.push({
            text: (a.textContent || "").replace(/\s+/g, " ").trim(),
            serverLabel: s.label,
            video: a.getAttribute("data-video") || "",
          });
        }
      }
      const iframe =
        document.querySelector("#mediaplayer")?.src ||
        document.querySelector("#tontonin")?.src ||
        document.querySelector("iframe")?.src ||
        "";
      const links = [];
      const seen = new Set();
      const candidates = [
        ...document.querySelectorAll("ul.lcp_catlist a"),
        ...document.querySelectorAll("a"),
      ];
      for (const a of candidates) {
        const href = a.href || "";
        if (!/anoboy\.xyz\/\d{4}\/\d{2}\//i.test(href)) continue;
        if (!/-episode-\d+/i.test(href)) continue;
        try {
          const path = decodeURIComponent(
            new URL(href).pathname.split("/").filter(Boolean).pop() || "",
          );
          if (!path.includes(hubSlug)) continue;
        } catch {
          continue;
        }
        if (seen.has(href)) continue;
        seen.add(href);
        links.push({
          href,
          text: (a.textContent || "").replace(/\s+/g, " ").trim(),
        });
      }
      const table = {};
      for (const tr of document.querySelectorAll("table tr")) {
        const cells = [...tr.querySelectorAll("th,td")].map((c) =>
          (c.textContent || "").replace(/\s+/g, " ").trim(),
        );
        if (cells.length < 2 || !cells[0]) continue;
        table[cells[0].toLowerCase()] = cells.slice(1).join(" ").trim();
      }
      const junk =
        /judi|slot|qqturbo|qqholiq|macau|bandar|totomaniac|advertise|selamat menyaksikan|di unggah oleh|nonton anime|update selanjutnya|rekomended|copyright/i;
      let sinopsis = "";
      for (const el of document.querySelectorAll("div.unduhan")) {
        const t = (el.textContent || "").replace(/\s+/g, " ").trim();
        if (t.length < 160) continue;
        if (/^judul\b/i.test(t) && t.length < 500) continue;
        if (junk.test(t)) continue;
        if (/^anime genre/i.test(t)) continue;
        sinopsis = t;
        break;
      }
      if (!sinopsis) {
        const root =
          document.querySelector(".entry-content") ||
          document.querySelector("article") ||
          document.body;
        for (const p of root.querySelectorAll("p")) {
          const t = (p.textContent || "").replace(/\s+/g, " ").trim();
          if (t.length < 160) continue;
          if (junk.test(t)) continue;
          if (/^anime genre/i.test(t)) continue;
          if (t.length > sinopsis.length) sinopsis = t;
        }
      }
      return { h1, thumb, batch, iframe, links, table, sinopsis: sinopsis.slice(0, 4000) };
    },
    { hubSlug, hubUrl },
  );
}

function metaFromHub(hub, hubUrl) {
  const t = hub?.table || {};
  const pick = (...keys) => {
    for (const k of keys) {
      const v = String(t[k] || "").trim();
      if (v) return v;
    }
    return "";
  };
  const cleanTitle = (s) =>
    String(s || "")
      .replace(/\s*Subtitle Indonesia.*$/i, "")
      .replace(/\s*Episode\s+\d+.*$/i, "")
      .trim();
  const fromTable = cleanTitle(pick("judul", "title"));
  const fromH1 = cleanTitle(hub?.h1);
  const title =
    fromTable && !/episode\s+\d+/i.test(pick("judul", "title"))
      ? fromTable
      : fromH1 || fromTable;
  const genre = pick("genre")
    .split(/[,/|]/)
    .map((s) => s.trim())
    .filter((s) => s && !/^(anime|ongoing)$/i.test(s));
  const rating = pick("score", "skor").replace(/[^\d.]/g, "");
  const epRaw = pick("episodes", "episode");
  const epHint = Number(
    (epRaw.match(/s\/d\s*(\d+)/i) || epRaw.match(/(\d+)\s*$/) || [])[1] || 0,
  );
  return {
    title,
    sinopsis: String(hub?.sinopsis || "").trim(),
    genre,
    rating,
    durasi: pick("durasi", "duration"),
    tahun: yearFromUrl(hubUrl),
    studio: pick("studio"),
    sumber: pick("source", "sumber"),
    episodesHint: epHint > 0 ? epHint : 0,
    thumb: hub?.thumb || "",
  };
}

function applyAnoboyMeta(row, meta) {
  if (!row || !meta || !isAnoboyOnly(row)) return false;
  let changed = false;
  if (meta.title && meta.title !== row.nama) {
    row.nama = meta.title;
    row.judul = meta.title;
    changed = true;
  }
  if (meta.sinopsis && meta.sinopsis !== row.sinopsis) {
    row.sinopsis = meta.sinopsis;
    changed = true;
  }
  if (meta.genre?.length) {
    row.genre = [...meta.genre];
    changed = true;
  }
  if (meta.rating && String(row.rating || "") !== String(meta.rating)) {
    row.rating = meta.rating;
    changed = true;
  }
  if (meta.durasi) {
    row.durasi = meta.durasi;
    changed = true;
  }
  if (meta.tahun && !row.tahun) {
    row.tahun = String(meta.tahun);
    changed = true;
  }
  if (meta.studio) {
    row.studio = meta.studio;
    changed = true;
  }
  if (meta.sumber) {
    row.sumber = meta.sumber;
    changed = true;
  }
  if (meta.thumb && !row.thumbnail) {
    row.thumbnail = meta.thumb;
    changed = true;
  }
  if (meta.episodesHint && !row.episodes_count) {
    row.episodes_count = meta.episodesHint;
    changed = true;
  }
  return changed;
}

function playersFromBatch(batchRows, sourcePage) {
  const byEp = new Map();
  for (const row of batchRows) {
    if (/zipy|zippyshare|yupbatch/i.test(row.video || "")) continue;
    const url = bloggerFromAnoboyPath(row.video);
    if (!url) continue;
    const eps = parseEpisodeNumbers(row.text);
    for (const episode of eps) {
      if (!byEp.has(episode)) byEp.set(episode, []);
      byEp.get(episode).push({
        url,
        label: `Anoboy ${row.serverLabel || "B-Tube"}`,
        source_page: sourcePage,
      });
    }
  }
  return byEp;
}

function playersFromIframe(iframeSrc, episode, sourcePage) {
  const byEp = new Map();
  const url = bloggerFromAnoboyPath(iframeSrc);
  if (url && episode) {
    byEp.set(episode, [
      { url, label: ANOBOY_LABEL, source_page: sourcePage },
    ]);
  }
  return byEp;
}

/** Mirror kualitas di halaman 1 episode (Btube / 360 / PC 720), bukan daftar EP. */
function playersFromMirrors(mirrors, episode, sourcePage) {
  const byEp = new Map();
  if (!episode) return byEp;
  const list = [];
  const seen = new Set();
  for (const row of mirrors) {
    if (/zipy|zippyshare|yupbatch/i.test(row.video || "")) continue;
    const url = bloggerFromAnoboyPath(row.video);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const text = String(row.text || "").replace(/\s+/g, " ").trim() || "B-Tube";
    if (/^btube$/i.test(text)) continue;
    list.push({
      url,
      label: `Anoboy ${text}`,
      source_page: sourcePage,
    });
  }
  if (list.length) byEp.set(episode, list);
  return byEp;
}

async function scrapeEpisodePlayers(page, epUrl) {
  await page.goto(epUrl, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(1200);
  const data = await page.evaluate(() => {
    const servers = [...document.querySelectorAll("button.server")].map((b) => ({
      id: b.id,
      label: (b.textContent || "").replace(/\s+/g, " ").trim(),
    }));
    const batch = [];
    for (const s of servers.filter((x) => x.label)) {
      const box = document.querySelector(`div.${s.id}`);
      if (!box) continue;
      for (const a of box.querySelectorAll("a[data-video]")) {
        batch.push({
          text: (a.textContent || "").replace(/\s+/g, " ").trim(),
          serverLabel: s.label,
          video: a.getAttribute("data-video") || "",
        });
      }
    }
    const mirrors = [
      ...document.querySelectorAll("a[data-video], a#allmiror"),
    ].map((a) => ({
      text: (a.textContent || "").replace(/\s+/g, " ").trim(),
      video: a.getAttribute("data-video") || "",
    }));
    const iframeEl =
      document.querySelector("#mediaplayer") ||
      document.querySelector("#tontonin") ||
      document.querySelector("iframe");
    const iframe = iframeEl?.src || iframeEl?.getAttribute("src") || "";
    const title = (document.querySelector("h1")?.textContent || "").trim();
    return { batch, mirrors, iframe, title };
  });
  const parsed = parseEpisodeFromUrl(epUrl, data.title);
  let byEp = new Map();
  if (data.batch.length) {
    mergeMaps(byEp, playersFromBatch(data.batch, epUrl));
  }
  if (parsed.episode) {
    mergeMaps(byEp, playersFromMirrors(data.mirrors, parsed.episode, epUrl));
  }
  if (!byEp.size && data.iframe && parsed.episode) {
    mergeMaps(byEp, playersFromIframe(data.iframe, parsed.episode, epUrl));
  }
  return { byEp, parsed, title: data.title };
}

function mergeMaps(target, extra) {
  for (const [ep, list] of extra) {
    if (!target.has(ep)) target.set(ep, []);
    target.get(ep).push(...list);
  }
}

function writeCatalog(file, catalog) {
  const reindexed = catalog.map((row, idx) => ({ ...row, id: idx + 1 }));
  return writeFile(file, JSON.stringify(reindexed, null, 2) + "\n", "utf8");
}

async function loadBothCatalogs(dataDir, extraDirs) {
  const dirs = [dataDir, ...extraDirs];
  const loaded = [];
  for (const dir of dirs) {
    const file = join(dir, "anime.json");
    const items = await readJsonArray(file);
    loaded.push({ dir, file, items });
  }
  return loaded;
}

function applyToAll(loaded, payload) {
  let template = null;
  for (const pack of [...loaded].reverse()) {
    const hit = findExistingAnime(pack.items, payload.candidate);
    if (hit) {
      template = hit;
      break;
    }
  }

  const combined = {
    matched: Boolean(template),
    addedAnime: 0,
    addedEps: 0,
    addedPlayers: 0,
  };

  for (const pack of loaded) {
    if (template) {
      let row = pack.items.find((a) => a.slug === template.slug);
      if (!row) {
        row = structuredClone(template);
        pack.items.unshift(row);
        combined.addedAnime += 1;
      }
      const { stats } = applyPlayersToCatalog(pack.items, payload, row);
      combined.addedEps += stats.addedEps;
      combined.addedPlayers += stats.addedPlayers;
    } else {
      const { stats } = applyPlayersToCatalog(pack.items, payload, null);
      combined.addedAnime += stats.addedAnime;
      combined.addedEps += stats.addedEps;
      combined.addedPlayers += stats.addedPlayers;
    }
  }
  return combined;
}

async function saveAll(loaded) {
  for (const pack of loaded) {
    await writeCatalog(pack.file, pack.items);
  }
}

function logMerge(label, stats, title) {
  const mode = stats.matched ? "match Samehadaku → +server" : "baru → +anime+server";
  console.log(
    `[anoboy] ${label} ${mode}: ${title} (+anime ${stats.addedAnime} +ep ${stats.addedEps} +player ${stats.addedPlayers})`,
  );
}

function collectAnoboyMetaJobs(loaded) {
  const jobs = [];
  const seen = new Set();
  for (const pack of loaded) {
    for (const row of pack.items) {
      if (!isAnoboyOnly(row)) continue;
      const hubUrl = resolveHubUrl(row.source || "");
      if (!/anoboy\.xyz\/\d{4}\/\d{2}\//i.test(hubUrl)) continue;
      const key = hubUrl.replace(/\/+$/, "").toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      jobs.push({
        hubUrl,
        slug: slugFromUrl(hubUrl) || row.slug,
        title: row.nama || row.judul || "",
      });
    }
  }
  return jobs;
}

function applyMetaToAnoboyCatalogs(loaded, candidate, meta, hubUrl) {
  let updated = 0;
  for (const pack of loaded) {
    const row = findExistingAnime(pack.items, candidate);
    if (!row || !isAnoboyOnly(row)) continue;
    if (applyAnoboyMeta(row, meta)) updated += 1;
    if (hubUrl && /-episode-\d+/i.test(String(row.source || ""))) {
      row.source = hubUrl;
    }
  }
  return updated;
}

/**
 * Isi sinopsis/genre/skor/studio ke judul Anoboy saja (bukan Samehadaku).
 * Hanya kunjungi halaman hub, tanpa scrape player episode.
 */
export async function enrichAnoboyMeta(rootDir, opts = {}) {
  const dataDir = join(rootDir, "public", "data");
  const mobileDir = join(dataDir, "mobile");
  await mkdir(join(rootDir, STATE_DIR), { recursive: true });
  const stateFile = join(rootDir, STATE_DIR, "meta-state.json");
  const hubLimit = Math.max(0, Number(opts.limit) || 0);
  const onlyHub = String(opts.hub || "").trim();

  let state = { doneHubs: [] };
  if (opts.resume) {
    try {
      state = { ...state, ...JSON.parse(await readFile(stateFile, "utf8")) };
    } catch {
      /* fresh */
    }
  }

  const loaded = await loadBothCatalogs(dataDir, [mobileDir]);
  let jobs = collectAnoboyMetaJobs(loaded);
  if (onlyHub) {
    const resolved = resolveHubUrl(onlyHub);
    jobs = jobs.filter(
      (j) => j.hubUrl.replace(/\/+$/, "") === resolved.replace(/\/+$/, ""),
    );
    if (!jobs.length) {
      jobs = [
        {
          hubUrl: resolved,
          slug: slugFromUrl(resolved),
          title: "",
        },
      ];
    }
  }
  const done = new Set(state.doneHubs || []);
  const pending = jobs.filter((j) => !done.has(j.hubUrl));
  const slice = hubLimit ? pending.slice(0, hubLimit) : pending;

  const totals = {
    jobs: jobs.length,
    visited: 0,
    updated: 0,
    skipped: 0,
  };
  console.log(
    `[anoboy-meta] ${slice.length} hub (dari ${jobs.length} judul Anoboy, skip ${done.size})`,
  );

  const browser = await launchBrowser();
  const page = await makePage(browser);
  try {
    for (let i = 0; i < slice.length; i++) {
      const job = slice[i];
      try {
        const hub = await scrapeHub(page, job.hubUrl);
        const meta = metaFromHub(hub, job.hubUrl);
        const title = meta.title || job.title || hub.h1 || "";
        const candidate = {
          slug: job.slug || slugFromUrl(job.hubUrl),
          title,
        };
        const n = applyMetaToAnoboyCatalogs(loaded, candidate, meta, job.hubUrl);
        if (!n) {
          totals.skipped += 1;
          console.warn(`[anoboy-meta] skip ${candidate.slug}: bukan judul Anoboy baru`);
        } else {
          totals.updated += n;
          console.log(
            `[anoboy-meta] ${title} → genre=${(meta.genre || []).join("/") || "-"} rating=${meta.rating || "-"} studio=${meta.studio || "-"}`,
          );
          if (totals.visited % 10 === 9) await saveAll(loaded);
        }
      } catch (err) {
        console.warn(`[anoboy-meta] ${job.hubUrl}:`, err.message);
      }
      done.add(job.hubUrl);
      state.doneHubs = [...done];
      await writeFile(stateFile, JSON.stringify(state, null, 2), "utf8");
      totals.visited += 1;
      if (i < slice.length - 1) await sleep(DETAIL_DELAY_MS);
    }
    await saveAll(loaded);
    console.log("[anoboy-meta] selesai", totals);
    return totals;
  } finally {
    await browser.close();
  }
}

/**
 * Full scrape /anime/ (resume-able).
 */
export async function scrapeAnoboyFull(rootDir, opts = {}) {
  const dataDir = join(rootDir, "public", "data");
  const mobileDir = join(dataDir, "mobile");
  await mkdir(dataDir, { recursive: true });
  await mkdir(mobileDir, { recursive: true });
  await mkdir(join(rootDir, STATE_DIR), { recursive: true });
  const stateFile = join(rootDir, STATE_DIR, "state.json");

  const startPage = Math.max(1, Number(opts.start) || 1);
  const pageCap = Math.max(0, Number(opts.pages) || 0);
  const hubLimit = Math.max(0, Number(opts.limit) || 0);

  let state = { page: startPage, doneHubs: [], maxPages: 0 };
  if (opts.resume) {
    try {
      state = { ...state, ...JSON.parse(await readFile(stateFile, "utf8")) };
    } catch {
      /* fresh */
    }
  }

  const loaded = await loadBothCatalogs(dataDir, [mobileDir]);
  const browser = await launchBrowser();
  const page = await makePage(browser);
  const totals = {
    hubs: 0,
    matched: 0,
    addedAnime: 0,
    addedEps: 0,
    addedPlayers: 0,
  };

  try {
    const first = await scrapeListingPage(page, state.page || startPage);
    const maxPages = pageCap
      ? Math.min(first.maxPages || pageCap, startPage + pageCap - 1)
      : first.maxPages || 118;
    state.maxPages = maxPages;
    console.log(`[anoboy-full] halaman ${state.page || startPage}–${maxPages}`);

    const done = new Set(state.doneHubs || []);
    let hubsThisRun = 0;

    for (let n = state.page || startPage; n <= maxPages; n++) {
      const listing = n === (state.page || startPage) && first.items.length
        ? first
        : await scrapeListingPage(page, n);
      console.log(`[anoboy-full] list hlm ${n}/${maxPages}: ${listing.items.length} judul`);

      for (const item of listing.items) {
        if (hubLimit && hubsThisRun >= hubLimit) {
          state.page = n;
          await writeFile(stateFile, JSON.stringify(state, null, 2), "utf8");
          console.log(`[anoboy-full] limit ${hubLimit} hub tercapai, state disimpan`);
          return totals;
        }
        if (done.has(item.href)) continue;

        try {
          const hub = await scrapeHub(page, item.href);
          const meta = metaFromHub(hub, item.href);
          const title = meta.title || hub.h1 || item.title;
          const seriesSlug = slugFromUrl(item.href);
          const playersByEp = new Map();

          if (hub.batch.length) {
            mergeMaps(playersByEp, playersFromBatch(hub.batch, item.href));
          }

          const epLinks = hub.links.slice(0, opts.maxEpsPerHub || 80);
          console.log(
            `[anoboy-full] ${seriesSlug}: ${epLinks.length} episode di hub`,
          );
          for (let i = 0; i < epLinks.length; i++) {
            try {
              const scraped = await scrapeEpisodePlayers(page, epLinks[i].href);
              mergeMaps(playersByEp, scraped.byEp);
            } catch (err) {
              console.warn(`[anoboy-full] ep ${epLinks[i].href}:`, err.message);
            }
            if (i < epLinks.length - 1) await sleep(DETAIL_DELAY_MS);
          }

          if (!playersByEp.size && hub.iframe) {
            const parsed = parseEpisodeFromUrl(item.href, title);
            mergeMaps(
              playersByEp,
              playersFromIframe(hub.iframe, parsed.episode, item.href),
            );
          }

          if (!playersByEp.size) {
            console.warn(
              `[anoboy-full] skip ${seriesSlug}: tidak ada player (ep links=${epLinks.length})`,
            );
            if (!epLinks.length && !hub.batch.length) {
              done.add(item.href);
            }
          } else {
            const stats = applyToAll(loaded, {
              candidate: { slug: seriesSlug, title },
              playersByEp,
              thumbnail: hub.thumb || item.thumbnail,
              hubUrl: item.href,
              title,
              meta,
            });
            if (stats.matched) totals.matched += 1;
            totals.addedAnime += stats.addedAnime;
            totals.addedEps += stats.addedEps;
            totals.addedPlayers += stats.addedPlayers;
            logMerge("full", stats, title);
            await saveAll(loaded);
            done.add(item.href);
          }
        } catch (err) {
          console.warn(`[anoboy-full] hub ${item.href}:`, err.message);
        }

        state.doneHubs = [...done];
        state.page = n;
        await writeFile(stateFile, JSON.stringify(state, null, 2), "utf8");
        hubsThisRun += 1;
        totals.hubs += 1;
        await sleep(DETAIL_DELAY_MS);
      }
    }

    console.log("[anoboy-full] selesai", totals);
    return totals;
  } finally {
    await browser.close();
  }
}

/**
 * Sync inkremental homepage Anoboy (untuk GitHub Actions).
 */
export async function syncAnoboyLatest(dataDir, extraDirs = [], opts = {}) {
  const pages = Math.max(1, Number(opts.pages ?? process.env.ANOBOY_LATEST_PAGES ?? 3) || 3);
  const limit = Math.max(0, Number(opts.limit) || 0);
  const dirs = [dataDir, ...extraDirs];
  for (const dir of dirs) await mkdir(dir, { recursive: true });

  const loaded = await loadBothCatalogs(dataDir, extraDirs);
  const browser = await launchBrowser();
  const page = await makePage(browser);
  const totals = {
    checked: 0,
    matched: 0,
    added: 0,
    addedEps: 0,
    addedPlayers: 0,
    slugs: [],
  };

  try {
    const listings = [];
    for (let n = 1; n <= pages; n++) {
      const items = await scrapeLatestPage(page, n);
      listings.push(...items);
      console.log(`[anoboy-sync] terbaru hlm ${n}/${pages}: ${items.length} post`);
      if (n < pages) await sleep(DETAIL_DELAY_MS);
    }
    totals.checked = listings.length;
    const jobs = limit ? listings.slice(0, limit) : listings;

    for (let i = 0; i < jobs.length; i++) {
      const item = jobs[i];
      try {
        const scraped = await scrapeEpisodePlayers(page, item.href);
        const titleClean = (item.title || scraped.title || "")
          .replace(/\s*Episode\s+\d+.*$/i, "")
          .replace(/\s*Subtitle Indonesia.*$/i, "")
          .trim();
        const seriesSlug = scraped.parsed.seriesSlug || slugFromUrl(item.href);
        const hubUrl = resolveHubUrl(item.href);
        let meta = null;
        try {
          const hub = await scrapeHub(page, hubUrl);
          meta = metaFromHub(hub, hubUrl);
        } catch (err) {
          console.warn(`[anoboy-sync] meta ${hubUrl}:`, err.message);
        }
        if (!scraped.byEp.size) {
          console.warn(`[anoboy-sync] skip ${seriesSlug}: player kosong`);
        } else {
          const stats = applyToAll(loaded, {
            candidate: { slug: seriesSlug, title: titleClean },
            playersByEp: scraped.byEp,
            thumbnail: item.thumbnail,
            hubUrl,
            title: meta?.title || titleClean,
            meta,
          });
          if (stats.matched) totals.matched += 1;
          totals.added += stats.addedAnime;
          totals.addedEps += stats.addedEps;
          totals.addedPlayers += stats.addedPlayers;
          if (stats.addedAnime || stats.addedPlayers || stats.addedEps) {
            totals.slugs.push(seriesSlug);
          }
          logMerge("latest", stats, titleClean);
        }
      } catch (err) {
        console.warn(`[anoboy-sync] ${item.href}:`, err.message);
      }
      if (i < jobs.length - 1) await sleep(DETAIL_DELAY_MS);
    }

    await saveAll(loaded);
    console.log("[anoboy-sync] selesai", {
      checked: totals.checked,
      matched: totals.matched,
      added: totals.added,
      episodes_added: totals.addedEps,
      players: totals.addedPlayers,
    });
    return totals;
  } finally {
    await browser.close();
  }
}
