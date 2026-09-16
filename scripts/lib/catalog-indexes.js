/**
 * Index ringan untuk app TV + Mobile: tanpa episodes/players.
 * Browse Anime/Series cukup ~1–2 MB, bukan puluhan MB.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const INDEX_SPECS = [
  { full: "anime.json", index: "anime-index.json" },
  { full: "series.json", index: "series-index.json" },
];

/** Index khusus app HP (folder mobile/). */
const MOBILE_INDEX_SPECS = [
  { full: "anime.json", index: "anime-index.json" },
];

/** Field yang dibuang dari index (berat / tidak perlu di baris browse). */
const DROP_KEYS = new Set(["episodes", "players", "related"]);

function toIndexItem(item) {
  if (!item || typeof item !== "object") return null;
  const out = {};
  for (const [k, v] of Object.entries(item)) {
    if (DROP_KEYS.has(k)) continue;
    out[k] = v;
  }
  // Pertahankan jumlah episode untuk badge, tanpa list episode.
  if (item.episodes_count == null && Array.isArray(item.episodes)) {
    out.episodes_count = item.episodes.length;
  }
  return out;
}

async function writeIndexPair(dir, full, index) {
  const src = join(dir, full);
  let list = [];
  try {
    const raw = JSON.parse(await readFile(src, "utf8"));
    list = Array.isArray(raw) ? raw : [];
  } catch {
    list = [];
  }
  const indexed = list.map(toIndexItem).filter(Boolean);
  const dest = join(dir, index);
  await writeFile(dest, JSON.stringify(indexed, null, 2) + "\n", "utf8");
  return { file: index, count: indexed.length, dir };
}

export async function writeCatalogIndexes(dataDir) {
  const results = [];
  for (const { full, index } of INDEX_SPECS) {
    results.push(await writeIndexPair(dataDir, full, index));
  }
  const mobileDir = join(dataDir, "mobile");
  for (const { full, index } of MOBILE_INDEX_SPECS) {
    try {
      const row = await writeIndexPair(mobileDir, full, index);
      results.push({ file: `mobile/${row.file}`, count: row.count });
    } catch (err) {
      results.push({ file: `mobile/${index}`, count: 0, error: String(err?.message || err) });
    }
  }
  return results;
}
