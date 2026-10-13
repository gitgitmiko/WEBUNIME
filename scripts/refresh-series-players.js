#!/usr/bin/env node
/**
 * Refresh URL player episode series LK21 yang muncul di halaman terbaru.
 * Default: 5 halaman /latest-series.
 * Untuk tiap judul, player di-refresh pada season yang tertera di kartu
 * (misalnya S.3), supaya episode lama dari season sebelumnya tidak di-scrape ulang.
 *
 * Usage:
 *   node scripts/refresh-series-players.js
 *   node scripts/refresh-series-players.js --pages 5
 *   node scripts/refresh-series-players.js --slugs slo-pitch-2026
 *   node scripts/refresh-series-players.js --delay 250 --limit 10
 */
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rewritePlayerUrl } from "./lib/player-host-aliases.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DATA_DIR = join(ROOT, "public", "data");
const LIST_BASE = "https://tv12.lk21official.cc";
const DRAMA_BASE = "https://tv5.nontondrama.my";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

function parseArgs(argv) {
  const out = { pages: 5, slugs: null, delay: 280, limit: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--pages" && next) {
      out.pages = Math.max(1, Number(next) || 5);
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
      label: m.groups.label.replace(/<[^>]*>/g, "").trim(),
      url: rewritePlayerUrl(m.groups.url),
      default: /\bselected\b/i.test(m.groups.rest),
    });
  }
  return players;
}

function playersChanged(a, b) {
  const sig = (list) => JSON.stringify((list || []).map((p) => [p.server, p.url]));
  return sig(a) !== sig(b);
}

function listingUrl(page) {
  if (page <= 1) return `${LIST_BASE}/latest-series`;
  return `${LIST_BASE}/latest-series/page/${page}`;
}

function parseSeason(label) {
  const m = String(label || "").match(/S\.?\s*(\d+)/i);
  return m ? Number(m[1]) : 0;
}

