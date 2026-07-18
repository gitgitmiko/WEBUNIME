/**
 * Sync inkremental Samehadaku (Playwright — Cloudflare).
 *
 * Anime series: https://v2.samehadaku.how/anime-terbaru/ (halaman 1–5)
 *   → hanya tambah episode yang belum ada di anime.json
 *
 * Anime movie: https://v2.samehadaku.how/anime-movie/
 *   → hanya tambah judul baru ke anime-movies.json
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";

const BASE = "https://v2.samehadaku.how";
const TERBARU_URL = `${BASE}/anime-terbaru/`;
const MOVIE_URL = `${BASE}/anime-movie/`;
const TERBARU_PAGES = 5;
const MOVIE_PAGES = 2;
const DETAIL_DELAY_MS = 350;

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
  return {
    judul: h1 || fallback.title || fallback.slug,
    thumbnail: absUrl(thumb),
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
  const re =
    /class=["'][^"']*east_player_option[^"']*["'][^>]*data-post=["'](\d+)["'][^>]*data-nume=["'](\d+)["'][^>]*data-type=["']([^"']+)["'][^>]*>[\s\S]*?<span>([\s\S]*?)<\/span>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const label = stripTags(m[4]);
    options.push({
      post: m[1],
      nume: m[2],
      type: m[3],
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
  for (const opt of options) {
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
      if (!url || /just a moment|tunggu sebentar/i.test(body)) continue;
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
  }
  return players;
}

async function scrapeEpisodePlayers(page, ep) {
  if (!ep.inline) {
    await page.goto(ep.source, { waitUntil: "domcontentloaded", timeout: 120000 });
    if (!(await waitReady(page))) throw new Error("Cloudflare timeout");
    await page.waitForTimeout(500);
  }
  const html = await page.content();
  ep.players = await resolvePlayers(page, html);
  return ep;
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

async function syncAnimeTerbaru(page, dataDir) {
  const file = join(dataDir, "anime.json");
  const existing = await readJsonArray(file);
  const bySlug = new Map(existing.map((a) => [a.slug, a]));

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
        };

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
        // Anime lama: hanya episode yang belum ada
        const known = new Set(
          (current.episodes || []).map((e) => `${e.episode}:${e.slug || ""}`)
        );
        const knownNums = new Set((current.episodes || []).map((e) => Number(e.episode)));
        const feedEp = Number(item.episode);
        if (knownNums.has(feedEp)) {
          // sudah punya
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
          void known;
        }
      }
    } catch (err) {
      console.warn(`[samehadaku-sync] ${item.slug}:`, err.message);
    }

    if (i < jobs.length - 1) await sleep(DETAIL_DELAY_MS);
  }

  if (changed) {
    const reindexed = existing.map((row, idx) => ({ ...row, id: idx + 1 }));
    await writeFile(file, JSON.stringify(reindexed, null, 2) + "\n", "utf8");
  }

  return {
    checked: listings.length,
    anime_touched: touched.length,
    added: addedAnime,
    updated: updatedAnime,
    episodes_added: addedEps,
    slugs: touched,
  };
}

async function syncAnimeMovies(page, dataDir) {
  const file = join(dataDir, "anime-movies.json");
  const existing = await readJsonArray(file);
  const bySlug = new Map(existing.map((a) => [a.slug, a]));

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
      };
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
    checked: listings.length,
    added: added.length,
    updated: 0,
    slugs: added.map((m) => m.slug),
  };
}

/**
 * @param {string} dataDir public/data
 */
export async function syncSamehadakuCatalog(dataDir) {
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
    // Warmup CF
    await page.goto(TERBARU_URL, { waitUntil: "domcontentloaded", timeout: 120000 });
    await waitReady(page);

    const anime = await syncAnimeTerbaru(page, dataDir);
    const animeMovies = await syncAnimeMovies(page, dataDir);
    return { anime, animeMovies };
  } finally {
    await browser.close();
  }
}
