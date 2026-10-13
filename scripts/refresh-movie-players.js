#!/usr/bin/env node
/**
 * Refresh URL player (P2P/Turbo/Cast/Hydrax) film LK21 yang muncul
 * di halaman terbaru. Default: 5 halaman /latest.
 *
 * Usage:
 *   node scripts/refresh-movie-players.js
 *   node scripts/refresh-movie-players.js --pages 5
 *   node scripts/refresh-movie-players.js --slugs pinocchio-unstrung-2026,last-house-2026
 *   node scripts/refresh-movie-players.js --delay 250 --limit 20
 */
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rewritePlayerUrl } from "./lib/player-host-aliases.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DATA_DIR = join(ROOT, "public", "data");
const BASE_URL = "https://tv12.lk21official.cc";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const COLLECTIONS = [
  { name: "movies", items: "movies.json", players: "players.json", catalog: "movies" },
  { name: "horror", items: "horror.json", players: "horror-players.json", catalog: "horror" },
];

function parseArgs(argv) {
  const out = { pages: 5, slugs: null, delay: 280, limit: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--pages" && next) {
      out.pages = Math.max(1, Number(next) || 5);
      i += 1;
    } else if ((a === "--years" || a === "--collections") && next) {
      i += 1;
    } else if (a === "--slugs" && next) {
      out.slugs = next.split(",").map((s) => s.trim()).filter(Boolean);
      i += 1;
    } else if (a === "--delay" && next) {
      out.delay = Math.max(0, Number(next) || 0);
      i += 1;
    } else if (a === "--limit" && next) {
      out.limit = Math.max(0, Number(next) || 0);
      i += 1;
    }
  }
  return out;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  const raw = (await readFile(file, "utf8")).replace(/^\uFEFF/, "");
  return JSON.parse(raw);
}

function extractPlayers(html) {
  const selectMatch = html.match(
    /<select[^>]*id=["']player-select["'][^>]*>([\s\S]*?)<\/select>/i
  );
  const scope = selectMatch ? selectMatch[1] : "";
  if (!scope) return [];
  const optionRe =
    /<option\s+value=["'](?<url>[^"']+)["']\s+data-server=["'](?<server>[^"']*)["'](?<rest>[^>]*)>(?<label>[\s\S]*?)<\/option>/gi;
  const players = [];
  let m;
  let no = 0;
  while ((m = optionRe.exec(scope)) !== null) {
    no += 1;
    players.push({
      no,
      server: m.groups.server,
      label: m.groups.label.replace(/<[^>]*>/g, "").trim(),
      url: rewritePlayerUrl(m.groups.url),
      default: /\bselected\b/i.test(m.groups.rest),
    });
  }
  return players;
}

function extractTitle(html) {
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) return h1[1].replace(/<[^>]*>/g, "").trim();
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return title ? title[1].replace(/\s*[-|].*$/, "").trim() : "";
}

function playersChanged(a, b) {
  const sig = (list) => JSON.stringify((list || []).map((p) => [p.server, p.url]));
  return sig(a) !== sig(b);
}

function listingUrl(page) {
  if (page <= 1) return `${BASE_URL}/latest`;
  return `${BASE_URL}/latest/page/${page}`;
}