function extractListingCards(html) {
  const cards = [];
  const re =
    /<article\b[^>]*itemtype=["']https?:\/\/schema\.org\/Movie["'][^>]*>([\s\S]*?)<\/article>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const block = m[0];
    const href =
      block.match(/itemprop=["']url["'][^>]*href=["']([^"']+)["']/i)?.[1] ||
      block.match(/href=["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    let slug = "";
    try {
      const parts = new URL(href, LIST_BASE).pathname.split("/").filter(Boolean);
      slug = decodeURIComponent(parts[parts.length - 1] || "");
    } catch {
      continue;
    }
    if (!slug || /^(latest|search|genre|year|page|top-series|nontondrama|latest-series)$/i.test(slug)) {
      continue;
    }
    const episode = Number(
      block.match(/class=["']episode[^"']*["'][^>]*>\s*EPS\s*<strong>(\d+)<\/strong>/i)?.[1] || 0
    );
    const season = parseSeason(
      block.match(/class=["']duration["'][^>]*>([^<]+)/i)?.[1] || ""
    );
    cards.push({ slug, episode, season });
  }
  return cards;
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { html: await res.text(), finalUrl: res.url };
}

async function collectTargets(opts) {
  if (opts.slugs) {
    return opts.slugs.map((slug) => ({ slug, seasons: new Set() }));
  }
  const bySlug = new Map();
  for (let page = 1; page <= opts.pages; page += 1) {
    const url = listingUrl(page);
    process.stdout.write(`[series] daftar ${url} ... `);
    try {
      const { html } = await fetchHtml(url);
      const cards = extractListingCards(html);
      for (const card of cards) {
        if (!bySlug.has(card.slug)) {
          bySlug.set(card.slug, { slug: card.slug, seasons: new Set() });
        }
        if (card.season) bySlug.get(card.slug).seasons.add(card.season);
      }
      console.log(`${cards.length} kartu`);
    } catch (err) {
      console.log(`gagal: ${err.message}`);
    }
    if (opts.delay && page < opts.pages) await sleep(opts.delay);
  }
  return [...bySlug.values()];
}

function episodesForTarget(series, target) {
  const episodes = series.episodes || [];
  if (!target.seasons || target.seasons.size === 0) return episodes;
  const picked = episodes.filter((ep) => target.seasons.has(Number(ep.season) || 0));
  return picked.length ? picked : episodes.filter((ep) => {
    const latest = Math.max(...episodes.map((row) => Number(row.season) || 0));
    return Number(ep.season) === latest;
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  console.log(
    `Refresh series players pages=${opts.pages} delay=${opts.delay}ms limit=${opts.limit || "none"}`
  );

  const itemsPath = join(DATA_DIR, "series.json");
  const playersPath = join(DATA_DIR, "series-players.json");
  const items = await readJson(itemsPath, []);
  const playersMap = await readJson(playersPath, {});
  if (!Array.isArray(items)) throw new Error("series.json bukan array");
  const bySlug = new Map(items.filter((item) => item?.slug).map((item) => [item.slug, item]));

  let targets = await collectTargets(opts);
  if (opts.limit > 0) targets = targets.slice(0, opts.limit);
  console.log(`[series] target ${targets.length} judul`);

  const summary = { ok: 0, changed: 0, episodes: 0, missing: 0, failed: 0 };

  for (let i = 0; i < targets.length; i += 1) {
    const target = targets[i];
    const series = bySlug.get(target.slug);
    process.stdout.write(`  (${i + 1}/${targets.length}) ${target.slug} ... `);
    if (!series) {
      summary.missing += 1;
      console.log("skip (tidak ada di katalog)");
      if (opts.delay && i < targets.length - 1) await sleep(opts.delay);
      continue;
    }
    const episodes = episodesForTarget(series, target);
    let changedEps = 0;
    let okEps = 0;
    let failedEps = 0;
    for (let e = 0; e < episodes.length; e += 1) {
      const ep = episodes[e];
      if (!ep?.slug) continue;
      const source = ep.source || `${DRAMA_BASE}/${ep.slug}`;
      try {
        const { html, finalUrl } = await fetchHtml(source);
        const players = extractPlayers(html);
        if (!players.length) {
          failedEps += 1;
          continue;
        }
        if (playersChanged(ep.players, players)) changedEps += 1;
        ep.source = finalUrl || source;
        ep.players = players;
        okEps += 1;
      } catch {
        failedEps += 1;
      }
      if (opts.delay && e < episodes.length - 1) await sleep(opts.delay);
    }
    const latest = [...(series.episodes || [])].reverse().find((ep) => ep.players?.length);
    if (latest?.players?.length) series.players = latest.players;
    playersMap[series.slug] = {
      slug: series.slug,
      film: series.judul,
      type: "series",
      source: series.source,
      scraped_at: new Date().toISOString(),
      episodes: (series.episodes || []).map((ep) => ({
        season: ep.season,
        episode: ep.episode,
        slug: ep.slug,
        players: ep.players,
      })),
    };
    summary.episodes += okEps;
    summary.failed += failedEps;
    if (okEps > 0) summary.ok += 1;
    if (changedEps > 0) summary.changed += 1;
    const seasonLabel = [...(target.seasons || [])].sort((a, b) => a - b).join(",") || "semua";
    console.log(
      `S.${seasonLabel} episode=${episodes.length} ok=${okEps} updated=${changedEps} failed=${failedEps}`
    );
    if (opts.delay && i < targets.length - 1) await sleep(opts.delay);
  }

  await writeFile(itemsPath, JSON.stringify(items, null, 2) + "\n", "utf8");
  await writeFile(playersPath, JSON.stringify(playersMap, null, 2) + "\n", "utf8");
  console.log(
    `[series] done: ok=${summary.ok} changed=${summary.changed} episodes=${summary.episodes} missing=${summary.missing} failed=${summary.failed}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});