#!/usr/bin/env node
/**
 * Scrape anime Samehadaku (Playwright — bypass CF via navigasi dari daftar).
 *
 * Cara pakai:
 *   node scripts/scrape-anime.js
 *   node scripts/scrape-anime.js --slug hell-mode-yarikomizuki-no-gamer-season-2
 *   node scripts/scrape-anime.js --pages 1 --headed
 *   node scripts/scrape-anime.js --limit 3
 *
 * Hasil: public/data/anime.json
 */

import { writeFile, mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chromium } from "playwright";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DATA_DIR = join(ROOT, "public", "data");
const ANIME_FILE = join(DATA_DIR, "anime.json");

const BASE = "https://v2.samehadaku.how";
const LIST_URL = `${BASE}/daftar-anime-2/?title&status&type&order=update`;

function parseArgs(argv) {
  const out = { pages: 1, delay: 400, slug: "", limit: 0, headed: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--pages" && argv[i + 1]) out.pages = Math.max(1, Number(argv[++i]) || 1);
    else if (a === "--delay" && argv[i + 1]) out.delay = Math.max(0, Number(argv[++i]) || 400);
    else if (a === "--slug" && argv[i + 1]) out.slug = String(argv[++i]).trim();
    else if (a === "--limit" && argv[i + 1]) out.limit = Math.max(0, Number(argv[++i]) || 0);
    else if (a === "--headed") out.headed = true;
  }
  return out;
}

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