function extractListingSlugs(html) {
  const slugs = [];
  const re =
    /<article\b[^>]*itemtype=["']https?:\/\/schema\.org\/Movie["'][^>]*>([\s\S]*?)<\/article>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const href =
      m[0].match(/itemprop=["']url["'][^>]*href=["']([^"']+)["']/i)?.[1] ||
      m[0].match(/href=["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    let slug = "";
    try {
      const parts = new URL(href, BASE_URL).pathname.split("/").filter(Boolean);
      slug = decodeURIComponent(parts[parts.length - 1] || "");
    } catch {
      continue;
    }
    if (!slug || /^(latest|search|genre|year|page|top-series|nontondrama|latest-series)$/i.test(slug)) {
      continue;
    }
    slugs.push(slug);
  }
  return slugs;
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function collectSlugs(opts) {
  if (opts.slugs) return opts.slugs;
  const slugs = [];
  const seen = new Set();
  for (let page = 1; page <= opts.pages; page += 1) {
    const url = listingUrl(page);
    process.stdout.write(`[movies] daftar ${url} ... `);
    try {
      const html = await fetchHtml(url);
      const pageSlugs = extractListingSlugs(html);
      let added = 0;
      for (const slug of pageSlugs) {
        if (seen.has(slug)) continue;
        seen.add(slug);
        slugs.push(slug);
        added += 1;
      }
      console.log(`${pageSlugs.length} kartu, ${added} baru`);
    } catch (err) {
      console.log(`gagal: ${err.message}`);
    }
    if (opts.delay && page < opts.pages) await sleep(opts.delay);
  }
  return slugs;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  console.log(
    `Refresh movie players pages=${opts.pages} delay=${opts.delay}ms limit=${opts.limit || "none"}`
  );

  const loaded = [];
  for (const meta of COLLECTIONS) {
    const items = await readJson(join(DATA_DIR, meta.items), []);
    const playersMap = await readJson(join(DATA_DIR, meta.players), {});
    if (!Array.isArray(items)) throw new Error(`${meta.items} bukan array`);
    loaded.push({ meta, items, playersMap, bySlug: new Map(items.filter((item) => item?.slug).map((item) => [item.slug, item])) });
  }

  let slugs = await collectSlugs(opts);
  if (opts.limit > 0) slugs = slugs.slice(0, opts.limit);
  console.log(`[movies] target ${slugs.length} film`);

  const summary = { ok: 0, changed: 0, missing: 0, failed: 0 };

  for (let i = 0; i < slugs.length; i += 1) {
    const slug = slugs[i];
    const hits = loaded.filter((col) => col.bySlug.has(slug));
    process.stdout.write(`  (${i + 1}/${slugs.length}) ${slug} ... `);
    if (!hits.length) {
      summary.missing += 1;
      console.log("skip (tidak ada di katalog)");
      continue;
    }
    const sample = hits[0].bySlug.get(slug);
    const source = sample.source || `${BASE_URL}/${slug}`;
    try {
      const html = await fetchHtml(source);
      const players = extractPlayers(html);
      if (!players.length) {
        summary.failed += 1;
        console.log("skip (0 player, URL lama dipertahankan)");
        continue;
      }
      const title = extractTitle(html) || sample.judul || sample.nama || slug;
      let didChange = false;
      for (const col of hits) {
        const item = col.bySlug.get(slug);
        if (playersChanged(item.players, players)) didChange = true;
        item.source = source;
        item.players = players;
        for (const other of col.items) {
          if (other?.slug === slug) {
            other.source = source;
            other.players = players;
          }
        }
        col.playersMap[slug] = {
          slug,
          film: title,
          source,
          catalog: item.catalog || col.meta.catalog,
          scraped_at: new Date().toISOString(),
          players,
        };
      }
      summary.ok += 1;
      if (didChange) summary.changed += 1;
      console.log(`${players.length} player${didChange ? " (updated)" : " (same)"}`);
    } catch (err) {
      summary.failed += 1;
      console.log(`fail: ${err.message}`);
    }
    if (opts.delay && i < slugs.length - 1) await sleep(opts.delay);
  }

  for (const col of loaded) {
    await writeFile(join(DATA_DIR, col.meta.items), JSON.stringify(col.items, null, 2) + "\n", "utf8");
    await writeFile(join(DATA_DIR, col.meta.players), JSON.stringify(col.playersMap, null, 2) + "\n", "utf8");
  }
  console.log(
    `[movies] done: ok=${summary.ok} changed=${summary.changed} missing=${summary.missing} failed=${summary.failed}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});