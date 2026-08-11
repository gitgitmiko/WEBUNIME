/**
 * Sync inkremental Samehadaku (Playwright — Cloudflare).
 *
 * Anime series: https://v2.samehadaku.how/anime-terbaru/ (halaman 1–5)
 *   → tambah episode baru + refresh player yang masih sparse (<6 / hanya 480p)
 *
 * Anime movie: https://v2.samehadaku.how/anime-movie/
 *   → hanya tambah judul baru ke anime-movies.json
 *
 * Jadwal rilis: https://v2.samehadaku.how/jadwal-rilis/
 *   → public/data/anime-schedule.json (overwrite tiap sync)
 *     + salinan yang sama ke extraDirs (public/data/mobile)
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import { extractSiteLandscape } from "./landscape-utils.js";

const BASE = "https://v2.samehadaku.how";
const TERBARU_URL = `${BASE}/anime-terbaru/`;
const MOVIE_URL = `${BASE}/anime-movie/`;
const SCHEDULE_URL = `${BASE}/jadwal-rilis/`;
const TERBARU_PAGES = 5;
const MOVIE_PAGES = 2;
const DETAIL_DELAY_MS = 350;
const SCHEDULE_DAY_DELAY_MS = 500;

/** Urutan tab di halaman jadwal-rilis (data-day + label UI). */
const SCHEDULE_DAYS = [
  { day: "monday", label: "Senin" },
  { day: "tuesday", label: "Selasa" },
  { day: "wednesday", label: "Rabu" },
  { day: "thursday", label: "Kamis" },
  { day: "friday", label: "Jumaat" },
  { day: "saturday", label: "Sabtu" },
  { day: "sunday", label: "Minggu" },
];
/** Di bawah ini dianggap belum lengkap → scrape ulang. */
const PLAYER_MIN_COMPLETE = 6;
/** Batas refresh sparse per sync (env: ANIME_PLAYER_REFRESH_LIMIT). */
const PLAYER_REFRESH_LIMIT = Math.max(
  0,
  Number(process.env.ANIME_PLAYER_REFRESH_LIMIT || 30) || 30
);
const PLAYER_AJAX_DELAY_MS = 120;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function cleanTitle(title) {
  return decodeEntities(stripTags(title))
    .replace(/\s+Subtitle Indonesia.*$/i, "")
    .replace(/\s+Sub Indo.*$/i, "")
    .replace(/\s+–\s*Samehadaku.*$/i, "")
    .trim();
}

function slugFromUrl(url) {
  try {
    const path = new URL(url, BASE).pathname.replace(/\/+$/, "");
    return path.split("/").filter(Boolean).pop() || "";
  } catch {
    return "";
  }
}

function absUrl(href) {
  try {
    return new URL(href, BASE).href;
  } catch {
    return href;
  }
}

function episodeWatchUrl(animeSlug, episode) {
  const n = String(episode).trim();
  if (/special|ova|movie/i.test(n)) {
    return `${BASE}/${animeSlug}-episode-special/`;
  }
  return `${BASE}/${animeSlug}-episode-${n}/`;
}

async function waitReady(page, timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const title = await page.title();
    if (!/just a moment|tunggu sebentar|attention required|checking your browser/i.test(title)) {
      return true;
    }
    await page.waitForTimeout(1000);
  }
  return false;
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

async function readJsonArray(filePath) {
  try {
    const data = JSON.parse(await readFile(filePath, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function nextId(list) {
  let max = 0;
  for (const row of list) {
    const n = Number(row?.id) || 0;
    if (n > max) max = n;
  }
  return max + 1;
}

/** Kartu di /anime-terbaru/ → anime slug + nomor episode baru. */
export function extractTerbaruListings(html) {
  const items = [];
  const re =
    /<li[^>]*itemscope[\s\S]*?<a[^>]+href=["']([^"']*\/anime\/([^/"']+)\/?)["'][^>]*>[\s\S]*?<img[^>]+src=["']([^"']+)["'][\s\S]*?class=["']dtla["'][\s\S]*?<a[^>]*>([\s\S]*?)<\/a>[\s\S]*?<b>\s*Episode\s*<\/b>\s*<author[^>]*>\s*([^<]+)\s*<\/author>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const slug = m[2];
    const epRaw = stripTags(m[5]);
    const epNum = Number(epRaw);
    if (!slug) continue;
    const tail = html.slice(m.index, m.index + m[0].length + 500);
    const releasedOn = stripTags(
      tail.match(/<b>\s*Released on\s*<\/b>\s*:\s*([^<]+)/i)?.[1] || ""
    ).trim();
    items.push({
      slug,
      source: absUrl(m[1]),
      title: cleanTitle(m[4]),
      thumbnail: absUrl(m[3]),
      episode: Number.isFinite(epNum) && epNum > 0 ? epNum : epRaw || 1,
      episode_source: episodeWatchUrl(slug, epRaw),
      released_on: releasedOn,
    });
  }
  return items;
}

