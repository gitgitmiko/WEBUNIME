/**
 * Resolve backdrop landscape dari TMDB (search movie / tv).
 * Env: TMDB_API_KEY
 */

import {
  cleanSearchTitle,
  extractYear,
} from "./landscape-utils.js";

const TMDB_API = "https://api.themoviedb.org/3";
const IMG_BASE = "https://image.tmdb.org/t/p/w780";
const UA = "WEBUNIME-tmdb-landscape/1.0";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function scoreTitle(query, candidate) {
  const q = query.toLowerCase();
  const c = String(candidate || "").toLowerCase();
  if (!c) return 0;
  if (c === q) return 100;
  if (c.startsWith(q) || q.startsWith(c)) return 80;
  if (c.includes(q) || q.includes(c)) return 60;
  const qt = new Set(q.split(/[^a-z0-9]+/).filter((t) => t.length > 2));
  const ct = new Set(c.split(/[^a-z0-9]+/).filter((t) => t.length > 2));
  if (!qt.size) return 0;
  let hit = 0;
  for (const t of qt) if (ct.has(t)) hit++;
  return Math.round((hit / qt.size) * 50);
}

async function tmdbGet(path, params, apiKey) {
  const url = new URL(`${TMDB_API}${path}`);
  url.searchParams.set("api_key", apiKey);
  for (const [k, v] of Object.entries(params || {})) {
    if (v != null && v !== "") url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": UA },
  });
  if (res.status === 429) {
    await sleep(1500);
    const retry = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": UA },
    });
    if (!retry.ok) throw new Error(`TMDB HTTP ${retry.status}`);
    return retry.json();
  }
  if (!res.ok) throw new Error(`TMDB HTTP ${res.status}`);
  return res.json();
}

function pickBackdrop(results, query, year) {
  if (!Array.isArray(results) || !results.length) return null;
  let best = null;
  let bestScore = -1;
  for (const row of results) {
    if (!row?.backdrop_path) continue;
    const title = row.title || row.name || row.original_title || row.original_name || "";
    let s = scoreTitle(query, title);
    const date = String(row.release_date || row.first_air_date || "");
    if (year && date.startsWith(year)) s += 25;
    else if (year && date && !date.startsWith(year)) s -= 10;
    if (s > bestScore) {
      bestScore = s;
      best = row;
    }
  }
  if (!best || bestScore < 40) return null;
  return `${IMG_BASE}${best.backdrop_path}`;
}

/**
 * @param {{ title?: string, year?: string, mediaType?: string, apiKey?: string }} opts
 * mediaType: movie | tv | anime | anime-movie | horror | series
 */
export async function resolveTmdbLandscape(opts = {}) {
  const apiKey = opts.apiKey || process.env.TMDB_API_KEY || "";
  if (!apiKey) return null;

  const query = cleanSearchTitle(opts.title || "");
  if (!query) return null;
  const year = opts.year || "";
  const media = String(opts.mediaType || "movie").toLowerCase();

  const tryMovie = media === "movie" || media === "horror" || media === "anime-movie";
  const tryTv =
    media === "tv" ||
    media === "series" ||
    media === "anime" ||
    media === "anime-movie";

  const endpoints = [];
  if (tryMovie) endpoints.push("movie");
  if (tryTv) endpoints.push("tv");
  if (!endpoints.length) endpoints.push("movie", "tv");

  for (const kind of endpoints) {
    const params = { query, include_adult: "false", language: "en-US" };
    if (year) {
      if (kind === "movie") params.year = year;
      else params.first_air_date_year = year;
    }
    try {
      const data = await tmdbGet(`/search/${kind}`, params, apiKey);
      const url = pickBackdrop(data.results, query, year);
      if (url) return url;
    } catch (err) {
      console.warn(`[tmdb] search ${kind}:`, err.message);
    }
  }

  // Tanpa filter tahun jika miss
  if (year) {
    for (const kind of endpoints) {
      try {
        const data = await tmdbGet(
          `/search/${kind}`,
          { query, include_adult: "false", language: "en-US" },
          apiKey
        );
        const url = pickBackdrop(data.results, query, "");
        if (url) return url;
      } catch {
        /* ignore */
      }
    }
  }

  return null;
}

/**
 * Resolve landscape untuk satu item katalog.
 * Urutan: TMDB → (opsional) site URL yang sudah diekstrak.
 */
export async function resolveItemLandscape(item, opts = {}) {
  const title = item.judul || item.nama || item.title || "";
  const year = extractYear(item);
  const mediaType = opts.mediaType || item.type || "movie";

  const tmdb = await resolveTmdbLandscape({
    title,
    year,
    mediaType,
    apiKey: opts.apiKey,
  });
  if (tmdb) return tmdb;

  if (opts.siteLandscape) return opts.siteLandscape;
  if (item.thumbnail_landscape && /^https?:\/\//i.test(item.thumbnail_landscape)) {
    return item.thumbnail_landscape;
  }
  return null;
}
