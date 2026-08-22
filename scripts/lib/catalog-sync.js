/**
 * Sync inkremental katalog:
 * - LK21: film / series / horor (halaman 1)
 * - Samehadaku: anime-terbaru (5 hlm) + anime-movie + jadwal
 * - Anoboy: homepage terbaru (merge server; judul baru jika belum ada)
 *   ditulis ke public/data (TV) dan public/data/mobile (HP)
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import { syncSamehadakuCatalog } from "./samehadaku-sync.js";
import { syncAnoboyLatest } from "./anoboy-sync.js";
import { syncIndonesiaCatalog } from "./kconaz-indonesia.js";
import {
  extractLk21Quality,
  shouldRefreshLk21Quality,
} from "./lk21-quality.js";
import { extractSiteLandscape } from "./landscape-utils.js";
import {
  rewritePlayerUrl,
  rewritePlayerHostsInCatalog,
} from "./player-host-aliases.js";

const LIST_BASE = "https://tv12.lk21official.cc";
const DRAMA_BASE = "https://tv5.nontondrama.my";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const THROTTLE_MS = 5 * 60 * 1000;
const DETAIL_DELAY_MS = 200;
const SERIES_LATEST_PAGES = 2;
const SERIES_LATEST_FEED_CAP = 80;
/** Budget scrape judul baru dari /latest-series per sync. */
const SERIES_LATEST_ADD_BUDGET = 8;
/** Budget backfill episode yang belum ada (prioritas di atas judul baru). */
const SERIES_LATEST_UPDATE_BUDGET = 24;
const QUALITY_BACKFILL_PAGES = 5;
const FETCH_TIMEOUT_MS = 45000;
const CF_WAIT_MS = 90000;

let syncInFlight = null;
let lastSyncAt = 0;
let lastSyncResult = null;
let lk21Browser = null;
let lk21Context = null;
let lk21Page = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function emptyLk21Result(error) {
  const out = {
    checked: 0,
    added: 0,
    updated: 0,
    slugs: [],
    updatedSlugs: [],
  };
  if (error) out.error = String(error?.message || error);
  return out;
}

async function waitCloudflareClear(page, timeoutMs = CF_WAIT_MS) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const title = await page.title();
    if (
      !/just a moment|tunggu sebentar|attention required|checking your browser|cloudflare/i.test(
        title
      )
    ) {
      return true;
    }
    await page.waitForTimeout(1000);
  }
  return false;
}

async function ensureLk21Page() {
  if (lk21Page) return lk21Page;
  const opts = {
    headless: true,
    args: ["--disable-blink-features=AutomationControlled"],
  };
  try {
    lk21Browser = await chromium.launch({ ...opts, channel: "chrome" });
  } catch {
    lk21Browser = await chromium.launch(opts);
  }
  lk21Context = await lk21Browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1365, height: 900 },
    locale: "id-ID",
    extraHTTPHeaders: {
      "Accept-Language": "id-ID,id;q=0.9,en;q=0.8",
    },
  });
  await lk21Context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  lk21Page = await lk21Context.newPage();
  return lk21Page;
}

async function closeLk21Browser() {
  try {
    await lk21Context?.close();
  } catch {
    /* ignore */
  }
  try {
    await lk21Browser?.close();
  } catch {
    /* ignore */
  }
  lk21Browser = null;
  lk21Context = null;
  lk21Page = null;
}

async function fetchHtmlPlain(url, referer = `${LIST_BASE}/`) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "id-ID,id;q=0.9,en;q=0.8",
        Referer: referer,
      },
      redirect: "follow",
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return { html: await res.text(), finalUrl: res.url };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchHtmlPlaywright(url, referer = `${LIST_BASE}/`) {
  const page = await ensureLk21Page();
  await page.setExtraHTTPHeaders({ Referer: referer });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
  if (!(await waitCloudflareClear(page))) {
    throw new Error(`Cloudflare timeout ${url}`);
  }
  await page.waitForTimeout(400);
  return { html: await page.content(), finalUrl: page.url() };
}

/** LK21 di belakang Cloudflare — Playwright dulu, fallback fetch polos. */
async function fetchHtml(url, referer = `${LIST_BASE}/`) {
  try {
    return await fetchHtmlPlaywright(url, referer);
  } catch (pwErr) {
    console.warn(`[lk21-sync] playwright gagal → fetch: ${pwErr.message}`);
    return fetchHtmlPlain(url, referer);
  }
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
  return t
    .replace(/^Nonton\s+(?:Serial\s+)?/i, "")
    .replace(/\s+Sub\s+Indo.*$/i, "")
    .replace(/\s+di\s+Lk21.*$/i, "")
    .replace(/^Lk21\s+Nonton\s+/i, "")
    .trim();
}

function splitNamaTahun(judul) {
  const m = judul.match(/^(.*?)(?:\s*\((\d{4})\))\s*$/);
  if (m) return { nama: m[1].trim(), tahun: m[2] };
  const y = judul.match(/\b(19|20)\d{2}\b/);
  return {
    nama: judul.replace(/\s*\(\d{4}\)\s*$/, "").trim(),
    tahun: y?.[0] || "",
  };
}

function ensureGenre(list, label) {
  const out = [...(list || [])];
  if (label && !out.some((g) => g.toLowerCase() === label.toLowerCase())) out.push(label);
  return out;
}