/** Merge feed anime terbaru (episode rilis), urutan descending by released_at. */
async function mergeAnimeLatestFeed(dataDir, listings) {
  const file = join(dataDir, "anime-latest.json");
  const existing = await readJsonArray(file);
  const byKey = new Map(
    existing.map((row) => [`${row.anime_slug}#${row.episode}`, row])
  );
  const now = new Date().toISOString();
  const rank = new Map(); // posisi di feed scrape (lebih kecil = lebih baru)
  listings.forEach((item, idx) => {
    const key = `${item.slug}#${item.episode}`;
    if (!rank.has(key)) rank.set(key, idx);
  });

  for (const item of listings) {
    const key = `${item.slug}#${item.episode}`;
    const prev = byKey.get(key);
    if (prev) {
      byKey.set(key, {
        ...prev,
        nama: item.title || prev.nama,
        thumbnail: item.thumbnail || prev.thumbnail,
        released_on: item.released_on || prev.released_on,
        episode_source: item.episode_source || prev.episode_source,
        source: item.source || prev.source,
        // pertahankan released_at lama agar sort stabil
      });
    } else {
      byKey.set(key, {
        anime_slug: item.slug,
        nama: item.title,
        judul: item.title,
        episode: item.episode,
        episode_slug: `${item.slug}-episode-${item.episode}`,
        episode_source: item.episode_source,
        thumbnail: item.thumbnail,
        source: item.source,
        released_on: item.released_on || "",
        released_at: now,
        feed_rank: rank.get(key) ?? 9999,
        is_new: true,
      });
    }
  }

  const merged = [...byKey.values()]
    .map((row) => ({
      ...row,
      feed_rank: rank.has(`${row.anime_slug}#${row.episode}`)
        ? rank.get(`${row.anime_slug}#${row.episode}`)
        : row.feed_rank ?? 9999,
    }))
    .sort((a, b) => {
      // Prioritas: posisi di scrape terbaru, lalu released_at
      const ra = a.feed_rank ?? 9999;
      const rb = b.feed_rank ?? 9999;
      if (ra !== rb && (ra < 9000 || rb < 9000)) return ra - rb;
      return String(b.released_at || "").localeCompare(String(a.released_at || ""));
    })
    .slice(0, 80)
    .map((row, idx) => ({ ...row, id: idx + 1 }));

  await writeFile(file, JSON.stringify(merged, null, 2) + "\n", "utf8");
  return merged;
}

/** Daftar anime-movie (sama pola animpost). */
export function extractMovieListings(html) {
  const items = [];
  const re =
    /<div class=["']animpost[^"']*["'][\s\S]*?<a[^>]*href=["']([^"']+)["'][^>]*title=["']([^"']+)["'][\s\S]*?(?:<img[^>]+src=["']([^"']+)["'][^>]*>)?[\s\S]*?<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = m[1];
    if (!/\/anime\//i.test(href)) continue;
    const slug = slugFromUrl(href);
    if (!slug || items.some((x) => x.slug === slug)) continue;
    items.push({
      slug,
      source: absUrl(href),
      title: cleanTitle(m[2]),
      thumbnail: m[3] ? absUrl(m[3]) : "",
      genre: [],
      tahun: "",
      season_label: "",
    });
  }
  if (!items.length) {
    for (const s of html.matchAll(
      /href=["'](https?:\/\/[^"']*\/anime\/([^/"']+)\/?)["'][^>]*title=["']([^"']+)["']/gi
    )) {
      if (items.some((x) => x.slug === s[2])) continue;
      items.push({
        slug: s[2],
        source: absUrl(s[1]),
        title: cleanTitle(s[3]),
        thumbnail: "",
        genre: [],
        tahun: "",
        season_label: "",
      });
    }
  }
  return items;
}

