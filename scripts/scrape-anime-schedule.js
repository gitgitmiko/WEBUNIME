#!/usr/bin/env node
/**
 * Scrape jadwal rilis Samehadaku → public/data/anime-schedule.json
 *
 *   npm run scrape:anime-schedule
 *
 * Sumber: https://v2.samehadaku.how/jadwal-rilis/
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { scrapeAnimeScheduleOnly } from "./lib/samehadaku-sync.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DATA_DIR = join(ROOT, "public", "data");

const result = await scrapeAnimeScheduleOnly(DATA_DIR);
console.log(
  `[scrape:anime-schedule] selesai: ${result.items} item / ${result.days} hari`
);
if (result.error) {
  console.error("[scrape:anime-schedule] error:", result.error);
  process.exit(1);
}