function extractListings(html, { seriesMode = false } = {}) {
  const items = [];
  const re =
    /<article\b[^>]*itemtype=["']https?:\/\/schema\.org\/Movie["'][^>]*>([\s\S]*?)<\/article>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const block = m[0];
    const href =
      block.match(/itemprop=["']url["'][^>]*href=["']([^"']+)["']/i)?.[1] ||
      block.match(/href=["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    let path;
    try {
      path = new URL(href, LIST_BASE).pathname;
    } catch {
      continue;
    }
    const slug = slugFromPath(path);
    if (
      !slug ||
      /^(latest|search|genre|year|page|top-series|nontondrama)/i.test(slug)
    ) {
      continue;
    }

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
      block
        .match(/itemprop=["']duration["'][^>]*content=["'][^"']*["'][^>]*>([^<]+)/i)?.[1]
        ?.trim() ||
      block.match(/class=["']duration["'][^>]*>([^<]+)/i)?.[1]?.trim() ||
      "";
    const eps =
      block.match(/class=["']episode[^"']*["'][^>]*>\s*EPS\s*<strong>(\d+)<\/strong>/i)?.[1] ||
      "";
    const seasonLabel =
      block.match(/class=["']duration["'][^>]*>([^<]+)/i)?.[1]?.trim() || "";
    const poster =
      block.match(/itemprop=["']image["'][^>]*content=["']([^"']+)["']/i)?.[1] ||
      block.match(/<img[^>]+src=["']([^"']+)["']/i)?.[1] ||
      "";
    const title =
      block.match(/itemprop=["']name["'][^>]*content=["']([^"']+)["']/i)?.[1] ||
      block.match(/class=["']poster-title["'][^>]*>([^<]+)/i)?.[1] ||
      block.match(/alt=["']([^"']+)["']/i)?.[1] ||
      slug;

    const item = {
      slug,
      source: `${LIST_BASE}/${slug}`,
      title: cleanTitle(title),
      tahun: year,
      rating: rating || null,
      quality: extractLk21Quality(block) || null,
      durasi: seriesMode
        ? [eps ? `${eps} eps` : "", seasonLabel].filter(Boolean).join(" · ")
        : formatDuration(durationText) || formatDuration(durationIso),
      episodes_count: eps ? Number(eps) : null,
      season_label: seasonLabel,
      genre: genreRaw
        .split(",")
        .map((g) => g.trim())
        .filter(Boolean),
      thumbnail: poster,
    };
    items.push(item);
  }
  return items;
}

function normalizePlayerUrl(url) {
  return rewritePlayerUrl(url);
}

function extractPlayers(html) {
  const selectMatch = html.match(
    /<select[^>]*id=["']player-select["'][^>]*>([\s\S]*?)<\/select>/i
  );
  if (!selectMatch) return [];
  const optionRe =
    /<option\s+value=["'](?<url>[^"']+)["']\s+data-server=["'](?<server>[^"']*)["'](?<rest>[^>]*)>(?<label>[\s\S]*?)<\/option>/gi;
  const players = [];
  let m;
  let no = 0;
  while ((m = optionRe.exec(selectMatch[1])) !== null) {
    no += 1;
    players.push({
      no,
      server: m.groups.server,
      label: stripTags(m.groups.label),
      url: normalizePlayerUrl(m.groups.url),
      default: /\bselected\b/i.test(m.groups.rest),
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
  return `Film ${judul}.`;
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
  const siteLandscape = extractSiteLandscape(html, {
    portraitUrl: poster || fallback.thumbnail,
    base: LIST_BASE,
    slug: fallback.slug,
    nama: fallback.title || fallback.nama,
    judul: judul,
  });
  return {
    judul,
    sinopsis: buildFullDescription(html, judul),
    thumbnail: poster,
    thumbnail_landscape: siteLandscape || fallback.thumbnail_landscape || null,
    durasi: fallback.durasi || "",
  };
}

function extractSeasonEpisodes(html) {
  const raw = html.match(
    /<script[^>]*id=["']season-data["'][^>]*>([\s\S]*?)<\/script>/i
  )?.[1];
  if (!raw) return [];
  let data;
  try {
    data = JSON.parse(raw.trim());
  } catch {
    return [];
  }
  const episodes = [];
  for (const [seasonKey, list] of Object.entries(data || {})) {
    if (!Array.isArray(list)) continue;
    for (const ep of list) {
      episodes.push({
        season: Number(ep.s || seasonKey) || 1,
        episode: Number(ep.episode_no) || 0,
        title: ep.title || `Episode ${ep.episode_no}`,
        slug: ep.slug,
        source: ep.slug ? `${DRAMA_BASE}/${ep.slug}` : "",
        players: [],
      });
    }
  }
  episodes.sort((a, b) => a.season - b.season || a.episode - b.episode);
  return episodes;
}

function extractWatchMeta(html) {
  const raw = html.match(
    /<script[^>]*id=["']watch-history-data["'][^>]*>([\s\S]*?)<\/script>/i
  )?.[1];
  if (!raw) return {};
  try {
    return JSON.parse(raw.trim());
  } catch {
    return {};
  }
}

async function resolveDramaHtml(slug) {
  try {
    const direct = await fetchHtml(`${DRAMA_BASE}/${slug}`, `${DRAMA_BASE}/`);
    if (
      direct.html.length > 8000 &&
      (/season-data|synopsis|player-select/i.test(direct.html) ||
        !/Mengalihkan ke nontondrama/i.test(direct.html))
    ) {
      return direct;
    }
  } catch {
    /* fallback */
  }
  const gate = await fetchHtml(`${LIST_BASE}/${slug}`);
  const openNow =
    gate.html.match(/id=["']openNow["'][^>]*href=["']([^"']+)["']/i)?.[1] ||
    gate.html.match(/href=["'](https:\/\/[^"']*(?:nontondrama|dramamu)[^"']*)["']/i)?.[1];
  if (!openNow) throw new Error("URL nontondrama tidak ditemukan");
  return fetchHtml(openNow, `${LIST_BASE}/`);
}

async function readJsonArray(filePath) {
  try {
    const data = JSON.parse(await readFile(filePath, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/** File katalog yang punya badge NEW di app TV. */
const IS_NEW_FILES = [
  "movies.json",
  "series.json",
  "series-latest.json",
  "horror.json",
  "indonesia.json",
  "anime.json",
  "anime-movies.json",
  "anime-latest.json",
];

/**
 * Hapus flag is_new dari sync sebelumnya.
 * Judul/feed yang baru di-scrape pada run ini akan di-set is_new lagi.
 */
async function clearIsNewFlags(dataDir) {
  let cleared = 0;
  for (const name of IS_NEW_FILES) {
    const file = join(dataDir, name);
    const items = await readJsonArray(file);
    let changed = false;
    for (const item of items) {
      if (item && Object.prototype.hasOwnProperty.call(item, "is_new")) {
        delete item.is_new;
        changed = true;
        cleared += 1;
      }
    }
    if (changed) {
      await writeFile(file, JSON.stringify(items, null, 2) + "\n", "utf8");
    }
  }
  console.log(`[catalog-sync] reset is_new (${cleared} flag dihapus)`);
  return cleared;
}

async function readJsonObject(filePath) {
  try {
    const data = JSON.parse(await readFile(filePath, "utf8"));
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

function nextId(list) {
  return list.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1;
}

async function scrapeMovieDetail(item, { genreLabel = null, catalog = null } = {}) {
  const { html } = await fetchHtml(item.source);
  if (/Mengalihkan ke nontondrama/i.test(html) && !/player-select/i.test(html)) {
    return null;
  }
  const players = extractPlayers(html);
  const detail = extractDetailMeta(html, item);
  const { nama, tahun } = splitNamaTahun(detail.judul);
  const out = {
    nama: nama || item.title || item.slug,
    judul: detail.judul.includes("(")
      ? detail.judul
      : `${nama || item.title} (${tahun || item.tahun || ""})`.replace(/\(\s*\)/, "").trim(),
    tahun: tahun || item.tahun || "",
    thumbnail: detail.thumbnail || item.thumbnail,
    rating: item.rating || null,
    quality: item.quality || null,
    durasi: detail.durasi || item.durasi || "",
    genre: ensureGenre(item.genre, genreLabel),
    sinopsis: detail.sinopsis,
    slug: item.slug,
    source: item.source,
    ...(catalog ? { catalog } : {}),
    players,
  };
  if (detail.thumbnail_landscape) {
    out.thumbnail_landscape = detail.thumbnail_landscape;
  }
  if (item.trailer_youtube) {
    out.trailer_youtube = item.trailer_youtube;
  }
  return out;
}

function applyListedQualities(listings, bySlug, label, updated) {
  for (const item of listings) {
    const current = bySlug.get(item.slug);
    if (!current) continue;
    if (!shouldRefreshLk21Quality(current.quality, item.quality)) continue;
    current.quality = item.quality;
    updated.push(item.slug);
    console.log(`[lk21-sync] ~${label} ${item.slug} quality=${item.quality}`);
  }
}

/**
 * Judul lama tidak lagi ada di halaman 1, jadi kualitasnya dilengkapi dengan
 * menelusuri halaman listing berikutnya beberapa per sinkronisasi.
 */
async function backfillQualities(pageUrlFor, bySlug, label, updated) {
  const pending = new Set(
    [...bySlug.values()].filter((item) => !item.quality).map((item) => item.slug)
  );
  if (!pending.size) return;

  for (let page = 2; page <= QUALITY_BACKFILL_PAGES + 1; page++) {
    if (!pending.size) break;
    try {
      const { html } = await fetchHtml(pageUrlFor(page));
      for (const item of extractListings(html)) {
        if (!pending.has(item.slug)) continue;
        const current = bySlug.get(item.slug);
        if (!current || !item.quality) continue;
        current.quality = item.quality;
        pending.delete(item.slug);
        updated.push(item.slug);
        console.log(
          `[lk21-sync] ~${label} ${item.slug} quality=${item.quality} (hlm ${page})`
        );
      }
    } catch (err) {
      console.warn(`[lk21-sync] ${label} quality hlm ${page}:`, err.message);
      break;
    }
    await sleep(DETAIL_DELAY_MS);
  }
}

async function scrapeEpisodePlayers(episodes, { delay = DETAIL_DELAY_MS } = {}) {
  const out = [];
  for (let i = 0; i < episodes.length; i++) {
    const ep = { ...episodes[i], players: [] };
    if (ep.slug) {
      try {
        const { html, finalUrl } = await fetchHtml(
          ep.source || `${DRAMA_BASE}/${ep.slug}`,
          `${DRAMA_BASE}/`
        );
        ep.source = finalUrl || ep.source;
        ep.players = extractPlayers(html);
      } catch {
        /* keep empty players */
      }
    }
    out.push(ep);
    if (i < episodes.length - 1 && delay) await sleep(delay);
  }
  return out;
}

async function scrapeSeriesDetail(item) {
  const { html, finalUrl } = await resolveDramaHtml(item.slug);
  const watch = extractWatchMeta(html);
  const detailBase = extractDetailMeta(html, item);
  const judul = watch.title
    ? `${watch.title}${watch.year ? ` (${watch.year})` : ""}`
    : detailBase.judul;
  let episodes = extractSeasonEpisodes(html);
  if (episodes.length) {
    episodes = await scrapeEpisodePlayers(episodes);
  }
  const { nama, tahun } = splitNamaTahun(cleanTitle(judul));
  const latestWithPlayers = [...episodes].reverse().find((e) => e.players?.length);
  const thumb = watch.poster || detailBase.thumbnail || item.thumbnail;
  const siteLandscape =
    detailBase.thumbnail_landscape ||
    extractSiteLandscape(html, {
      portraitUrl: thumb,
      base: DRAMA_BASE,
      slug: item.slug,
      nama: item.title || item.nama,
      judul,
    });
  const out = {
    type: "series",
    nama: nama || item.title || item.slug,
    judul: cleanTitle(judul).includes("(")
      ? cleanTitle(judul)
      : `${nama || item.title} (${tahun || item.tahun || watch.year || ""})`
          .replace(/\(\s*\)/, "")
          .trim(),
    tahun: String(watch.year || tahun || item.tahun || ""),
    thumbnail: thumb,
    rating: watch.rating || item.rating || null,
    durasi:
      item.durasi ||
      [
        Math.max(watch.total_eps || 0, episodes.length)
          ? `${Math.max(watch.total_eps || 0, episodes.length)} eps`
          : "",
        watch.total_season ? `S.${watch.total_season}` : item.season_label,
      ]
        .filter(Boolean)
        .join(" · "),
    episodes_count: Math.max(
      Number(watch.total_eps) || 0,
      Number(item.episodes_count) || 0,
      episodes.length
    ) || null,
    seasons_count: watch.total_season || null,
    genre: item.genre || [],
    sinopsis: buildFullDescription(html, judul),
    slug: item.slug,
    source: finalUrl || `${DRAMA_BASE}/${item.slug}`,
    list_source: item.source,
    episodes,
    players: latestWithPlayers?.players || [],
  };
  if (siteLandscape) out.thumbnail_landscape = siteLandscape;
  return out;
}

async function syncMoviesCatalog(dataDir) {
  const file = join(dataDir, "movies.json");
  const playersFile = join(dataDir, "players.json");
  const existing = await readJsonArray(file);
  const bySlug = new Map(existing.map((m) => [m.slug, m]));
  process.stdout.write("[lk21-sync] film /latest ... ");
  const { html } = await fetchHtml(`${LIST_BASE}/latest`);
  const listings = extractListings(html);
  const newcomers = listings.filter((l) => !bySlug.has(l.slug));
  const qualityUpdated = [];
  applyListedQualities(listings, bySlug, "film", qualityUpdated);
  await backfillQualities(
    (page) => `${LIST_BASE}/latest/page/${page}`,
    bySlug,
    "film",
    qualityUpdated
  );
  console.log(
    `${listings.length} kartu, ${newcomers.length} baru` +
      (newcomers.length ? ` → scrape detail` : " (sudah up-to-date)")
  );
  const added = [];

  for (let i = 0; i < newcomers.length; i++) {
    const item = newcomers[i];
    try {
      const movie = await scrapeMovieDetail(item);
      if (!movie) continue;
      movie.id = nextId([...existing, ...added]);
      movie.is_new = true;
      added.push(movie);
      bySlug.set(movie.slug, movie);
      console.log(`[lk21-sync] +film ${movie.slug}`);
    } catch (err) {
      console.warn(`[lk21-sync] movie ${item.slug}:`, err.message);
    }
    if (i < newcomers.length - 1) await sleep(DETAIL_DELAY_MS);
  }

  if (added.length || qualityUpdated.length) {
    const merged = [...added, ...existing];
    await writeFile(file, JSON.stringify(merged, null, 2) + "\n", "utf8");
  }
  if (added.length) {
    const playersMap = await readJsonObject(playersFile);
    for (const movie of added) {
      playersMap[movie.slug] = {
        slug: movie.slug,
        film: movie.judul,
        source: movie.source,
        scraped_at: new Date().toISOString(),
        players: movie.players,
      };
    }
    await writeFile(playersFile, JSON.stringify(playersMap, null, 2) + "\n", "utf8");
  }

  return {
    checked: listings.length,
    added: added.length,
    updated: qualityUpdated.length,
    slugs: added.map((m) => m.slug),
    updatedSlugs: qualityUpdated,
  };
}

async function syncHorrorCatalog(dataDir) {
  const file = join(dataDir, "horror.json");
  const playersFile = join(dataDir, "horror-players.json");
  const globalPlayersFile = join(dataDir, "players.json");
  const existing = await readJsonArray(file);
  const bySlug = new Map(existing.map((m) => [m.slug, m]));
  process.stdout.write("[lk21-sync] horror /genre/horror ... ");
  const { html } = await fetchHtml(`${LIST_BASE}/genre/horror`);
  const listings = extractListings(html);
  const newcomers = listings.filter((l) => !bySlug.has(l.slug));
  const qualityUpdated = [];
  applyListedQualities(listings, bySlug, "horror", qualityUpdated);
  await backfillQualities(
    (page) => `${LIST_BASE}/genre/horror/page/${page}`,
    bySlug,
    "horror",
    qualityUpdated
  );
  console.log(
    `${listings.length} kartu, ${newcomers.length} baru` +
      (newcomers.length ? ` → scrape detail` : " (sudah up-to-date)")
  );
  const added = [];

  for (let i = 0; i < newcomers.length; i++) {
    const item = newcomers[i];
    try {
      const movie = await scrapeMovieDetail(item, { genreLabel: "Horror", catalog: "horror" });
      if (!movie) continue;
      movie.id = nextId([...existing, ...added]);
      movie.is_new = true;
      added.push(movie);
      console.log(`[lk21-sync] +horror ${movie.slug}`);
    } catch (err) {
      console.warn(`[lk21-sync] horror ${item.slug}:`, err.message);
    }
    if (i < newcomers.length - 1) await sleep(DETAIL_DELAY_MS);
  }

  if (added.length || qualityUpdated.length) {
    const merged = [...added, ...existing];
    await writeFile(file, JSON.stringify(merged, null, 2) + "\n", "utf8");
  }
  if (added.length) {
    const horrorPlayers = await readJsonObject(playersFile);
    const globalPlayers = await readJsonObject(globalPlayersFile);
    for (const movie of added) {
      const entry = {
        slug: movie.slug,
        film: movie.judul,
        source: movie.source,
        catalog: "horror",
        scraped_at: new Date().toISOString(),
        players: movie.players,
      };
      horrorPlayers[movie.slug] = entry;
      globalPlayers[movie.slug] = entry;
    }
    await writeFile(playersFile, JSON.stringify(horrorPlayers, null, 2) + "\n", "utf8");
    await writeFile(globalPlayersFile, JSON.stringify(globalPlayers, null, 2) + "\n", "utf8");
  }

  return {
    checked: listings.length,
    added: added.length,
    updated: qualityUpdated.length,
    slugs: added.map((m) => m.slug),
    updatedSlugs: qualityUpdated,
  };
}

async function syncSeriesCatalog(dataDir) {
  const file = join(dataDir, "series.json");
  const playersFile = join(dataDir, "series-players.json");
  const existing = await readJsonArray(file);
  const bySlug = new Map(existing.map((m) => [m.slug, m]));
  const currentYear = String(new Date().getFullYear());
  process.stdout.write(`[lk21-sync] series /top-series-today (${currentYear}) ... `);
  const { html } = await fetchHtml(`${LIST_BASE}/top-series-today`);
  const listingsAll = extractListings(html, { seriesMode: true });

  // Hanya series tahun berjalan (mis. 2026) — skip judul lama di page 1
  const listings = listingsAll.filter((item) => {
    const year =
      String(item.tahun || "").trim() ||
      item.slug?.match(/(19|20)\d{2}$/)?.[0] ||
      "";
    return year === currentYear;
  });
  console.log(
    `${listingsAll.length} kartu, ${listings.length} tahun ${currentYear}`
  );

  let addedCount = 0;
  let updatedCount = 0;
  const addedSlugs = [];
  const updatedSlugs = [];
  let changed = false;

  for (let i = 0; i < listings.length; i++) {
    const item = listings[i];
    const current = bySlug.get(item.slug);

    if (!current) {
      try {
        const series = await scrapeSeriesDetail(item);
        // Double-check tahun dari detail (jika listing kosong/salah)
        const detailYear =
          String(series.tahun || "").trim() ||
          series.slug?.match(/(19|20)\d{2}$/)?.[0] ||
          "";
        if (detailYear && detailYear !== currentYear) {
          continue;
        }
        series.id = nextId(existing);
        series.is_new = true;
        existing.unshift(series);
        bySlug.set(series.slug, series);
        addedCount += 1;
        addedSlugs.push(series.slug);
        changed = true;
        console.log(`[lk21-sync] +series ${series.slug}`);
      } catch (err) {
        console.warn(`[lk21-sync] series new ${item.slug}:`, err.message);
      }
      if (i < listings.length - 1) await sleep(DETAIL_DELAY_MS);
      continue;
    }

    // Series lama di page 1 (tahun berjalan): cek episode baru
    const listedEps = item.episodes_count || 0;
    const knownEps = current.episodes_count || current.episodes?.length || 0;
    if (listedEps > knownEps || listedEps === 0) {
      try {
        const { html: detailHtml } = await resolveDramaHtml(item.slug);
        const remoteEps = extractSeasonEpisodes(detailHtml);
        const knownSlugs = new Set((current.episodes || []).map((e) => e.slug));
        const missing = remoteEps.filter((e) => e.slug && !knownSlugs.has(e.slug));
        if (missing.length) {
          const scraped = await scrapeEpisodePlayers(missing);
          current.episodes = [...(current.episodes || []), ...scraped].sort(
            (a, b) => a.season - b.season || a.episode - b.episode
          );
          current.episodes_count = Math.max(
            listedEps,
            current.episodes.length,
            Number(extractWatchMeta(detailHtml).total_eps) || 0
          );
          const latest = [...current.episodes].reverse().find((e) => e.players?.length);
          if (latest?.players?.length) current.players = latest.players;
          if (item.durasi) current.durasi = item.durasi;
          updatedCount += 1;
          updatedSlugs.push(item.slug);
          changed = true;
          console.log(
            `[lk21-sync] +ep ${item.slug} (+${missing.length} episode)`
          );
        }
      } catch (err) {
        console.warn(`[lk21-sync] series update ${item.slug}:`, err.message);
      }
      if (i < listings.length - 1) await sleep(DETAIL_DELAY_MS);
    }
  }

  if (changed) {
    await writeFile(file, JSON.stringify(existing, null, 2) + "\n", "utf8");
    const playersMap = await readJsonObject(playersFile);
    for (const slug of [...addedSlugs, ...updatedSlugs]) {
      const series = bySlug.get(slug);
      if (!series) continue;
      playersMap[slug] = {
        slug,
        film: series.judul,
        type: "series",
        source: series.source,
        scraped_at: new Date().toISOString(),
        episodes: (series.episodes || []).map((e) => ({
          season: e.season,
          episode: e.episode,
          slug: e.slug,
          players: e.players,
        })),
      };
    }
    await writeFile(playersFile, JSON.stringify(playersMap, null, 2) + "\n", "utf8");
  }

  return {
    checked: listings.length,
    listed_total: listingsAll.length,
    year: currentYear,
    added: addedCount,
    updated: updatedCount,
    slugs: addedSlugs,
    updatedSlugs,
  };
}

function parseSeasonNumber(label) {
  const m = String(label || "").match(/S\.?\s*(\d+)/i);
  return m ? Number(m[1]) : 1;
}

/**
 * Feed Series Terbaru (per update episode) dari /latest-series — pola anime-latest.
 */
async function mergeSeriesLatestFeed(dataDir, listings) {
  const file = join(dataDir, "series-latest.json");
  const existing = await readJsonArray(file);
  const byKey = new Map(
    existing.map((row) => [
      `${row.series_slug}#${row.season || 1}#${row.episode}`,
      row,
    ])
  );
  const now = new Date().toISOString();
  const rank = new Map();
  listings.forEach((item, idx) => {
    if (!item.slug || !item.episode) return;
    const key = `${item.slug}#${item.season || 1}#${item.episode}`;
    if (!rank.has(key)) rank.set(key, idx);
  });

  for (const item of listings) {
    if (!item.slug || !item.episode) continue;
    const season = item.season || 1;
    const key = `${item.slug}#${season}#${item.episode}`;
    const prev = byKey.get(key);
    if (prev) {
      byKey.set(key, {
        ...prev,
        nama: item.title || prev.nama,
        judul: item.title || prev.judul,
        thumbnail: item.thumbnail || prev.thumbnail,
        source: item.source || prev.source,
        season_label: item.season_label || prev.season_label,
      });
    } else {
      byKey.set(key, {
        series_slug: item.slug,
        nama: item.title,
        judul: item.title,
        episode: item.episode,
        season,
        season_label: item.season_label || `S.${season}`,
        thumbnail: item.thumbnail,
        source: item.source,
        released_at: now,
        feed_rank: rank.get(key) ?? 9999,
        is_new: true,
      });
    }
  }

  const merged = [...byKey.values()]
    .map((row) => {
      const key = `${row.series_slug}#${row.season || 1}#${row.episode}`;
      return {
        ...row,
        feed_rank: rank.has(key) ? rank.get(key) : (row.feed_rank ?? 9999),
      };
    })
    .sort((a, b) => {
      const ra = a.feed_rank ?? 9999;
      const rb = b.feed_rank ?? 9999;
      if (ra !== rb && (ra < 9000 || rb < 9000)) return ra - rb;
      return String(b.released_at || "").localeCompare(String(a.released_at || ""));
    })
    .slice(0, SERIES_LATEST_FEED_CAP)
    .map((row, idx) => ({ ...row, id: idx + 1 }));

  await writeFile(file, JSON.stringify(merged, null, 2) + "\n", "utf8");
  return merged;
}

/**
 * Pastikan parent series di series.json punya episode dari feed latest.
 * Prioritas: backfill episode yang kurang dulu, baru scrape judul baru.
 */
async function ensureSeriesFromLatestListings(dataDir, listings) {
  const file = join(dataDir, "series.json");
  const playersFile = join(dataDir, "series-players.json");
  const existing = await readJsonArray(file);
  const bySlug = new Map(existing.map((m) => [m.slug, m]));

  const seen = new Set();
  const unique = [];
  for (const item of listings) {
    if (!item.slug || seen.has(item.slug)) continue;
    seen.add(item.slug);
    unique.push(item);
  }

  const needsBackfill = (current, item) => {
    const targetEp = Number(item.episode) || 0;
    const targetSeason = item.season || 1;
    if (!targetEp) return false;
    const maxKnown = Math.max(
      0,
      ...(current.episodes || [])
        .filter(
          (e) =>
            e.season == null || Number(e.season) === Number(targetSeason)
        )
        .map((e) => Number(e.episode) || 0)
    );
    // Feed bilang eps N, katalog masih < N → backfill.
    if (maxKnown < targetEp) return true;
    // Atau episodes_count/badge tertinggal dari jumlah scraped.
    const knownCount =
      Number(current.episodes_count) || current.episodes?.length || 0;
    return knownCount < targetEp;
  };

  async function appendMissingEpisodes(current, item) {
    const { html: detailHtml } = await resolveDramaHtml(item.slug);
    const remoteEps = extractSeasonEpisodes(detailHtml);
    const knownSlugs = new Set((current.episodes || []).map((e) => e.slug));
    const missing = remoteEps.filter((e) => e.slug && !knownSlugs.has(e.slug));
    const watch = extractWatchMeta(detailHtml);
    if (missing.length) {
      const scraped = await scrapeEpisodePlayers(missing);
      current.episodes = [...(current.episodes || []), ...scraped].sort(
        (a, b) => a.season - b.season || a.episode - b.episode
      );
    }
    current.episodes_count = Math.max(
      current.episodes?.length || 0,
      Number(watch.total_eps) || 0
    );
    const seasonLabel =
      item.season_label ||
      (watch.total_season ? `S.${watch.total_season}` : null);
    current.durasi = [
      current.episodes_count ? `${current.episodes_count} eps` : "",
      seasonLabel,
    ]
      .filter(Boolean)
      .join(" · ");
    const latest = [...(current.episodes || [])]
      .reverse()
      .find((e) => e.players?.length);
    if (latest?.players?.length) current.players = latest.players;
    return missing.length;
  }

  let addedCount = 0;
  let updatedCount = 0;
  const addedSlugs = [];
  const updatedSlugs = [];
  let changed = false;
  let updateBudget = SERIES_LATEST_UPDATE_BUDGET;
  let addBudget = SERIES_LATEST_ADD_BUDGET;

  // Pass 1 — backfill episode (prioritas, agar feed "EPS 11" tidak buka detail kosong).
  for (let i = 0; i < unique.length && updateBudget > 0; i++) {
    const item = unique[i];
    const current = bySlug.get(item.slug);
    if (!current || !needsBackfill(current, item)) continue;

    updateBudget -= 1;
    try {
      const added = await appendMissingEpisodes(current, item);
      if (added > 0 || needsBackfill(current, item) === false) {
        updatedCount += 1;
        updatedSlugs.push(item.slug);
        changed = true;
        console.log(
          `[lk21-sync] +ep (latest) ${item.slug} (+${added} episode → ${current.episodes_count})`
        );
      } else if (added === 0) {
        // Site belum punya eps yang dijanjikan feed — tetap update badge dari yang ada.
        console.warn(
          `[lk21-sync] series-latest gap ${item.slug}: feed eps ${item.episode}, site ${current.episodes?.length || 0}`
        );
      }
    } catch (err) {
      console.warn(`[lk21-sync] series-latest update ${item.slug}:`, err.message);
    }
    await sleep(DETAIL_DELAY_MS);
  }

  // Pass 2 — judul baru.
  for (let i = 0; i < unique.length && addBudget > 0; i++) {
    const item = unique[i];
    if (bySlug.has(item.slug)) continue;

    addBudget -= 1;
    try {
      const series = await scrapeSeriesDetail(item);
      series.id = nextId(existing);
      series.is_new = true;
      existing.unshift(series);
      bySlug.set(series.slug, series);
      addedCount += 1;
      addedSlugs.push(series.slug);
      changed = true;
      console.log(
        `[lk21-sync] +series (latest) ${series.slug} (${series.episodes?.length || 0}/${series.episodes_count || "?"} eps)`
      );
      // Listing lebih maju dari halaman detail → coba backfill sekali lagi.
      if (needsBackfill(series, item)) {
        try {
          const added = await appendMissingEpisodes(series, item);
          if (added > 0) {
            console.log(
              `[lk21-sync] +ep (latest-immediate) ${series.slug} (+${added})`
            );
          }
        } catch (err) {
          console.warn(
            `[lk21-sync] series-latest immediate ${series.slug}:`,
            err.message
          );
        }
      }
    } catch (err) {
      console.warn(`[lk21-sync] series-latest new ${item.slug}:`, err.message);
    }
    await sleep(DETAIL_DELAY_MS);
  }

  if (changed) {
    await writeFile(file, JSON.stringify(existing, null, 2) + "\n", "utf8");
    const playersMap = await readJsonObject(playersFile);
    for (const slug of [...addedSlugs, ...updatedSlugs]) {
      const series = bySlug.get(slug);
      if (!series) continue;
      playersMap[slug] = {
        slug,
        film: series.judul,
        type: "series",
        source: series.source,
        scraped_at: new Date().toISOString(),
        episodes: (series.episodes || []).map((e) => ({
          season: e.season,
          episode: e.episode,
          slug: e.slug,
          players: e.players,
        })),
      };
    }
    await writeFile(playersFile, JSON.stringify(playersMap, null, 2) + "\n", "utf8");
  }

  return {
    added: addedCount,
    updated: updatedCount,
    slugs: addedSlugs,
    updatedSlugs,
    update_budget_left: updateBudget,
    add_budget_left: addBudget,
  };
}

export async function syncSeriesLatestCatalog(dataDir) {
  const allListings = [];
  for (let page = 1; page <= SERIES_LATEST_PAGES; page++) {
    const url =
      page === 1
        ? `${LIST_BASE}/latest-series`
        : `${LIST_BASE}/latest-series/page/${page}`;
    process.stdout.write(`[lk21-sync] series-latest ${url} ... `);
    try {
      const { html } = await fetchHtml(url);
      const pageItems = extractListings(html, { seriesMode: true });
      console.log(`${pageItems.length} kartu`);
      allListings.push(...pageItems);
    } catch (err) {
      console.warn(`gagal: ${err.message}`);
    }
    if (page < SERIES_LATEST_PAGES) await sleep(DETAIL_DELAY_MS);
  }

  const feedListings = allListings
    .map((item) => {
      const episode = item.episodes_count || null;
      if (!item.slug || !episode) return null;
      const season = parseSeasonNumber(item.season_label);
      return {
        slug: item.slug,
        title: item.title,
        thumbnail: item.thumbnail,
        source: item.source,
        episode,
        season,
        season_label: item.season_label || `S.${season}`,
        episodes_count: episode,
        durasi: item.durasi,
        tahun: item.tahun,
        rating: item.rating,
        genre: item.genre,
      };
    })
    .filter(Boolean);

  const feed = await mergeSeriesLatestFeed(dataDir, feedListings);
  console.log(
    `[lk21-sync] series-latest feed: ${feedListings.length} scrape → ${feed.length} tersimpan`
  );
  const ensure = await ensureSeriesFromLatestListings(dataDir, feedListings);
  return {
    checked: feedListings.length,
    feed: feed.length,
    ...ensure,
  };
}

/**
 * @param {string} rootDir project root
 * @param {{ force?: boolean }} [opts]
 */
export async function syncCatalogIncremental(rootDir, opts = {}) {
  const force = Boolean(opts.force);
  const now = Date.now();

  if (syncInFlight) {
    return {
      ok: true,
      running: true,
      message: "Sync sedang berjalan",
      last: lastSyncResult,
    };
  }

  if (!force && lastSyncAt && now - lastSyncAt < THROTTLE_MS) {
    return {
      ok: true,
      skipped: true,
      throttle_ms: THROTTLE_MS,
      retry_in_ms: THROTTLE_MS - (now - lastSyncAt),
      last: lastSyncResult,
    };
  }

  const dataDir = join(rootDir, "public", "data");
  const mobileDir = join(dataDir, "mobile");
  await mkdir(dataDir, { recursive: true });
  await mkdir(mobileDir, { recursive: true });

  syncInFlight = (async () => {
    const started = Date.now();
    console.log("[catalog-sync] mulai (LK21 → otherindia Indonesia → Samehadaku → Anoboy)…");
    await clearIsNewFlags(dataDir);
    const results = {
      movies: emptyLk21Result(),
      series: emptyLk21Result(),
      seriesLatest: { checked: 0, feed: 0, added: 0, updated: 0, slugs: [], updatedSlugs: [] },
      horror: emptyLk21Result(),
      indonesia: { checked: 0, added: 0, updated: 0, slugs: [], updatedSlugs: [] },
    };

    try {
      results.movies = await syncMoviesCatalog(dataDir);
    } catch (err) {
      console.warn("[sync] lk21 movies:", err.message);
      results.movies = emptyLk21Result(err);
    }

    try {
      results.series = await syncSeriesCatalog(dataDir);
    } catch (err) {
      console.warn("[sync] lk21 series:", err.message);
      results.series = emptyLk21Result(err);
    }

    try {
      results.horror = await syncHorrorCatalog(dataDir);
    } catch (err) {
      console.warn("[sync] lk21 horror:", err.message);
      results.horror = emptyLk21Result(err);
    }

    try {
      results.seriesLatest = await syncSeriesLatestCatalog(dataDir);
    } catch (err) {
      console.warn("[sync] series-latest:", err.message);
      results.seriesLatest = {
        checked: 0,
        feed: 0,
        added: 0,
        updated: 0,
        slugs: [],
        updatedSlugs: [],
        error: err.message,
      };
    }

    try {
      results.indonesia = await syncIndonesiaCatalog(dataDir);
    } catch (err) {
      console.warn("[sync] otherindia indonesia:", err.message);
      results.indonesia = {
        checked: 0,
        added: 0,
        updated: 0,
        slugs: [],
        updatedSlugs: [],
        error: err.message,
      };
    }

    try {
      const sameha = await syncSamehadakuCatalog(dataDir, [mobileDir]);
      results.anime = sameha.anime;
      results.animeMobile = sameha.animeMobile;
      results.animeMovies = sameha.animeMovies;
      results.animeMoviesMobile = sameha.animeMoviesMobile;
      results.animeSchedule = sameha.schedule;
    } catch (err) {
      console.warn("[sync] samehadaku:", err.message);
      results.anime = {
        checked: 0,
        added: 0,
        updated: 0,
        episodes_added: 0,
        error: err.message,
      };
      results.animeMovies = {
        checked: 0,
        added: 0,
        updated: 0,
        error: err.message,
      };
    }

    try {
      results.anoboy = await syncAnoboyLatest(dataDir, [mobileDir]);
    } catch (err) {
      console.warn("[sync] anoboy:", err.message);
      results.anoboy = {
        checked: 0,
        matched: 0,
        added: 0,
        addedEps: 0,
        addedPlayers: 0,
        error: err.message,
      };
    }

    // Rewrite host player lama → baru di seluruh JSON (alias map).
    try {
      console.log("[catalog-sync] fix player host aliases…");
      results.playerHosts = await rewritePlayerHostsInCatalog(dataDir, {
        readFile,
        writeFile,
      });
      if (results.playerHosts.total) {
        console.log(
          `[catalog-sync] player hosts rewritten: ${results.playerHosts.total}`
        );
      }
    } catch (err) {
      console.warn("[sync] player-hosts:", err.message);
      results.playerHosts = { error: err.message };
    }

    const added =
      results.movies.added +
      results.series.added +
      (results.seriesLatest?.added || 0) +
      results.horror.added +
      (results.indonesia?.added || 0) +
      (results.anime?.added || 0) +
      (results.animeMobile?.added || 0) +
      (results.animeMovies?.added || 0) +
      (results.animeMoviesMobile?.added || 0) +
      (results.anoboy?.added || 0);
    const updated =
      results.movies.updated +
      results.series.updated +
      (results.seriesLatest?.updated || 0) +
      results.horror.updated +
      (results.indonesia?.updated || 0) +
      (results.anime?.updated || 0) +
      (results.animeMobile?.updated || 0) +
      (results.animeMovies?.updated || 0) +
      (results.animeMoviesMobile?.updated || 0) +
      (results.anoboy?.matched || 0);
    const payload = {
      ok: true,
      skipped: false,
      added,
      updated,
      results,
      duration_ms: Date.now() - started,
      synced_at: new Date().toISOString(),
    };
    lastSyncAt = Date.now();
    lastSyncResult = payload;
    console.log(
      `[catalog-sync] selesai +${added} / ~${updated} dalam ${payload.duration_ms}ms`
    );
    return payload;
  })();

  try {
    return await syncInFlight;
  } finally {
    syncInFlight = null;
    await closeLk21Browser();
  }
}