function extractAnimeDetailMeta(html, fallback = {}) {
  const h1 = cleanTitle(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || "");
  const thumb =
    html.match(/class=["']thumb["'][\s\S]*?<img[^>]+src=["']([^"']+)["']/i)?.[1] ||
    html.match(/property=["']og:image["'][^>]*content=["']([^"']+)["']/i)?.[1] ||
    fallback.thumbnail ||
    "";
  const thumbAbs = absUrl(thumb);
  const rating =
    html.match(/itemprop=["']ratingValue["'][^>]*>([^<]+)/i)?.[1]?.trim() || null;
  const votes =
    html.match(/itemprop=["']ratingCount["'][^>]*content=["']([^"']+)["']/i)?.[1] || null;
  const genreBlock =
    html.match(/class=["']genre-info["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] || "";
  const genres =
    stripTags(genreBlock).match(
      /Action|Adventure|Fantasy|Isekai|Reincarnation|Comedy|Drama|Romance|Horror|Sci-Fi|School|Shounen|Seinen|Supernatural|Historical|Mecha|Ecchi|Sports|Slice of Life|Gore|Samurai|Mystery|Thriller|Military|Music/gi
    ) || [];
  const sinopsisRaw =
    html.match(/class=["']infox["'][^>]*>[\s\S]*?<p>([\s\S]*?)<\/p>/i)?.[1] ||
    html.match(/property=["']og:description["'][^>]*content=["']([^"']+)["']/i)?.[1] ||
    "";
  const episodes = [];
  const liRe =
    /<li>[\s\S]*?<span class=["']eps["']>[\s\S]*?href=["']([^"']+)["'][^>]*>\s*([^<]+?)\s*<\/a>[\s\S]*?<span class=["']lchx["']>[\s\S]*?href=["'][^"']+["'][^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<span class=["']date["'][^>]*>([\s\S]*?)<\/span>)?/gi;
  let em;
  while ((em = liRe.exec(html)) !== null) {
    const num = Number(String(em[2]).trim());
    episodes.push({
      episode: Number.isFinite(num) && num > 0 ? num : 1,
      title: cleanTitle(em[3]),
      slug: slugFromUrl(em[1]),
      source: absUrl(em[1]),
      date: stripTags(em[4] || ""),
      players: [],
    });
  }
  episodes.sort((a, b) => a.episode - b.episode);
  const siteLandscape = extractSiteLandscape(html, {
    portraitUrl: thumbAbs || fallback.thumbnail,
    base: BASE,
    slug: fallback.slug,
    nama: fallback.title || fallback.nama,
    judul: h1 || fallback.title,
  });
  return {
    judul: h1 || fallback.title || fallback.slug,
    thumbnail: thumbAbs,
    thumbnail_landscape: siteLandscape || fallback.thumbnail_landscape || null,
    rating: rating ? String(rating).replace(",", ".") : null,
    votes: votes ? Number(String(votes).replace(/,/g, "")) : null,
    sinopsis: decodeEntities(stripTags(sinopsisRaw)) || `Anime ${h1 || fallback.title}.`,
    genre: [...new Set(genres)],
    episodes,
  };
}

function extractMovieDetail(html, fallback = {}) {
  const meta = extractAnimeDetailMeta(html, fallback);
  if (!meta.episodes.length && /east_player_option/i.test(html)) {
    meta.episodes.push({
      episode: 1,
      title: meta.judul || fallback.title,
      slug: fallback.slug,
      source: fallback.source,
      date: "",
      players: [],
      inline: true,
    });
  }
  if (!meta.episodes.length) {
    const watch = [
      ...html.matchAll(
        /href=["'](https?:\/\/v2\.samehadaku\.how\/(?!anime\/)([^"'?#]+-(?:movie|episode[^"'/]*))\/?)["']/gi
      ),
    ];
    for (const w of watch) {
      const href = absUrl(w[1]);
      if (/feed|wp-json/i.test(href)) continue;
      meta.episodes.push({
        episode: 1,
        title: meta.judul || fallback.title,
        slug: slugFromUrl(href),
        source: href,
        date: "",
        players: [],
      });
      break;
    }
  }
  return meta;
}

function extractPlayerOptions(html) {
  const options = [];
  // Cocokkan blok option; atribut data-* boleh urutan bebas.
  const blockRe =
    /<[^>]*class=["'][^"']*east_player_option[^"']*["'][^>]*>[\s\S]*?<span>([\s\S]*?)<\/span>/gi;
  let m;
  while ((m = blockRe.exec(html)) !== null) {
    const tag = m[0];
    const post = tag.match(/data-post=["'](\d+)["']/i)?.[1];
    const nume = tag.match(/data-nume=["'](\d+)["']/i)?.[1];
    const type = tag.match(/data-type=["']([^"']+)["']/i)?.[1];
    if (!post || !nume || !type) continue;
    const label = stripTags(m[1]);
    options.push({
      post,
      nume,
      type,
      label,
      server:
        label.replace(/\s+\d+p$/i, "").trim().toLowerCase().replace(/\s+/g, "-") || "server",
    });
  }
  return options;
}

function iframeSrcFromAjax(html) {
  return (
    html.match(/<iframe[^>]+src=["']([^"']+)["']/i)?.[1] ||
    html.match(/src=["'](https?:\/\/[^"']+)["']/i)?.[1] ||
    ""
  );
}

async function resolvePlayers(page, episodeHtml) {
  const options = extractPlayerOptions(episodeHtml);
  const players = [];
  for (let i = 0; i < options.length; i++) {
    const opt = options[i];
    try {
      const body = await page.evaluate(
        async ({ post, nume, type }) => {
          const params = new URLSearchParams({
            action: "player_ajax",
            post,
            nume,
            type,
          });
          const res = await fetch("/wp-admin/admin-ajax.php", {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            },
            body: params,
            credentials: "same-origin",
          });
          return await res.text();
        },
        { post: opt.post, nume: opt.nume, type: opt.type }
      );
      const url = iframeSrcFromAjax(body);
      if (!url || /just a moment|tunggu sebentar/i.test(body)) {
        console.warn(`[samehadaku-sync] skip player ${opt.label}: ajax kosong/CF`);
        continue;
      }
      players.push({
        no: players.length + 1,
        server: opt.server,
        label: opt.label,
        url,
        default: players.length === 0,
        post: opt.post,
        nume: opt.nume,
      });
    } catch (err) {
      console.warn(`[samehadaku-sync] player ${opt.label}:`, err.message);
    }
    if (i < options.length - 1) await sleep(PLAYER_AJAX_DELAY_MS);
  }
  return players;
}

function playerCount(ep) {
  return Array.isArray(ep?.players) ? ep.players.length : 0;
}

function hasHighQuality(players) {
  return (players || []).some((p) => /(720|1080)\s*p/i.test(String(p.label || "")));
}

/** Episode belum lengkap: sedikit server, kosong, atau hanya 480p. */
function isSparsePlayers(ep) {
  const n = playerCount(ep);
  if (n <= 0) return true;
  if (n < PLAYER_MIN_COMPLETE) return true;
  const labels = (ep.players || []).map((p) => String(p.label || p.server || ""));
  if (labels.length && labels.every((l) => /480\s*p/i.test(l))) return true;
  return false;
}

function shouldKeepNewPlayers(oldPlayers, newPlayers) {
  if (!newPlayers?.length) return false;
  if (!oldPlayers?.length) return true;
  if (newPlayers.length > oldPlayers.length) return true;
  if (!hasHighQuality(oldPlayers) && hasHighQuality(newPlayers)) return true;
  return false;
}

function ensureEpisodeSource(anime, ep) {
  if (ep.source) return ep.source;
  if (!anime?.slug || ep.episode == null || ep.episode === "") return "";
  ep.source = episodeWatchUrl(anime.slug, ep.episode);
  return ep.source;
}

/** Cache player per URL episode agar TV + mobile tidak scrape server dua kali. */
const scrapedPlayersBySource = new Map();

function clonePlayers(players) {
  return JSON.parse(JSON.stringify(players || []));
}

async function scrapeEpisodePlayers(page, ep) {
  const cacheKey = String(ep.source || "").trim();
  if (!ep.inline && cacheKey && scrapedPlayersBySource.has(cacheKey)) {
    ep.players = clonePlayers(scrapedPlayersBySource.get(cacheKey));
    return ep;
  }
  if (!ep.inline) {
    await page.goto(ep.source, { waitUntil: "domcontentloaded", timeout: 120000 });
    if (!(await waitReady(page))) throw new Error("Cloudflare timeout");
    await page.waitForTimeout(500);
  }
  const html = await page.content();
  ep.players = await resolvePlayers(page, html);
  if (cacheKey && ep.players?.length) {
    scrapedPlayersBySource.set(cacheKey, clonePlayers(ep.players));
  }
  return ep;
}

function asDataDirs(dataDirs) {
  const dirs = Array.isArray(dataDirs) ? dataDirs : [dataDirs];
  return [...new Set(dirs.filter(Boolean))];
}

function dirLabel(dataDir) {
  return /[/\\]mobile$/i.test(String(dataDir).replace(/[/\\]+$/, ""))
    ? "mobile"
    : "tv";
}

function preferPlayers(episodes) {
  const latest = [...episodes].reverse().find((e) => e.players?.length);
  if (!latest?.players?.length) return [];
  const preferred =
    latest.players.find((p) => /blogspot/i.test(p.label)) ||
    latest.players.find((p) => /wibufile/i.test(p.label)) ||
    latest.players[0];
  return preferred
    ? [preferred, ...latest.players.filter((p) => p !== preferred)]
    : latest.players;
}

async function collectTerbaruListings(page) {
  const listings = [];
  const seenKey = new Set();
  for (let p = 1; p <= TERBARU_PAGES; p++) {
    const url = p <= 1 ? TERBARU_URL : `${BASE}/anime-terbaru/page/${p}/`;
    process.stdout.write(`[samehadaku-sync] terbaru ${p}/${TERBARU_PAGES} ... `);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
    if (!(await waitReady(page))) throw new Error("Cloudflare timeout (anime-terbaru)");
    await page.waitForTimeout(800);
    const html = await page.content();
    const batch = extractTerbaruListings(html);
    let added = 0;
    for (const item of batch) {
      const key = `${item.slug}#${item.episode}`;
      if (seenKey.has(key)) continue;
      seenKey.add(key);
      listings.push(item);
      added += 1;
    }
    console.log(`${batch.length} kartu, +${added} unik (total ${listings.length})`);
    if (!batch.length && p > 1) break;
    if (p < TERBARU_PAGES) await sleep(DETAIL_DELAY_MS);
  }
  return listings;
}

async function applyTerbaruToCatalog(page, dataDir, listings) {
  const file = join(dataDir, "anime.json");
  const existing = await readJsonArray(file);
  const bySlug = new Map(existing.map((a) => [a.slug, a]));
  const label = dirLabel(dataDir);
  console.log(`[samehadaku-sync] terbaru apply → ${label} (${existing.length} judul)`);

  // Simpan feed "Anime Terbaru" (episode rilis, descending)
  await mergeAnimeLatestFeed(dataDir, listings);

  // Grup: slug → episode terbaru yang muncul di feed
  const byAnime = new Map();
  for (const item of listings) {
    const cur = byAnime.get(item.slug);
    if (!cur) {
      byAnime.set(item.slug, item);
      continue;
    }
    const a = Number(item.episode) || 0;
    const b = Number(cur.episode) || 0;
    if (a >= b) byAnime.set(item.slug, item);
  }

  let addedAnime = 0;
  let updatedAnime = 0;
  let addedEps = 0;
  let refreshedPlayers = 0;
  const touched = [];
  let changed = false;

  const jobs = [...byAnime.values()];
  for (let i = 0; i < jobs.length; i++) {
    const item = jobs[i];
    const current = bySlug.get(item.slug);

    try {
      if (!current) {
        // Anime baru: ambil meta + daftar eps, isi player hanya utk episode dari feed (+ sisanya kosong dulu)
        console.log(`[samehadaku-sync] anime baru ${item.slug} (ep ${item.episode})`);
        await page.goto(item.source, { waitUntil: "domcontentloaded", timeout: 120000 });
        if (!(await waitReady(page))) throw new Error("Cloudflare timeout");
        await page.waitForTimeout(600);
        const detailHtml = await page.content();
        const detail = extractAnimeDetailMeta(detailHtml, item);

        // Pastikan episode dari feed ada di daftar
        const feedEp = Number(item.episode);
        let epRow = detail.episodes.find((e) => Number(e.episode) === feedEp);
        if (!epRow) {
          epRow = {
            episode: feedEp,
            title: `${detail.judul || item.title} Episode ${feedEp}`,
            slug: `${item.slug}-episode-${feedEp}`,
            source: item.episode_source,
            date: item.released_on || "",
            released_at: new Date().toISOString(),
            players: [],
          };
          detail.episodes.push(epRow);
          detail.episodes.sort((a, b) => a.episode - b.episode);
        } else if (item.released_on && !epRow.date) {
          epRow.date = item.released_on;
          epRow.released_at = epRow.released_at || new Date().toISOString();
        }

        // Scrape players untuk episode feed (+ episode lain yang sudah ada link, max 3 terbaru utk anime baru)
        const toFetch = detail.episodes
          .filter((e) => e.source)
          .sort((a, b) => b.episode - a.episode)
          .slice(0, 3);
        for (let j = 0; j < toFetch.length; j++) {
          await scrapeEpisodePlayers(page, toFetch[j]);
          if (j < toFetch.length - 1) await sleep(DETAIL_DELAY_MS);
        }

        const nama = (detail.judul || item.title).replace(/\s*\(\d{4}\)\s*$/, "").trim();
        const entry = {
          type: "anime",
          source_site: "samehadaku",
          nama,
          judul: detail.judul,
          tahun: detail.judul.match(/\b(20\d{2})\b/)?.[1] || "",
          thumbnail: detail.thumbnail || item.thumbnail,
          rating: detail.rating,
          votes: detail.votes,
          durasi: detail.episodes.length ? `${detail.episodes.length} eps` : "",
          episodes_count: detail.episodes.length,
          genre: detail.genre,
          sinopsis: detail.sinopsis,
          related: [],
          slug: item.slug,
          source: item.source,
          season_label: "",
          episodes: detail.episodes,
          players: preferPlayers(detail.episodes),
          id: nextId(existing),
          is_new: true,
        };
        if (detail.thumbnail_landscape) {
          entry.thumbnail_landscape = detail.thumbnail_landscape;
        }

        if (!entry.episodes.some((e) => e.players?.length)) {
          console.warn(`[samehadaku-sync] skip ${item.slug}: tidak ada server`);
        } else {
          existing.unshift(entry);
          bySlug.set(entry.slug, entry);
          addedAnime += 1;
          addedEps += toFetch.filter((e) => e.players?.length).length;
          touched.push(entry.slug);
          changed = true;
        }
      } else {
        // Anime lama: episode baru ATAU refresh player yang masih sparse
        const knownNums = new Set((current.episodes || []).map((e) => Number(e.episode)));
        const feedEp = Number(item.episode);
        if (knownNums.has(feedEp)) {
          const existingEp = (current.episodes || []).find(
            (e) => Number(e.episode) === feedEp
          );
          if (
            existingEp &&
            isSparsePlayers(existingEp) &&
            (existingEp.source || item.episode_source)
          ) {
            if (!existingEp.source) existingEp.source = item.episode_source;
            const before = playerCount(existingEp);
            const oldPlayers = [...(existingEp.players || [])];
            console.log(
              `[samehadaku-sync] refresh players ${item.slug} #${feedEp} (${before} → ?)`
            );
            try {
              await scrapeEpisodePlayers(page, existingEp);
              if (shouldKeepNewPlayers(oldPlayers, existingEp.players)) {
                current.players = preferPlayers(current.episodes);
                refreshedPlayers += 1;
                touched.push(item.slug);
                changed = true;
                console.log(
                  `[samehadaku-sync] ~players ${item.slug} #${feedEp}: ${before} → ${playerCount(existingEp)}`
                );
              } else {
                existingEp.players = oldPlayers;
              }
            } catch (err) {
              existingEp.players = oldPlayers;
              console.warn(
                `[samehadaku-sync] refresh ${item.slug} #${feedEp}:`,
                err.message
              );
            }
          }
        } else {
          console.log(`[samehadaku-sync] +ep ${item.slug} #${feedEp}`);
          const ep = {
            episode: feedEp,
            title: `${current.judul || current.nama} Episode ${feedEp}`,
            slug: `${item.slug}-episode-${feedEp}`,
            source: item.episode_source,
            date: item.released_on || "",
            released_at: new Date().toISOString(),
            players: [],
          };
          await scrapeEpisodePlayers(page, ep);
          if (!ep.players?.length) {
            console.warn(`[samehadaku-sync] ep ${feedEp} tanpa server, tetap disimpan`);
          }
          current.episodes = [...(current.episodes || []), ep].sort(
            (a, b) => a.episode - b.episode
          );
          current.episodes_count = current.episodes.length;
          current.durasi = `${current.episodes.length} eps`;
          current.players = preferPlayers(current.episodes);
          if (item.thumbnail && !current.thumbnail) current.thumbnail = item.thumbnail;
          updatedAnime += 1;
          addedEps += 1;
          touched.push(item.slug);
          changed = true;
        }
      }
    } catch (err) {
      console.warn(`[samehadaku-sync] ${item.slug}:`, err.message);
    }

    if (i < jobs.length - 1) await sleep(DETAIL_DELAY_MS);
  }

  // Backfill: episode sparse di luar feed hari ini (mirror Samehadaku sudah lengkap belakangan).
  const backfillBudget = Math.max(0, PLAYER_REFRESH_LIMIT - refreshedPlayers);
  if (backfillBudget > 0) {
    const bf = await backfillSparsePlayers(page, existing, {
      limit: backfillBudget,
    });
    refreshedPlayers += bf.refreshed;
    if (bf.refreshed > 0) {
      changed = true;
      touched.push(...bf.slugs);
    }
  }

  if (changed) {
    const reindexed = existing.map((row, idx) => ({ ...row, id: idx + 1 }));
    await writeFile(file, JSON.stringify(reindexed, null, 2) + "\n", "utf8");
  }

  return {
    target: dirLabel(dataDir),
    checked: listings.length,
    anime_touched: [...new Set(touched)].length,
    added: addedAnime,
    updated: updatedAnime,
    episodes_added: addedEps,
    players_refreshed: refreshedPlayers,
    slugs: [...new Set(touched)],
  };
}

async function syncAnimeTerbaru(page, dataDirs) {
  const dirs = asDataDirs(dataDirs);
  const listings = await collectTerbaruListings(page);
  const results = [];
  for (const dataDir of dirs) {
    results.push(await applyTerbaruToCatalog(page, dataDir, listings));
  }
  return results.length === 1 ? results[0] : results;
}

/**
 * Scrape ulang episode dengan player sparse (batas [limit] per sync).
 * Prioritas: released_at terbaru, lalu episode tertinggi, lalu paling sedikit player.
 */
async function backfillSparsePlayers(page, existing, { limit = 30 } = {}) {
  if (limit <= 0) return { refreshed: 0, slugs: [] };

  const candidates = [];
  for (const anime of existing) {
    for (const ep of anime.episodes || []) {
      if (!isSparsePlayers(ep)) continue;
      if (!ensureEpisodeSource(anime, ep)) continue;
      candidates.push({ anime, ep });
    }
  }

  candidates.sort((a, b) => {
    const ra = Date.parse(a.ep.released_at || "") || 0;
    const rb = Date.parse(b.ep.released_at || "") || 0;
    if (rb !== ra) return rb - ra;
    const ea = Number(a.ep.episode) || 0;
    const eb = Number(b.ep.episode) || 0;
    if (eb !== ea) return eb - ea;
    return playerCount(a.ep) - playerCount(b.ep);
  });

  const batch = candidates.slice(0, limit);
  let refreshed = 0;
  const slugs = [];

  console.log(
    `[samehadaku-sync] backfill sparse players: ${batch.length}/${candidates.length} kandidat (limit ${limit})`
  );

  for (let i = 0; i < batch.length; i++) {
    const { anime, ep } = batch[i];
    const before = playerCount(ep);
    const oldPlayers = [...(ep.players || [])];
    try {
      console.log(
        `[samehadaku-sync] backfill ${anime.slug} #${ep.episode} (${before} players)`
      );
      await scrapeEpisodePlayers(page, ep);
      if (shouldKeepNewPlayers(oldPlayers, ep.players)) {
        anime.players = preferPlayers(anime.episodes);
        refreshed += 1;
        slugs.push(anime.slug);
        console.log(
          `[samehadaku-sync] ~backfill ${anime.slug} #${ep.episode}: ${before} → ${playerCount(ep)}`
        );
      } else {
        ep.players = oldPlayers;
        console.log(
          `[samehadaku-sync] backfill keep old ${anime.slug} #${ep.episode} (${before})`
        );
      }
    } catch (err) {
      ep.players = oldPlayers;
      console.warn(
        `[samehadaku-sync] backfill ${anime.slug} #${ep.episode}:`,
        err.message
      );
    }
    if (i < batch.length - 1) await sleep(DETAIL_DELAY_MS);
  }

  return { refreshed, slugs: [...new Set(slugs)] };
}

async function collectMovieListings(page) {
  const listings = [];
  for (let p = 1; p <= MOVIE_PAGES; p++) {
    const url = p <= 1 ? MOVIE_URL : `${BASE}/anime-movie/page/${p}/`;
    process.stdout.write(`[samehadaku-sync] movie list ${p}/${MOVIE_PAGES} ... `);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
    if (!(await waitReady(page))) throw new Error("Cloudflare timeout (anime-movie)");
    await page.waitForTimeout(800);
    const html = await page.content();
    const batch = extractMovieListings(html);
    for (const item of batch) {
      if (!listings.some((x) => x.slug === item.slug)) listings.push(item);
    }
    console.log(`${batch.length} kartu (unique ${listings.length})`);
    if (!batch.length && p > 1) break;
    if (p < MOVIE_PAGES) await sleep(DETAIL_DELAY_MS);
  }
  return listings;
}

async function applyMoviesToCatalog(page, dataDir, listings) {
  const file = join(dataDir, "anime-movies.json");
  const existing = await readJsonArray(file);
  const bySlug = new Map(existing.map((a) => [a.slug, a]));
  console.log(
    `[samehadaku-sync] movie apply → ${dirLabel(dataDir)} (${existing.length} judul)`
  );

  const newcomers = listings.filter((l) => !bySlug.has(l.slug));
  const added = [];

  for (let i = 0; i < newcomers.length; i++) {
    const item = newcomers[i];
    console.log(`[samehadaku-sync] movie baru ${item.slug}`);
    try {
      await page.goto(item.source, { waitUntil: "domcontentloaded", timeout: 120000 });
      if (!(await waitReady(page))) throw new Error("Cloudflare timeout");
      await page.waitForTimeout(600);
      const html = await page.content();
      const detail = extractMovieDetail(html, item);
      for (let j = 0; j < detail.episodes.length; j++) {
        const ep = detail.episodes[j];
        if (ep.inline) {
          ep.players = await resolvePlayers(page, html);
        } else {
          await scrapeEpisodePlayers(page, ep);
        }
        if (j < detail.episodes.length - 1) await sleep(DETAIL_DELAY_MS);
      }
      if (!detail.episodes.some((e) => e.players?.length)) {
        console.warn(`[samehadaku-sync] skip movie ${item.slug}: tanpa server`);
        continue;
      }
      const nama = (detail.judul || item.title).replace(/\s*\(\d{4}\)\s*$/, "").trim();
      const entry = {
        type: "anime-movie",
        source_site: "samehadaku",
        nama,
        judul: detail.judul,
        tahun: detail.judul.match(/\b(20\d{2})\b/)?.[1] || "",
        thumbnail: detail.thumbnail || item.thumbnail,
        rating: detail.rating,
        votes: detail.votes,
        durasi: "Movie",
        episodes_count: detail.episodes.length,
        genre: detail.genre,
        sinopsis: detail.sinopsis,
        related: [],
        slug: item.slug,
        source: item.source,
        season_label: "",
        episodes: detail.episodes,
        players: preferPlayers(detail.episodes),
        id: nextId([...existing, ...added]),
        is_new: true,
      };
      if (detail.thumbnail_landscape) {
        entry.thumbnail_landscape = detail.thumbnail_landscape;
      }
      added.push(entry);
      bySlug.set(entry.slug, entry);
    } catch (err) {
      console.warn(`[samehadaku-sync] movie ${item.slug}:`, err.message);
    }
    if (i < newcomers.length - 1) await sleep(DETAIL_DELAY_MS);
  }

  if (added.length) {
    const merged = [...added, ...existing].map((row, idx) => ({ ...row, id: idx + 1 }));
    await writeFile(file, JSON.stringify(merged, null, 2) + "\n", "utf8");
  }

  return {
    target: dirLabel(dataDir),
    checked: listings.length,
    added: added.length,
    updated: 0,
    slugs: added.map((m) => m.slug),
  };
}

async function syncAnimeMovies(page, dataDirs) {
  const dirs = asDataDirs(dataDirs);
  const listings = await collectMovieListings(page);
  const results = [];
  for (const dataDir of dirs) {
    results.push(await applyMoviesToCatalog(page, dataDir, listings));
  }
  return results.length === 1 ? results[0] : results;
}

/**
 * Parse kartu jadwal di tab hari yang sedang aktif.
 * @param {import('playwright').Page} page
 */
async function extractScheduleDayItems(page) {
  return page.evaluate(() => {
    const root = document.querySelector(".result-schedule") || document;
    const posts = [...root.querySelectorAll(".animepost")];
    return posts
      .map((post) => {
        const link =
          post.querySelector("a[href*='/anime/']") ||
          post.querySelector("a[href]");
        const href = link?.href || "";
        const slugMatch = href.match(/\/anime\/([^/?#]+)/i);
        const slug = slugMatch ? slugMatch[1] : "";
        const title =
          post.querySelector(".data .title")?.textContent?.trim() ||
          post.querySelector("img[alt]")?.getAttribute("alt")?.trim() ||
          "";
        const genreText =
          post.querySelector(".data .type")?.textContent?.trim() || "";
        const thumb =
          post.querySelector("img.anmsa")?.getAttribute("src") ||
          post.querySelector("img")?.getAttribute("src") ||
          "";
        const scoreRaw = post.querySelector(".score")?.textContent || "";
        const rating = scoreRaw.replace(/[^\d.]/g, "").trim();
        const type =
          post.querySelector(".content-thumb .type")?.textContent?.trim() ||
          "";
        const timeRaw =
          post.querySelector(".ltseps")?.textContent ||
          post.querySelector(".data_tw")?.textContent ||
          "";
        const timeMatch = String(timeRaw).match(/(\d{1,2}:\d{2})/);
        return {
          slug,
          judul: title,
          nama: title,
          thumbnail: thumb,
          rating,
          type,
          genre: genreText
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          time: timeMatch ? timeMatch[1] : "",
          source: href,
        };
      })
      .filter((row) => row.slug);
  });
}

/**
 * Scrape jadwal rilis mingguan → anime-schedule.json
 * @param {import('playwright').Page} page
 * @param {string|string[]} dataDirs
 */
export async function syncAnimeSchedule(page, dataDirs) {
  const dirs = asDataDirs(dataDirs);
  process.stdout.write(`[samehadaku-sync] jadwal-rilis ... `);
  await page.goto(SCHEDULE_URL, {
    waitUntil: "domcontentloaded",
    timeout: 120000,
  });
  if (!(await waitReady(page))) {
    throw new Error("Cloudflare timeout (jadwal-rilis)");
  }
  await page.waitForSelector(".east_days_option[data-day]", { timeout: 30000 });
  await page.waitForTimeout(600);

  const days = [];
  let totalItems = 0;

  for (const meta of SCHEDULE_DAYS) {
    const tab = page.locator(`.east_days_option[data-day="${meta.day}"]`).first();
    if ((await tab.count()) === 0) {
      console.warn(`[samehadaku-sync] tab ${meta.day} tidak ditemukan`);
      days.push({ day: meta.day, label: meta.label, items: [] });
      continue;
    }

    await tab.click();
    await page.waitForTimeout(SCHEDULE_DAY_DELAY_MS);
    await page
      .waitForFunction(
        (day) => {
          const on = document.querySelector(
            `.east_days_option.on[data-day="${day}"]`
          );
          const box = document.querySelector(".result-schedule");
          if (!on || !box) return false;
          return (
            box.querySelector(".animepost") != null ||
            box.querySelector(".noschedule") != null ||
            /tidak ada|no schedule/i.test(box.textContent || "")
          );
        },
        meta.day,
        { timeout: 20000 }
      )
      .catch(() => {});

    const rawItems = await extractScheduleDayItems(page);
    const seen = new Set();
    const items = [];
    for (const row of rawItems) {
      if (seen.has(row.slug)) continue;
      seen.add(row.slug);
      items.push({
        slug: row.slug,
        judul: cleanTitle(row.judul || row.nama || row.slug),
        nama: cleanTitle(row.nama || row.judul || row.slug),
        thumbnail: absUrl(row.thumbnail),
        rating: row.rating || "",
        type: row.type || "",
        genre: Array.isArray(row.genre) ? row.genre : [],
        time: row.time || "",
        source: absUrl(row.source || `${BASE}/anime/${row.slug}/`),
      });
    }

    days.push({ day: meta.day, label: meta.label, items });
    totalItems += items.length;
    process.stdout.write(`${meta.label}:${items.length} `);
  }

  const payload = {
    source: SCHEDULE_URL,
    scraped_at: new Date().toISOString(),
    timezone: "Asia/Jakarta",
    days,
  };

  for (const dataDir of dirs) {
    const file = join(dataDir, "anime-schedule.json");
    await writeFile(file, JSON.stringify(payload, null, 2) + "\n", "utf8");
  }
  console.log(
    `→ ${totalItems} item → anime-schedule.json (${dirs.map(dirLabel).join(", ")})`
  );

  return {
    days: days.length,
    items: totalItems,
    file: "anime-schedule.json",
  };
}

/**
 * Hanya scrape jadwal (browser sendiri). Untuk `npm run scrape:anime-schedule`.
 * @param {string} dataDir
 */
export async function scrapeAnimeScheduleOnly(dataDir) {
  await mkdir(dataDir, { recursive: true });
  const browser = await launchBrowser();
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1365, height: 900 },
    locale: "id-ID",
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  const page = await context.newPage();
  try {
    return await syncAnimeSchedule(page, dataDir);
  } finally {
    await browser.close();
  }
}

/**
 * @param {string} dataDir public/data (TV)
 * @param {string[]} [extraDirs] mis. public/data/mobile
 */
export async function syncSamehadakuCatalog(dataDir, extraDirs = []) {
  const dirs = asDataDirs([dataDir, ...extraDirs]);
  for (const dir of dirs) await mkdir(dir, { recursive: true });
  const browser = await launchBrowser();
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1365, height: 900 },
    locale: "id-ID",
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  const page = await context.newPage();

  try {
    // Warmup CF
    await page.goto(TERBARU_URL, { waitUntil: "domcontentloaded", timeout: 120000 });
    await waitReady(page);

    const animeAll = await syncAnimeTerbaru(page, dirs);
    const moviesAll = await syncAnimeMovies(page, dirs);
    const animeRows = Array.isArray(animeAll) ? animeAll : [animeAll];
    const movieRows = Array.isArray(moviesAll) ? moviesAll : [moviesAll];
    let schedule = { days: 0, items: 0, error: null };
    try {
      schedule = await syncAnimeSchedule(page, dirs);
    } catch (err) {
      console.warn("[samehadaku-sync] jadwal-rilis:", err.message);
      schedule = { days: 0, items: 0, error: err.message };
    }
    return {
      anime: animeRows[0],
      animeMobile: animeRows[1] || null,
      animeMovies: movieRows[0],
      animeMoviesMobile: movieRows[1] || null,
      schedule,
    };
  } finally {
    await browser.close();
  }
}

/**
 * Hanya refresh player episode sparse (tanpa sync feed penuh).
 * @param {string} dataDir
 * @param {{ limit?: number }} [opts]
 */
export async function refreshSparseAnimePlayers(dataDir, opts = {}) {
  await mkdir(dataDir, { recursive: true });
  const file = join(dataDir, "anime.json");
  const existing = await readJsonArray(file);
  const limit = Math.max(0, Number(opts.limit ?? PLAYER_REFRESH_LIMIT) || 0);
  if (!existing.length || limit <= 0) {
    return { refreshed: 0, slugs: [], checked: existing.length };
  }

  const browser = await launchBrowser();
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1365, height: 900 },
    locale: "id-ID",
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  const page = await context.newPage();

  try {
    await page.goto(TERBARU_URL, { waitUntil: "domcontentloaded", timeout: 120000 });
    await waitReady(page);
    const bf = await backfillSparsePlayers(page, existing, { limit });
    if (bf.refreshed > 0) {
      const reindexed = existing.map((row, idx) => ({ ...row, id: idx + 1 }));
      await writeFile(file, JSON.stringify(reindexed, null, 2) + "\n", "utf8");
    }
    return { ...bf, checked: existing.length };
  } finally {
    await browser.close();
  }
}
