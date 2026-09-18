#!/usr/bin/env node
/**
 * Salin URL player yang sudah di-resolve (players.json) ke item katalog
 * (movies/horror/indonesia/…). UI web membaca players dari catalog_items,
 * bukan dari dokumen players.
 *
 *   node scripts/sync-resolved-players-into-catalog.js
 */
import { readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DATA = join(ROOT, "public/data");

const CATALOG_FILES = [
  "movies.json",
  "horror.json",
  "indonesia.json",
  "series.json",
];

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function looksResolved(url) {
  return /emturbovid|turbovidhls|abyssplayer|abyss\.to|short\.icu|gn1r5n|mfw09|playcdn\.de|p2pplay|barplay/i.test(
    String(url || ""),
  );
}

function mergePlayers(itemPlayers, resolvedPlayers) {
  if (!Array.isArray(resolvedPlayers) || !resolvedPlayers.length) return null;
  if (!Array.isArray(itemPlayers) || !itemPlayers.length) {
    return resolvedPlayers.map((p) => ({ ...p }));
  }
  const byServer = new Map();
  for (const p of resolvedPlayers) {
    const key = String(p.server || "").toLowerCase();
    if (key) byServer.set(key, p);
  }
  let changed = false;
  const next = itemPlayers.map((p) => {
    const key = String(p.server || "").toLowerCase();
    const hit = byServer.get(key);
    if (!hit?.url) return p;
    if (p.url === hit.url && p.resolved_from === hit.resolved_from) return p;
    // Hanya timpa jika sumber sudah resolved / item masih iframe3
    if (!looksResolved(hit.url) && !/iframe3/i.test(String(p.url || ""))) {
      return p;
    }
    if (!looksResolved(hit.url) && !hit.resolved_from) return p;
    changed = true;
    return {
      ...p,
      url: hit.url,
      resolved_from: hit.resolved_from || p.resolved_from,
      label: hit.label || p.label,
      default: hit.default ?? p.default,
    };
  });
  return changed ? next : null;
}

async function main() {
  const playersDoc = await readJson(join(DATA, "players.json"));
  const map = Array.isArray(playersDoc)
    ? Object.fromEntries(playersDoc.map((e) => [e.slug, e]))
    : playersDoc;

  const summary = {};
  for (const file of CATALOG_FILES) {
    const path = join(DATA, file);
    let items;
    try {
      items = await readJson(path);
    } catch {
      summary[file] = { skip: true };
      continue;
    }
    if (!Array.isArray(items)) {
      summary[file] = { skip: true, reason: "not-array" };
      continue;
    }
    let updated = 0;
    for (const item of items) {
      const slug = item?.slug;
      if (!slug) continue;
      const entry = map[slug];
      const merged = mergePlayers(item.players, entry?.players);
      if (merged) {
        item.players = merged;
        updated++;
      }
    }
    if (updated) {
      await writeFile(path, JSON.stringify(items, null, 2) + "\n", "utf8");
    }
    summary[file] = { total: items.length, updated };
  }
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
