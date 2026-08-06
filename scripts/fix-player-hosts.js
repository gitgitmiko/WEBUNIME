#!/usr/bin/env node
/**
 * Rewrite host player lama → baru di seluruh public/data.
 * Alias: scripts/lib/player-host-aliases.js
 *
 *   npm run fix:player-hosts
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PLAYER_HOST_ALIASES,
  rewritePlayerHostsInCatalog,
} from "./lib/player-host-aliases.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = join(ROOT, "public", "data");

console.log("[fix:player-hosts] aliases:", PLAYER_HOST_ALIASES);
const summary = await rewritePlayerHostsInCatalog(dataDir, { readFile, writeFile });
console.log("[fix:player-hosts] rewritten urls:", summary.total);
console.log(JSON.stringify(summary.files, null, 2));
