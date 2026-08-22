#!/usr/bin/env node
/**
 * Refresh URL player (P2P/Turbo/Cast/Hydrax) dari halaman LK21 untuk film katalog.
 * Default: tahun 2025–2026 di movies + horror + indonesia.
 *
 * Usage:
 *   node scripts/refresh-movie-players.js
 *   node scripts/refresh-movie-players.js --years 2025,2026
 *   node scripts/refresh-movie-players.js --slugs pinocchio-unstrung-2026,last-house-2026
 *   node scripts/refresh-movie-players.js --collections horror --years 2026 --delay 250
 *   node scripts/refresh-movie-players.js --limit 20
 */
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rewritePlayerUrl } from "./lib/player-host-aliases.js";
import {
  extractKconazPlayers,
  rewriteIndonesiaSourceUrl,
} from "./lib/kconaz-indonesia.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DATA_DIR = join(ROOT, "public", "data");
const BASE_URL = "https://tv12.lk21official.cc";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const COLLECTION_FILES = {
  movies: { items: "movies.json", players: "players.json", catalog: "movies" },
  horror: { items: "horror.json", players: "horror-players.json", catalog: "horror" },
  indonesia: {
    items: "indonesia.json",
    players: "indonesia-players.json",
    catalog: "indonesia",
  },
};

function parseArgs(argv) {
  const out = {
    years: [2025, 2026],
    collections: ["movies", "horror", "indonesia"],
    slugs: null,
    delay: 280,
    limit: 0,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--years" && next) {
      out.years = next.split(",").map((y) => Number(y.trim())).filter(Boolean);
      i += 1;
    } else if (a === "--collections" && next) {
      out.collections = next
        .split(",")
        .map((c) => c.trim().toLowerCase())
        .filter((c) => COLLECTION_FILES[c]);
      i += 1;
    } else if (a === "--slugs" && next) {
      out.slugs = new Set(
        next
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      );
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
  const scope = selectMatch ? selectMatch[1] : html;
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

function yearOf(item) {
  const y = String(item?.tahun || item?.year || "").match(/(\d{4})/);
  return y ? Number(y[1]) : 0;
}

function playersChanged(a, b) {
  const sa = JSON.stringify((a || []).map((p) => [p.server, p.url]));
  const sb = JSON.stringify((b || []).map((p) => [p.server, p.url]));
  return sa !== sb;
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function refreshCollection(name, opts) {
  const meta = COLLECTION_FILES[name];
  const itemsPath = join(DATA_DIR, meta.items);
  const playersPath = join(DATA_DIR, meta.players);
  const items = await readJson(itemsPath, []);
  const playersMap = await readJson(playersPath, {});
  if (!Array.isArray(items)) throw new Error(`${meta.items} bukan array`);

  let targets = items.filter((item) => {
    if (!item?.slug) return false;
    if (opts.slugs) return opts.slugs.has(item.slug);
    if (!item.source && !item.slug) return false;
    return opts.years.includes(yearOf(item));
  });

  // Dedup by slug (keep first)
  const seen = new Set();
  targets = targets.filter((item) => {
    if (seen.has(item.slug)) return false;
    seen.add(item.slug);
    return true;
  });

  if (opts.limit > 0) targets = targets.slice(0, opts.limit);

  console.log(`\n[${name}] target ${targets.length} film`);
  let ok = 0;
  let changed = 0;
  let failed = 0;

  for (let i = 0; i < targets.length; i += 1) {
    const item = targets[i];
    const source =
      name === "indonesia"
        ? rewriteIndonesiaSourceUrl(item.source, item.slug)
        : item.source ||
          `${BASE_URL}/${String(item.slug).replace(/^\/+|\/+$/g, "")}`;
    process.stdout.write(
      `  (${i + 1}/${targets.length}) ${item.slug} ... `
    );
    try {
      const html = await fetchHtml(source);
      const players =
        name === "indonesia" ? extractKconazPlayers(html) : extractPlayers(html);
      if (!players.length) {
        console.log("skip (0 player)");
        failed += 1;
      } else {
        const didChange = playersChanged(item.players, players);
        item.source = source;
        item.players = players;
        playersMap[item.slug] = {
          slug: item.slug,
          film: extractTitle(html) || item.judul || item.nama || item.slug,
          source,
          catalog: item.catalog || meta.catalog,
          scraped_at: new Date().toISOString(),
          players,
        };
        // Sync same slug across items array duplicates
        for (const other of items) {
          if (other?.slug === item.slug) {
            other.source = source;
            other.players = players;
          }
        }
        ok += 1;
        if (didChange) changed += 1;
        console.log(
          `${players.length} player${didChange ? " (updated)" : " (same)"}`
        );
      }
    } catch (err) {
      failed += 1;
      console.log(`fail: ${err.message}`);
    }
    if (opts.delay && i < targets.length - 1) await sleep(opts.delay);
  }

  await writeFile(itemsPath, JSON.stringify(items, null, 2) + "\n", "utf8");
  await writeFile(playersPath, JSON.stringify(playersMap, null, 2) + "\n", "utf8");
  console.log(
    `[${name}] done: ok=${ok} changed=${changed} failed=${failed} → ${meta.items}, ${meta.players}`
  );
  return { ok, changed, failed };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  console.log(
    `Refresh movie players years=${opts.years.join(",")} collections=${opts.collections.join(",")} delay=${opts.delay}ms`
  );
  const summary = {};
  for (const name of opts.collections) {
    summary[name] = await refreshCollection(name, opts);
  }
  console.log("\nRingkasan:", summary);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
