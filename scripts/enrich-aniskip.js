/**
 * Enrich anime.json dengan interval OP/ED dari AniSkip
 * (MAL id di-resolve lewat AniList GraphQL).
 *
 * Hasil disimpan di tiap episode:
 *   "skip": { "op": { "start": 3.2, "end": 93.2 }, "ed": { "start": 1417, "end": 1507 } }
 * dan di root anime: "mal_id": 52991
 *
 * Cara pakai:
 *   node scripts/enrich-aniskip.js
 *   node scripts/enrich-aniskip.js --limit 5
 *   node scripts/enrich-aniskip.js --slug solo-leveling-season-2-arise-from-the-shadow
 *   node scripts/enrich-aniskip.js --force   # tulis ulang yang sudah ada
 *   node scripts/enrich-aniskip.js --max-eps 24
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DATA_DIR = join(ROOT, "public", "data");
const ANIME_FILE = join(DATA_DIR, "anime.json");

const ANILIST = "https://graphql.anilist.co";
const ANISKIP = "https://api.aniskip.com/v2/skip-times";
const UA = "WEBUNIME-enrich-aniskip/1.0";

function parseArgs(argv) {
  const out = {
    limit: 0,
    slug: "",
    force: false,
    maxEps: 0,
    delayMal: 750,
    delaySkip: 250,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--limit" && argv[i + 1]) out.limit = Math.max(0, Number(argv[++i]) || 0);
    else if (a === "--slug" && argv[i + 1]) out.slug = String(argv[++i]).trim();
    else if (a === "--force") out.force = true;
    else if (a === "--max-eps" && argv[i + 1]) out.maxEps = Math.max(0, Number(argv[++i]) || 0);
    else if (a === "--delay-mal" && argv[i + 1]) out.delayMal = Math.max(200, Number(argv[++i]) || 750);
    else if (a === "--delay-skip" && argv[i + 1])
      out.delaySkip = Math.max(50, Number(argv[++i]) || 250);
  }
  return out;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function cleanSearchTitle(raw) {
  return String(raw || "")
    .replace(/\s*\(\d{4}\)\s*$/g, "")
    .replace(/\s+Subtitle Indonesia.*$/i, "")
    .replace(/\s+Sub Indo.*$/i, "")
    .replace(/\s+–\s*Samehadaku.*$/i, "")
    .trim();
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

async function resolveMalId(title) {
  const q = cleanSearchTitle(title);
  if (q.length < 2) return null;
  const body = {
    query: `query ($s: String) {
      Page(page: 1, perPage: 8) {
        media(search: $s, type: ANIME) {
          idMal
          title { romaji english native }
          synonyms
        }
      }
    }`,
    variables: { s: q },
  };
  const res = await fetch(ANILIST, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": UA,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`AniList HTTP ${res.status}`);
  const json = await res.json();
  const media = json?.data?.Page?.media || [];
  let best = null;
  let bestScore = -1;
  for (const m of media) {
    const idMal = Number(m.idMal) || 0;
    if (!idMal) continue;
    const titles = [
      m.title?.romaji,
      m.title?.english,
      m.title?.native,
      ...(Array.isArray(m.synonyms) ? m.synonyms : []),
    ].filter(Boolean);
    const score = Math.max(...titles.map((t) => scoreTitle(q, t)), 0);
    if (score > bestScore) {
      bestScore = score;
      best = idMal;
    }
  }
  return bestScore >= 40 ? best : media[0]?.idMal ? Number(media[0].idMal) : null;
}

async function fetchSkipTimes(malId, episode) {
  const url = `${ANISKIP}/${malId}/${episode}?types=op&types=ed&types=mixed-op&types=mixed-ed&episodeLength=0`;
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`AniSkip HTTP ${res.status}`);
  const json = await res.json();
  if (!json?.found || !Array.isArray(json.results) || !json.results.length) return null;
  let op = null;
  let ed = null;
  for (const row of json.results) {
    const start = Number(row?.interval?.startTime);
    const end = Number(row?.interval?.endTime);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const seg = {
      start: Math.round(start * 1000) / 1000,
      end: Math.round(end * 1000) / 1000,
    };
    if ((row.skipType === "op" || row.skipType === "mixed-op") && !op) op = seg;
    if ((row.skipType === "ed" || row.skipType === "mixed-ed") && !ed) ed = seg;
  }
  if (!op && !ed) return null;
  return { op: op || undefined, ed: ed || undefined, source: "aniskip" };
}

function episodeNeedsSkip(ep, force) {
  if (force) return true;
  const s = ep?.skip;
  if (!s) return true;
  return !(s.op?.end || s.ed?.start);
}

async function enrichAnime(anime, opts) {
  const title = anime.nama || anime.judul || anime.slug || "";
  let malId = Number(anime.mal_id) || 0;
  if (!malId) {
    malId = (await resolveMalId(title)) || 0;
    await sleep(opts.delayMal);
  }
  if (!malId) {
    return { anime, mal: false, filled: 0, skipped: 0, miss: 0 };
  }

  const episodes = Array.isArray(anime.episodes) ? [...anime.episodes] : [];
  let list = episodes;
  if (opts.maxEps > 0 && list.length > opts.maxEps) {
    // prioritaskan episode terbaru (biasanya di akhir array Samehadaku)
    list = list.slice(-opts.maxEps);
  }

  let filled = 0;
  let skipped = 0;
  let miss = 0;
  const byKey = new Map(
    episodes.map((ep, idx) => [`${ep.season || 0}:${ep.episode || idx}`, { ep, idx }]),
  );

  for (const ep of list) {
    const epNum = Number(ep.episode);
    if (!Number.isFinite(epNum) || epNum <= 0) {
      skipped += 1;
      continue;
    }
    if (!episodeNeedsSkip(ep, opts.force)) {
      skipped += 1;
      continue;
    }
    try {
      const skip = await fetchSkipTimes(malId, epNum);
      await sleep(opts.delaySkip);
      const key = `${ep.season || 0}:${ep.episode || 0}`;
      const slot = byKey.get(key);
      if (!slot) continue;
      if (skip) {
        episodes[slot.idx] = { ...slot.ep, skip };
        filled += 1;
      } else {
        miss += 1;
      }
    } catch (err) {
      miss += 1;
      process.stdout.write(`  ! ep ${epNum}: ${err.message}\n`);
      await sleep(opts.delaySkip);
    }
  }

  return {
    anime: { ...anime, mal_id: malId, episodes },
    mal: true,
    filled,
    skipped,
    miss,
  };
}

async function enrichAnimeCatalog(rootDir, opts = {}) {
  const options = {
    limit: 0,
    slug: "",
    force: false,
    maxEps: 0,
    delayMal: 750,
    delaySkip: 250,
    quiet: false,
    ...opts,
  };
  const dataDir = join(rootDir, "public", "data");
  const animeFile = join(dataDir, "anime.json");
  await mkdir(dataDir, { recursive: true });

  const full = JSON.parse(await readFile(animeFile, "utf8"));
  if (!Array.isArray(full)) throw new Error("anime.json bukan array");

  let list = full;
  if (options.slug) list = list.filter((a) => a.slug === options.slug);
  if (options.limit > 0) list = list.slice(0, options.limit);

  if (!options.quiet) {
    console.log(
      `Enrich AniSkip: ${list.length} anime (force=${options.force}, maxEps=${options.maxEps || "all"})\n`,
    );
  }

  const bySlug = new Map(full.map((a) => [a.slug, a]));
  let totalFilled = 0;
  let totalMiss = 0;
  let noMal = 0;

  const persist = async () => {
    const merged = full.map((a) => bySlug.get(a.slug) || a);
    for (const [slug, row] of bySlug) {
      if (!merged.some((a) => a.slug === slug)) merged.push(row);
    }
    await writeFile(animeFile, JSON.stringify(merged, null, 2) + "\n", "utf8");
  };

  for (let i = 0; i < list.length; i++) {
    const anime = bySlug.get(list[i].slug) || list[i];
    if (!options.quiet) {
      process.stdout.write(`[${i + 1}/${list.length}] ${anime.slug || anime.nama} ... `);
    }
    try {
      const result = await enrichAnime(anime, options);
      bySlug.set(result.anime.slug, result.anime);
      totalFilled += result.filled;
      totalMiss += result.miss;
      if (!result.mal) {
        noMal += 1;
        if (!options.quiet) console.log("MAL tidak ketemu");
      } else if (!options.quiet) {
        console.log(
          `MAL ${result.anime.mal_id} · +${result.filled} skip · skip-ada ${result.skipped} · kosong ${result.miss}`,
        );
      }
    } catch (err) {
      if (!options.quiet) console.log(`GAGAL: ${err.message}`);
    }

    if ((i + 1) % 5 === 0 || i === list.length - 1) {
      await persist();
    }
  }

  if (!options.quiet) {
    console.log(
      `\nSelesai. Episode terisi skip: ${totalFilled}, tanpa data AniSkip: ${totalMiss}, tanpa MAL: ${noMal}`,
    );
    console.log(`File: ${animeFile}`);
  }

  return {
    anime: list.length,
    filled: totalFilled,
    miss: totalMiss,
    no_mal: noMal,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  await enrichAnimeCatalog(ROOT, opts);
}

export { enrichAnimeCatalog };

const isDirectRun =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}