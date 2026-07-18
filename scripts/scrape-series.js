#!/usr/bin/env node
/**
 * Scrape series drama dari LK21 (/top-series-today) + detail + player tiap episode.
 *
 * Cara pakai:
 *   node scripts/scrape-series.js                 # 10 halaman (default)
 *   node scripts/scrape-series.js --pages 5
 *   node scripts/scrape-series.js --pages 10 --delay 280
 *   node scripts/scrape-series.js --latest-only    # player hanya episode terbaru
 *   node scripts/scrape-series.js --refresh-desc   # perbarui sinopsis saja
 *
 * Hasil:
 *   - public/data/series.json
 *   - public/data/series-players.json
 */

import { writeFile, mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DATA_DIR = join(ROOT, "public", "data");
const SERIES_FILE = join(DATA_DIR, "series.json");
const SERIES_PLAYERS_FILE = join(DATA_DIR, "series-players.json");

const LIST_BASE = "https://tv12.lk21official.cc";
const DRAMA_BASE = "https://tv5.nontondrama.my";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

function parseArgs(argv) {
  const out = {
    pages: 10,
    delay: 280,
    start: 1,
    refreshDesc: false,
    latestOnly: false,
    maxEps: 0,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--pages" && argv[i + 1]) out.pages = Math.max(1, Number(argv[++i]) || 10);
    else if (a === "--delay" && argv[i + 1]) out.delay = Math.max(0, Number(argv[++i]) || 280);
    else if (a === "--start" && argv[i + 1]) out.start = Math.max(1, Number(argv[++i]) || 1);
    else if (a === "--refresh-desc") out.refreshDesc = true;
    else if (a === "--latest-only") out.latestOnly = true;
    else if (a === "--max-eps" && argv[i + 1]) out.maxEps = Math.max(0, Number(argv[++i]) || 0);
  }
  return out;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchHtml(url, referer = LIST_BASE + "/") {
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "id-ID,id;q=0.9,en;q=0.8",
      Referer: referer,
    },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}`);
  return { html: await res.text(), finalUrl: res.url };
}

function listPageUrl(page) {
  if (page <= 1) return `${LIST_BASE}/top-series-today`;
  return `${LIST_BASE}/top-series-today/page/${page}`;
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

function cleanTitle(title) {
  let t = decodeEntities(stripTags(title));
  t = t
    .replace(/^Nonton\s+(?:Serial\s+)?/i, "")
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
  return {
    nama: judul.replace(/\s*\(\d{4}\)\s*$/, "").trim(),
    tahun: y?.[0] || "",
  };
}

function slugFromPath(pathname) {
  return String(pathname || "")
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter(Boolean)
    .pop();
}

function extractListings(html) {
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
    if (!slug || /^(top-series-today|latest|search|genre|year|page|nontondrama)/i.test(slug)) {
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
    const eps =
      block.match(/class=["']episode[^"']*["'][^>]*>\s*EPS\s*<strong>(\d+)<\/strong>/i)?.[1] ||
      "";
    const season =
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

    items.push({
      slug,
      path,
      source: `${LIST_BASE}/${slug}`,
      title: cleanTitle(title),
      tahun: year,
      rating: rating || null,
      episodes_count: eps ? Number(eps) : null,
      season_label: season,
      durasi: [eps ? `${eps} eps` : "", season].filter(Boolean).join(" · "),
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
  return `Series ${judul}.`;
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

function extractDetailMeta(html, fallback = {}) {
  const h1 = cleanTitle(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || "");
  const ogTitle = cleanTitle(
    html.match(/property=["']og:title["'][^>]*content=["']([^"']+)["']/i)?.[1] || ""
  );
  const watch = extractWatchMeta(html);
  const judul =
    watch.title
      ? `${watch.title}${watch.year ? ` (${watch.year})` : ""}`
      : h1 || ogTitle || fallback.title || fallback.judul || fallback.slug;

  const poster =
    watch.poster ||
    html.match(/property=["']og:image["'][^>]*content=["']([^"']+)["']/i)?.[1] ||
    fallback.thumbnail ||
    "";

  return {
    judul: cleanTitle(judul),
    sinopsis: buildFullDescription(html, judul),
    thumbnail: poster,
    rating: watch.rating || fallback.rating || null,
    total_eps: watch.total_eps || fallback.episodes_count || null,
    total_season: watch.total_season || null,
    tahun: String(watch.year || fallback.tahun || ""),
  };
}

async function resolveDramaHtml(slug) {
  // Coba domain drama langsung
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

  // Ikuti redirect dari listing host
  const gate = await fetchHtml(`${LIST_BASE}/${slug}`);
  const openNow =
    gate.html.match(/id=["']openNow["'][^>]*href=["']([^"']+)["']/i)?.[1] ||
    gate.html.match(/href=["'](https:\/\/[^"']*(?:nontondrama|dramamu)[^"']*)["']/i)?.[1];
  if (!openNow) {
    throw new Error("Tidak menemukan URL nontondrama");
  }
  return fetchHtml(openNow, LIST_BASE + "/");
}

async function scrapeListingPages({ start, pages, delay }) {
  const bySlug = new Map();
  const end = start + pages - 1;

  for (let page = start; page <= end; page++) {
    const url = listPageUrl(page);
    process.stdout.write(`→ Halaman ${page}/${end} ${url} ... `);
    try {
      const { html } = await fetchHtml(url);
      const items = extractListings(html);
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

async function scrapeEpisodePlayers(episodes, { delay, latestOnly, maxEps }) {
  let list = [...episodes];
  if (latestOnly && list.length) {
    list = [list[list.length - 1]];
  } else if (maxEps > 0 && list.length > maxEps) {
    list = list.slice(-maxEps);
  }

  const out = [];
  for (let i = 0; i < list.length; i++) {
    const ep = { ...list[i], players: [] };
    if (!ep.slug) {
      out.push(ep);
      continue;
    }
    process.stdout.write(`    ep S${ep.season}E${ep.episode} ... `);
    try {
      const { html, finalUrl } = await fetchHtml(
        ep.source || `${DRAMA_BASE}/${ep.slug}`,
        `${DRAMA_BASE}/`
      );
      ep.source = finalUrl || ep.source;
      ep.players = extractPlayers(html);
      console.log(`${ep.players.length} player`);
    } catch (err) {
      console.log(`GAGAL: ${err.message}`);
    }
    out.push(ep);
    if (i < list.length - 1 && delay) await sleep(delay);
  }

  // Jika latest-only / max-eps, gabungkan dengan episode tanpa players
  if (list.length !== episodes.length) {
    const scraped = new Map(out.map((e) => [e.slug, e]));
    return episodes.map((e) => scraped.get(e.slug) || { ...e, players: [] });
  }
  return out;
}

async function scrapeDetails(listings, opts) {
  const series = [];
  const playersMap = {};
  let withPlayers = 0;

  for (let i = 0; i < listings.length; i++) {
    const item = listings[i];
    const n = i + 1;
    process.stdout.write(`→ [${n}/${listings.length}] ${item.slug} ... `);
    try {
      const { html, finalUrl } = await resolveDramaHtml(item.slug);
      const detail = extractDetailMeta(html, item);
      let episodes = extractSeasonEpisodes(html);
      console.log(
        `OK · ${episodes.length} eps · ${(detail.sinopsis || "").length} char desc`
      );

      if (episodes.length) {
        episodes = await scrapeEpisodePlayers(episodes, opts);
      }

      const { nama, tahun } = splitNamaTahun(detail.judul);
      const latestWithPlayers = [...episodes]
        .reverse()
        .find((e) => e.players?.length);
      const players = latestWithPlayers?.players || [];

      const entry = {
        id: n,
        type: "series",
        nama: nama || item.title || item.slug,
        judul: detail.judul.includes("(")
          ? detail.judul
          : `${nama || item.title} (${tahun || item.tahun || ""})`
              .replace(/\(\s*\)/, "")
              .trim(),
        tahun: detail.tahun || tahun || item.tahun || "",
        thumbnail: detail.thumbnail || item.thumbnail,
        rating: detail.rating || item.rating || null,
        durasi:
          item.durasi ||
          [
            detail.total_eps ? `${detail.total_eps} eps` : "",
            detail.total_season ? `S.${detail.total_season}` : item.season_label,
          ]
            .filter(Boolean)
            .join(" · "),
        episodes_count: detail.total_eps || item.episodes_count || episodes.length,
        seasons_count: detail.total_season || null,
        genre: item.genre?.length ? item.genre : [],
        sinopsis: detail.sinopsis,
        slug: item.slug,
        source: finalUrl || `${DRAMA_BASE}/${item.slug}`,
        list_source: item.source,
        episodes,
        players,
      };

      series.push(entry);
      playersMap[item.slug] = {
        slug: item.slug,
        film: entry.judul,
        type: "series",
        source: entry.source,
        scraped_at: new Date().toISOString(),
        episodes: episodes.map((e) => ({
          season: e.season,
          episode: e.episode,
          slug: e.slug,
          players: e.players,
        })),
      };

      if (players.length || episodes.some((e) => e.players?.length)) withPlayers += 1;
    } catch (err) {
      console.log(`GAGAL: ${err.message}`);
      const { nama, tahun } = splitNamaTahun(item.title);
      series.push({
        id: n,
        type: "series",
        nama: nama || item.title,
        judul: item.title,
        tahun: tahun || item.tahun || "",
        thumbnail: item.thumbnail,
        rating: item.rating,
        durasi: item.durasi,
        episodes_count: item.episodes_count,
        seasons_count: null,
        genre: item.genre,
        sinopsis: `Series ${item.title}.`,
        slug: item.slug,
        source: item.source,
        list_source: item.source,
        episodes: [],
        players: [],
      });
    }

    if (i < listings.length - 1 && opts.delay) await sleep(opts.delay);
  }

  return { series, playersMap, withPlayers };
}

async function refreshDescriptions({ delay }) {
  let series;
  try {
    series = JSON.parse(await readFile(SERIES_FILE, "utf8"));
  } catch {
    console.error("series.json tidak ditemukan. Jalankan scrape penuh dulu.");
    process.exit(1);
  }

  let ok = 0;
  let failed = 0;
  for (let i = 0; i < series.length; i++) {
    const item = series[i];
    process.stdout.write(`→ [${i + 1}/${series.length}] ${item.slug} ... `);
    try {
      const { html, finalUrl } = await resolveDramaHtml(item.slug);
      const detail = extractDetailMeta(html, item);
      item.sinopsis = detail.sinopsis;
      if (detail.thumbnail) item.thumbnail = detail.thumbnail;
      if (finalUrl) item.source = finalUrl;
      ok += 1;
      console.log(`OK (${detail.sinopsis.length} char)`);
    } catch (err) {
      failed += 1;
      console.log(`GAGAL: ${err.message}`);
    }
    if (i < series.length - 1 && delay) await sleep(delay);
  }

  await writeFile(SERIES_FILE, JSON.stringify(series, null, 2) + "\n", "utf8");
  console.log(`\nSelesai refresh deskripsi: ${ok} OK, ${failed} gagal, ${series.length} total.`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  await mkdir(DATA_DIR, { recursive: true });

  if (opts.refreshDesc) {
    console.log(`Refresh deskripsi series (delay ${opts.delay}ms)\n`);
    await refreshDescriptions(opts);
    return;
  }

  console.log(
    `Scrape LK21 top-series-today: halaman ${opts.start}–${opts.start + opts.pages - 1}` +
      ` (delay ${opts.delay}ms` +
      `${opts.latestOnly ? ", latest-only" : ""}` +
      `${opts.maxEps ? `, max-eps ${opts.maxEps}` : ""})\n`
  );

  const listings = await scrapeListingPages(opts);
  if (!listings.length) {
    console.error("Tidak ada series ditemukan.");
    process.exit(1);
  }

  console.log(`\nAmbil detail ${listings.length} series...\n`);
  const { series, playersMap, withPlayers } = await scrapeDetails(listings, opts);

  await writeFile(SERIES_FILE, JSON.stringify(series, null, 2) + "\n", "utf8");
  await writeFile(
    SERIES_PLAYERS_FILE,
    JSON.stringify(playersMap, null, 2) + "\n",
    "utf8"
  );

  const epTotal = series.reduce((a, s) => a + (s.episodes?.length || 0), 0);
  const epWithPlayers = series.reduce(
    (a, s) => a + (s.episodes || []).filter((e) => e.players?.length).length,
    0
  );

  console.log(
    `\nSelesai.\n` +
      `  series.json         : ${series.length} series\n` +
      `  series-players.json : ${Object.keys(playersMap).length} entri\n` +
      `  series punya player : ${withPlayers}/${series.length}\n` +
      `  episode + player    : ${epWithPlayers}/${epTotal}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
