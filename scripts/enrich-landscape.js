/**
 * Enrich katalog dengan thumbnail_landscape.
 * Urutan: TMDB backdrop → gambar lebar dari HTML detail situs.
 *
 *   node scripts/enrich-landscape.js
 *   node scripts/enrich-landscape.js --limit 20
 *   node scripts/enrich-landscape.js --slug oppenheimer-2023
 *   node scripts/enrich-landscape.js --force
 *   node scripts/enrich-landscape.js --file movies.json
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  extractSiteLandscape,
  hasValidLandscape,
  rewriteDeadPosterHost,
} from "./lib/landscape-utils.js";
import { resolveTmdbLandscape } from "./lib/tmdb-landscape.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DATA_DIR = join(ROOT, "public", "data");

const CATALOGS = [
  { file: "movies.json", mediaType: "movie" },
  { file: "horror.json", mediaType: "movie" },
  { file: "series.json", mediaType: "tv" },
  { file: "anime.json", mediaType: "anime" },
  { file: "anime-movies.json", mediaType: "anime-movie" },
];

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

function parseArgs(argv) {
  const out = {
    limit: 0,
    slug: "",
    force: false,
    file: "",
    delay: 350,
    quiet: false,
    refetchSite: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--limit" && argv[i + 1]) out.limit = Math.max(0, Number(argv[++i]) || 0);
    else if (a === "--slug" && argv[i + 1]) out.slug = String(argv[++i]).trim();
    else if (a === "--file" && argv[i + 1]) out.file = String(argv[++i]).trim();
    else if (a === "--force") out.force = true;
    else if (a === "--delay" && argv[i + 1]) out.delay = Math.max(100, Number(argv[++i]) || 350);
    else if (a === "--quiet") out.quiet = true;
    else if (a === "--no-site") out.refetchSite = false;
  }
  return out;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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

async function urlLooksAlive(url) {
  try {
    const res = await fetch(url, {
      method: "HEAD",
      headers: { "User-Agent": USER_AGENT },
      redirect: "follow",
    });
    if (res.ok) return true;
    // Beberapa CDN tolak HEAD — coba GET range kecil
    if (res.status === 403 || res.status === 405) {
      const get = await fetch(url, {
        method: "GET",
        headers: { "User-Agent": USER_AGENT, Range: "bytes=0-0" },
        redirect: "follow",
      });
      return get.ok || get.status === 206;
    }
    return false;
  } catch {
    return false;
  }
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "id-ID,id;q=0.9,en;q=0.8",
    },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function resolveSiteFromSource(item) {
  const src = item.source || item.list_source;
  if (!src || !/^https?:\/\//i.test(src)) return null;
  try {
    const html = await fetchHtml(src);
    return extractSiteLandscape(html, {
      portraitUrl: item.thumbnail,
      base: src,
    });
  } catch {
    return null;
  }
}

/**
 * @param {string} rootDir
 * @param {{ limit?: number, slug?: string, force?: boolean, file?: string, delay?: number, quiet?: boolean, refetchSite?: boolean, apiKey?: string }} [options]
 */
export async function enrichLandscapeCatalog(rootDir, options = {}) {
  const dataDir = join(rootDir, "public", "data");
  const force = Boolean(options.force);
  const slugFilter = options.slug || "";
  const fileFilter = options.file || "";
  const delay = options.delay ?? 350;
  const quiet = Boolean(options.quiet);
  const refetchSite = options.refetchSite !== false;
  const apiKey = options.apiKey || process.env.TMDB_API_KEY || "";
  let remaining = options.limit > 0 ? options.limit : Infinity;

  if (!apiKey && !quiet) {
    console.warn(
      "[landscape] TMDB_API_KEY kosong — hanya gambar lebar dari situs (bila ada)."
    );
  }

  const catalogs = CATALOGS.filter((c) => !fileFilter || c.file === fileFilter);
  const summary = {
    filled: 0,
    skipped: 0,
    miss: 0,
    files: {},
  };

  for (const cat of catalogs) {
    if (remaining <= 0) break;
    const path = join(dataDir, cat.file);
    const list = await readJsonArray(path);
    let changed = false;
    let filledFile = 0;
    let missFile = 0;
    let skippedFile = 0;

    const pending = [];
    for (const item of list) {
      if (slugFilter && item.slug !== slugFilter) continue;
      if (!force && hasValidLandscape(item)) {
        skippedFile += 1;
        continue;
      }
      pending.push(item);
    }

    const batch = pending.slice(0, remaining === Infinity ? pending.length : remaining);
    if (!quiet) {
      console.log(
        `[landscape] ${cat.file}: ${batch.length}/${pending.length} pending (force=${force})`
      );
    }

    for (let i = 0; i < batch.length; i++) {
      const item = batch[i];
      if (!quiet) {
        process.stdout.write(`  [${i + 1}/${batch.length}] ${item.slug || item.nama} ... `);
      }
      try {
        let url = await resolveTmdbLandscape({
          title: item.judul || item.nama,
          year: String(item.tahun || "").match(/\b(19|20)\d{2}\b/)?.[0] || "",
          mediaType: cat.mediaType,
          apiKey,
        });
        if (!url && refetchSite) {
          url = await resolveSiteFromSource(item);
        }
        if (url) {
          url = rewriteDeadPosterHost(url);
          // Validasi non-TMDB (CDN situs sering 404)
          if (!/image\.tmdb\.org/i.test(url) && !(await urlLooksAlive(url))) {
            url = null;
          }
        }
        if (url) {
          item.thumbnail_landscape = url;
          filledFile += 1;
          summary.filled += 1;
          changed = true;
          if (!quiet) console.log(url.slice(0, 72));
        } else {
          if (item.thumbnail_landscape) {
            delete item.thumbnail_landscape;
            changed = true;
          }
          missFile += 1;
          summary.miss += 1;
          if (!quiet) console.log("miss");
        }
      } catch (err) {
        missFile += 1;
        summary.miss += 1;
        if (!quiet) console.log(`err: ${err.message}`);
      }
      remaining -= 1;
      if (i < batch.length - 1 && delay) await sleep(delay);
    }

    summary.skipped += skippedFile;
    summary.files[cat.file] = {
      filled: filledFile,
      miss: missFile,
      skipped: skippedFile,
      pending: pending.length,
    };

    if (changed) {
      await writeFile(path, JSON.stringify(list, null, 2) + "\n", "utf8");
    }
  }

  if (!quiet) {
    console.log(
      `\n[landscape] selesai: filled=${summary.filled} miss=${summary.miss} skipped=${summary.skipped}`
    );
  }
  return summary;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  await enrichLandscapeCatalog(ROOT, opts);
}

const isDirectRun =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
