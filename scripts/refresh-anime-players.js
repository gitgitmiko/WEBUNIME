#!/usr/bin/env node
/**
 * Refresh player episode anime yang masih sparse (<6 / hanya 480p).
 *
 *   node scripts/refresh-anime-players.js
 *   node scripts/refresh-anime-players.js --limit 15
 */

import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { refreshSparseAnimePlayers } from "./lib/samehadaku-sync.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = join(ROOT, "public", "data");

function parseArgs(argv) {
  let limit = Number(process.env.ANIME_PLAYER_REFRESH_LIMIT || 30) || 30;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--limit" && argv[i + 1]) {
      limit = Math.max(0, Number(argv[++i]) || 0);
    }
  }
  return { limit };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  console.log(`[refresh-anime-players] limit=${opts.limit}`);
  const result = await refreshSparseAnimePlayers(DATA_DIR, opts);
  console.log(JSON.stringify(result, null, 2));
}

const isDirectRun =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