function cleanTitle(title) {
  return decodeEntities(stripTags(title))
    .replace(/\s+Subtitle Indonesia.*$/i, "")
    .replace(/\s+Sub Indo.*$/i, "")
    .replace(/\s+–\s*Samehadaku.*$/i, "")
    .trim();
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

async function launchBrowser(headed) {
  const opts = {
    headless: !headed,
    args: ["--disable-blink-features=AutomationControlled"],
  };
  try {
    return await chromium.launch({ ...opts, channel: "chrome" });
  } catch {
    return await chromium.launch(opts);
  }
}

function extractListings(html) {
  const items = [];
  const re =
    /<div class=["']animpost[^"']*["'][\s\S]*?<a[^>]*href=["']([^"']+)["'][^>]*title=["']([^"']+)["'][\s\S]*?(?:<img[^>]+src=["']([^"']+)["'][^>]*>)?[\s\S]*?<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = m[1];
    if (!/\/anime\//i.test(href)) continue;
    const slug = slugFromUrl(href);
    if (!slug || items.some((x) => x.slug === slug)) continue;
    const classChunk = html.slice(Math.max(0, m.index - 400), m.index);
    const genres = [...classChunk.matchAll(/genre-([a-z0-9-]+)/gi)].map((g) =>
      g[1]
        .split("-")
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ")
        .replace(/\bIsekai\b/i, "Isekai")
    );
    const season = classChunk.match(/season-([a-z]+)-(\d{4})/i);
    items.push({
      slug,
      source: absUrl(href),
      title: cleanTitle(m[2]),
      thumbnail: m[3] ? absUrl(m[3]) : "",
      genre: [...new Set(genres)],
      tahun: season?.[2] || "",
      season_label: season ? `${season[1]} ${season[2]}` : "",
    });
  }
  // fallback simpler
  if (!items.length) {
    const simple = [
      ...html.matchAll(
        /href=["'](https?:\/\/[^"']*\/anime\/([^/"']+)\/?)["'][^>]*title=["']([^"']+)["']/gi
      ),
    ];
    for (const s of simple) {
      const slug = s[2];
      if (items.some((x) => x.slug === slug)) continue;
      items.push({
        slug,
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

function extractDetail(html, fallback = {}) {
  const h1 = cleanTitle(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || "");
  const thumb =
    html.match(/class=["']thumb["'][\s\S]*?<img[^>]+src=["']([^"']+)["']/i)?.[1] ||
    html.match(/property=["']og:image["'][^>]*content=["']([^"']+)["']/i)?.[1] ||
    fallback.thumbnail ||
    "";
  const rating =
    html.match(/itemprop=["']ratingValue["'][^>]*>([^<]+)/i)?.[1]?.trim() ||
    html.match(/>(\d+[.,]\d{2})<\/span>\s*\/\s*<i[^>]*>/i)?.[1]?.replace(",", ".") ||
    null;
  const votes =
    html.match(/itemprop=["']ratingCount["'][^>]*content=["']([^"']+)["']/i)?.[1] ||
    html.match(/ratingCount["'][^>]*>([^<]+)/i)?.[1]?.replace(/,/g, "") ||
    null;

  const genreBlock =
    html.match(/class=["']infoanime[\s\S]*?class=["']genre-info["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] ||
    html.match(/class=["']genre-info["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] ||
    "";
  const genreText = stripTags(genreBlock);
  const genresFromInfo =
    genreText.match(
      /Action|Adventure|Fantasy|Isekai|Reincarnation|Comedy|Drama|Romance|Horror|Sci-Fi|School|Shounen|Seinen|Supernatural|Historical|Mecha|Ecchi|Sports|Slice of Life|Gore|Samurai|Adult Cast|Gag Humor|Time Travel|Mahou Shoujo|Villainess|Urban Fantasy|Super Power|Team Sports/gi
    ) || [];

  const sinopsisRaw =
    html.match(/class=["']infox["'][^>]*>[\s\S]*?<p>([\s\S]*?)<\/p>/i)?.[1] ||
    html.match(/property=["']og:description["'][^>]*content=["']([^"']+)["']/i)?.[1] ||
    "";
  const sinopsis = decodeEntities(stripTags(sinopsisRaw));

  const related = [];
  const relatedBlock = html.match(/Tonton Juga\s*:?\s*<\/p>\s*<ul>([\s\S]*?)<\/ul>/i)?.[1] || "";
  const relRe = /<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let rm;
  while ((rm = relRe.exec(relatedBlock)) !== null) {
    related.push({
      title: cleanTitle(rm[2]),
      slug: slugFromUrl(rm[1]),
      source: absUrl(rm[1]),
    });
  }

  const episodes = [];
  // Label bisa angka, "Special", "Movie", dll.
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

  const genre =
    (genresFromInfo.length && [...new Set(genresFromInfo)]) ||
    (fallback.genre?.length && fallback.genre) ||
    [];

  return {
    judul: h1 || fallback.title || fallback.slug,
    thumbnail: absUrl(thumb),
    rating: rating ? String(rating).replace(",", ".") : null,
    votes: votes ? Number(String(votes).replace(/,/g, "")) : null,
    sinopsis: sinopsis || `Anime ${h1 || fallback.title}.`,
    genre,
    related,
    episodes,
  };
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
      server: label.replace(/\s+\d+p$/i, "").trim().toLowerCase().replace(/\s+/g, "-") || "server",
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
      // Harus dari konteks halaman (cookie CF) — page.request sering 403
      const body = await page.evaluate(async ({ post, nume, type }) => {
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
      }, { post: opt.post, nume: opt.nume, type: opt.type });

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
      console.warn(`    player ${opt.label}: ${err.message}`);
    }
  }
  return players;
}

async function scrapeAnimeDetail(page, item, { delay }) {
  process.stdout.write(`  detail ${item.slug} ... `);
  await page.goto(item.source, { waitUntil: "domcontentloaded", timeout: 120000 });
  const ok = await waitReady(page);
  if (!ok) throw new Error("Cloudflare timeout");
  await page.waitForTimeout(800);
  const html = await page.content();
  const detail = extractDetail(html, item);
  console.log(`${detail.episodes.length} eps`);

  for (let i = 0; i < detail.episodes.length; i++) {
    const ep = detail.episodes[i];
    process.stdout.write(`    ep ${ep.episode} ... `);
    await page.goto(ep.source, { waitUntil: "domcontentloaded", timeout: 120000 });
    await waitReady(page);
    await page.waitForTimeout(600);
    const epHtml = await page.content();
    ep.players = await resolvePlayers(page, epHtml);
    // prefer VIP / Wibufile 720 as top-level default later
    console.log(`${ep.players.length} server`);
    if (i < detail.episodes.length - 1 && delay) await sleep(delay);
  }

  const { nama } = (() => {
    const t = detail.judul;
    const m = t.match(/^(.*?)(?:\s*\((\d{4})\))?$/);
    return { nama: (m?.[1] || t).trim() };
  })();

  const latest = [...detail.episodes].reverse().find((e) => e.players?.length);
  const preferred =
    latest?.players?.find((p) => /vip/i.test(p.label)) ||
    latest?.players?.find((p) => /wibufile.*720/i.test(p.label)) ||
    latest?.players?.[0];

  return {
    type: "anime",
    source_site: "samehadaku",
    nama: nama || item.title,
    judul: detail.judul,
    tahun: item.tahun || detail.judul.match(/\b(20\d{2})\b/)?.[1] || "",
    thumbnail: detail.thumbnail || item.thumbnail,
    rating: detail.rating,
    votes: detail.votes,
    durasi: detail.episodes.length ? `${detail.episodes.length} eps` : "",
    episodes_count: detail.episodes.length,
    genre: detail.genre?.length ? detail.genre : item.genre || [],
    sinopsis: [
      detail.sinopsis,
      detail.related?.length
        ? `Tonton Juga:\n${detail.related.map((r) => r.title).join("\n")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
    related: detail.related || [],
    slug: item.slug,
    source: item.source,
    season_label: item.season_label || "",
    episodes: detail.episodes,
    players: preferred ? [preferred, ...(latest?.players || []).filter((p) => p !== preferred)] : [],
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  await mkdir(DATA_DIR, { recursive: true });

  console.log(
    `Scrape Samehadaku daftar-anime (pages=${opts.pages}` +
      `${opts.slug ? `, slug=${opts.slug}` : ""}` +
      `${opts.limit ? `, limit=${opts.limit}` : ""})\n`
  );

  const browser = await launchBrowser(opts.headed);
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
    // Warmup + listing page 1 (+ optional more pages)
    const bySlug = new Map();
    for (let p = 1; p <= opts.pages; p++) {
      const url =
        p <= 1 ? LIST_URL : `${BASE}/daftar-anime-2/page/${p}/?title&status&type&order=update`;
      process.stdout.write(`→ List ${p}/${opts.pages} ... `);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
      await waitReady(page);
      await page.waitForTimeout(1000);
      const html = await page.content();
      const items = extractListings(html);
      let added = 0;
      for (const item of items) {
        if (!bySlug.has(item.slug)) {
          bySlug.set(item.slug, item);
          added += 1;
        }
      }
      console.log(`${items.length} kartu, +${added} (total ${bySlug.size})`);
      if (p < opts.pages && opts.delay) await sleep(opts.delay);
    }

    let listings = [...bySlug.values()];
    if (opts.slug) {
      listings = listings.filter((x) => x.slug === opts.slug);
      if (!listings.length) {
        // paksa detail URL meski tidak di list
        listings = [
          {
            slug: opts.slug,
            source: `${BASE}/anime/${opts.slug}/`,
            title: opts.slug,
            thumbnail: "",
            genre: [],
            tahun: "",
            season_label: "",
          },
        ];
      }
    }
    if (opts.limit > 0) listings = listings.slice(0, opts.limit);

    // Default permulaan: utamakan Hell Mode S2 jika ada di list, tapi tetap scrape semua page 1
    // (tanpa --limit). User minta page 1 + Hell Mode sebagai contoh struktur.

    console.log(`\nAmbil detail ${listings.length} anime...\n`);
    const anime = [];
    for (let i = 0; i < listings.length; i++) {
      const item = listings[i];
      console.log(`→ [${i + 1}/${listings.length}] ${item.slug}`);
      try {
        const entry = await scrapeAnimeDetail(page, item, opts);
        entry.id = i + 1;
        anime.push(entry);
      } catch (err) {
        console.log(`  GAGAL: ${err.message}`);
      }
      if (i < listings.length - 1 && opts.delay) await sleep(opts.delay);
    }

    // Merge dengan data lama (jangan hapus)
    let existing = [];
    try {
      existing = JSON.parse(await readFile(ANIME_FILE, "utf8"));
      if (!Array.isArray(existing)) existing = [];
    } catch {
      existing = [];
    }
    const map = new Map(existing.map((a) => [a.slug, a]));
    for (const a of anime) map.set(a.slug, a);
    const merged = [...anime.map((a) => a.slug), ...existing.map((a) => a.slug)]
      .filter((s, idx, arr) => arr.indexOf(s) === idx)
      .map((slug, idx) => {
        const row = map.get(slug);
        return { ...row, id: idx + 1 };
      });

    await writeFile(ANIME_FILE, JSON.stringify(merged, null, 2) + "\n", "utf8");
    console.log(
      `\nSelesai. anime.json: ${merged.length} total (baru/diupdate: ${anime.length})`
    );
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
