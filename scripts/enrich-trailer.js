/**
 * Enrich katalog dengan trailer_youtube (TMDB → YouTube key).
 * Hanya film/series (bukan anime). Cocok untuk hero carousel.
 *
 *   node scripts/enrich-trailer.js
 *   node scripts/enrich-trailer.js --limit 40
 *   node scripts/enrich-trailer.js --rating-min 7
 *   node scripts/enrich-trailer.js --force
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { extractYear } from "./lib/landscape-utils.js";
import { resolveTmdbTrailerKey } from "./lib/tmdb-landscape.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const CATALOGS = [
  { file: "movies.json", mediaType: "movie" },
  { file: "horror.json", mediaType: "movie" },
  { file: "indonesia.json", mediaType: "movie" },
  { file: "series.json", mediaType: "tv" },
];

function parseArgs(argv) {
  const out = {
    limit: 0,
    force: false,
    file: "",
    delay: 280,
    quiet: false,
    ratingMin: 0,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--limit" && argv[i + 1]) out.limit = Math.max(0, Number(argv[++i]) || 0);
    else if (a === "--file" && argv[i + 1]) out.file = String(argv[++i]).trim();
    else if (a === "--force") out.force = true;
    else if (a === "--delay" && argv[i + 1]) out.delay = Math.max(100, Number(argv[++i]) || 280);
    else if (a === "--quiet") out.quiet = true;
    else if (a === "--rating-min" && argv[i + 1]) {
      out.ratingMin = Math.max(0, Number(argv[++i]) || 0);
    }
  }
  return out;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function ratingValue(item) {
  const raw = String(item?.rating || "").trim();
  if (!raw) return 0;
  const n = Number(raw.replace(",", ".").replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

async function readJsonArray(file) {
  try {
    const raw = await readFile(file, "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/**
 * @param {string} rootDir
 * @param {object} options
 */
export async function enrichTrailerCatalog(rootDir = ROOT, options = {}) {
  const opts = { ...parseArgs([]), ...options };
  const apiKey = opts.apiKey || process.env.TMDB_API_KEY || "";
  if (!apiKey) {
    console.warn("[trailer] TMDB_API_KEY kosong — skip enrich trailer.");
    return { updated: 0, checked: 0, skipped: 0 };
  }

  const dataDir = join(rootDir, "public", "data");
  const catalogs = opts.file
    ? CATALOGS.filter((c) => c.file === opts.file)
    : CATALOGS;

  let updated = 0;
  let checked = 0;
  let skipped = 0;

  for (const cat of catalogs) {
    const filePath = join(dataDir, cat.file);
    const list = await readJsonArray(filePath);
    if (!list.length) continue;

    let budget = opts.limit > 0 ? opts.limit : Infinity;
    let fileUpdated = 0;

    // Prioritas: rating tinggi dulu (carousel)
    const ordered = [...list.keys()].sort(
      (a, b) => ratingValue(list[b]) - ratingValue(list[a])
    );

    for (const idx of ordered) {
      if (budget <= 0) break;
      const item = list[idx];
      if (!opts.force && item.trailer_youtube) {
        skipped++;
        continue;
      }
      if (opts.ratingMin > 0 && ratingValue(item) < opts.ratingMin) {
        skipped++;
        continue;
      }
      const title = item.judul || item.nama || "";
      if (!title) {
        skipped++;
        continue;
      }

      checked++;
      budget--;
      const key = await resolveTmdbTrailerKey({
        title,
        year: extractYear(item),
        mediaType: cat.mediaType,
        apiKey,
        requireBackdrop: false,
      });
      await sleep(opts.delay);

      if (!key) {
        if (!opts.quiet) {
          console.log(`[trailer] miss ${cat.file} ${item.slug || title}`);
        }
        continue;
      }
      item.trailer_youtube = key;
      fileUpdated++;
      updated++;
      if (!opts.quiet) {
        console.log(`[trailer] + ${item.slug || title} → ${key}`);
      }
    }

    if (fileUpdated > 0) {
      await writeFile(filePath, `${JSON.stringify(list, null, 2)}\n`, "utf8");
    }
  }

  console.log(
    `[trailer] done updated=${updated} checked=${checked} skipped=${skipped}`
  );
  return { updated, checked, skipped };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  await enrichTrailerCatalog(ROOT, opts);
}

const isDirectRun =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
