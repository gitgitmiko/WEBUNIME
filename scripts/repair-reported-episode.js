#!/usr/bin/env node
/**
 * Scrape ulang episode dari laporan player.
 *
 *   node scripts/repair-reported-episode.js --slug solo-leveling --episode 12
 *   node scripts/repair-reported-episode.js --queue ../scraper/queue/repair-queue.json
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  repairAnimeEpisode,
  repairAnimeEpisodeBatch,
} from "./lib/samehadaku-sync.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TV_DIR = join(ROOT, "public", "data");
const MOBILE_DIR = join(TV_DIR, "mobile");

function parseArgs(argv) {
  const out = { slug: "", episode: "", queue: "", limit: 40 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--slug" && argv[i + 1]) out.slug = String(argv[++i]).trim();
    else if (argv[i] === "--episode" && argv[i + 1]) out.episode = String(argv[++i]).trim();
    else if (argv[i] === "--queue" && argv[i + 1]) out.queue = String(argv[++i]).trim();
    else if (argv[i] === "--limit" && argv[i + 1]) out.limit = Math.max(1, Number(argv[++i]) || 40);
  }
  return out;
}

function emptyQueue() {
  return { updatedAt: new Date().toISOString(), items: [] };
}

async function readQueue(file) {
  try {
    const data = JSON.parse(await readFile(file, "utf8"));
    const items = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [];
    return { ...emptyQueue(), ...data, items };
  } catch {
    return emptyQueue();
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dirs = [TV_DIR, MOBILE_DIR];

  if (opts.queue) {
    const queue = await readQueue(opts.queue);
    console.log(`[repair] queue=${opts.queue} items=${queue.items.length} limit=${opts.limit}`);
    const result = await repairAnimeEpisodeBatch(dirs, queue.items, { limit: opts.limit });
    const remain = [
      ...(result.failed || []).map((row) => ({
        slug: row.slug,
        episode: String(row.episode),
        reason: "retry",
        reports: 1,
        lastAt: new Date().toISOString(),
      })),
      ...(result.leftover || []),
    ];
    await writeFile(
      opts.queue,
      JSON.stringify({ updatedAt: new Date().toISOString(), items: remain }, null, 2) + "\n",
      "utf8",
    );
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (!opts.slug || !opts.episode) {
    console.error(
      "Usage:\n  node scripts/repair-reported-episode.js --slug <slug> --episode <n>\n  node scripts/repair-reported-episode.js --queue <file>",
    );
    process.exit(1);
  }
  console.log(`[repair] slug=${opts.slug} episode=${opts.episode}`);
  const result = await repairAnimeEpisode(dirs, opts);
  console.log(JSON.stringify(result, null, 2));
  if (!result.updated) process.exit(2);
}

const isDirectRun =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
