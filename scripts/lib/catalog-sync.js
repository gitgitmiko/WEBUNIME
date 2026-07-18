/**
 * Sync inkremental katalog:
 * - LK21: film / series / horor (halaman 1)
 * - Samehadaku: anime-terbaru (5 hlm, episode baru) + anime-movie (judul baru)
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { syncSamehadakuCatalog } from "./samehadaku-sync.js";

const LIST_BASE = "https://tv12.lk21official.cc";
const DRAMA_BASE = "https://tv5.nontondrama.my";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const THROTTLE_MS = 5 * 60 * 1000;
const DETAIL_DELAY_MS = 200;

let syncInFlight = null;
let lastSyncAt = 0;
let lastSyncResult = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchHtml(url, referer = `${LIST_BASE}/`) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "id-ID,id;q=0.9,en;q=0.8",
      Referer: referer,
    },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return { html: await res.text(), finalUrl: res.url };
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
    if (!slug || /^(latest|search|genre|year|page|top-series|nontondrama)/i.test(slug)) continue;

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
      url: m.groups.url,
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
  return {
    judul,
    sinopsis: buildFullDescription(html, judul),
    thumbnail: poster,
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
  return {
    nama: nama || item.title || item.slug,
    judul: detail.judul.includes("(")
      ? detail.judul
      : `${nama || item.title} (${tahun || item.tahun || ""})`.replace(/\(\s*\)/, "").trim(),
    tahun: tahun || item.tahun || "",
    thumbnail: detail.thumbnail || item.thumbnail,
    rating: item.rating || null,
    durasi: detail.durasi || item.durasi || "",
    genre: ensureGenre(item.genre, genreLabel),
    sinopsis: detail.sinopsis,
    slug: item.slug,
    source: item.source,
    ...(catalog ? { catalog } : {}),
    players,
  };
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
  return {
    type: "series",
    nama: nama || item.title || item.slug,
    judul: cleanTitle(judul).includes("(")
      ? cleanTitle(judul)
      : `${nama || item.title} (${tahun || item.tahun || watch.year || ""})`
          .replace(/\(\s*\)/, "")
          .trim(),
    tahun: String(watch.year || tahun || item.tahun || ""),
    thumbnail: watch.poster || detailBase.thumbnail || item.thumbnail,
    rating: watch.rating || item.rating || null,
    durasi:
      item.durasi ||
      [
        watch.total_eps ? `${watch.total_eps} eps` : "",
        watch.total_season ? `S.${watch.total_season}` : item.season_label,
      ]
        .filter(Boolean)
        .join(" · "),
    episodes_count: watch.total_eps || item.episodes_count || episodes.length,
    seasons_count: watch.total_season || null,
    genre: item.genre || [],
    sinopsis: buildFullDescription(html, judul),
    slug: item.slug,
    source: finalUrl || `${DRAMA_BASE}/${item.slug}`,
    list_source: item.source,
    episodes,
    players: latestWithPlayers?.players || [],
  };
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
      added.push(movie);
      bySlug.set(movie.slug, movie);
      console.log(`[lk21-sync] +film ${movie.slug}`);
    } catch (err) {
      console.warn(`[lk21-sync] movie ${item.slug}:`, err.message);
    }
    if (i < newcomers.length - 1) await sleep(DETAIL_DELAY_MS);
  }

  if (added.length) {
    const merged = [...added, ...existing];
    await writeFile(file, JSON.stringify(merged, null, 2) + "\n", "utf8");
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

  return { checked: listings.length, added: added.length, updated: 0, slugs: added.map((m) => m.slug) };
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
      added.push(movie);
      console.log(`[lk21-sync] +horror ${movie.slug}`);
    } catch (err) {
      console.warn(`[lk21-sync] horror ${item.slug}:`, err.message);
    }
    if (i < newcomers.length - 1) await sleep(DETAIL_DELAY_MS);
  }

  if (added.length) {
    const merged = [...added, ...existing];
    await writeFile(file, JSON.stringify(merged, null, 2) + "\n", "utf8");
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

  return { checked: listings.length, added: added.length, updated: 0, slugs: added.map((m) => m.slug) };
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
  await mkdir(dataDir, { recursive: true });

  syncInFlight = (async () => {
    const started = Date.now();
    console.log("[catalog-sync] mulai (LK21 → Samehadaku)…");
    const results = {
      movies: await syncMoviesCatalog(dataDir),
      series: await syncSeriesCatalog(dataDir),
      horror: await syncHorrorCatalog(dataDir),
    };

    try {
      const sameha = await syncSamehadakuCatalog(dataDir);
      results.anime = sameha.anime;
      results.animeMovies = sameha.animeMovies;
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

    const added =
      results.movies.added +
      results.series.added +
      results.horror.added +
      (results.anime?.added || 0) +
      (results.animeMovies?.added || 0);
    const updated =
      results.movies.updated +
      results.series.updated +
      results.horror.updated +
      (results.anime?.updated || 0) +
      (results.animeMovies?.updated || 0);
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
  }
}
