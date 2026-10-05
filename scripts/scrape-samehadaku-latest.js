#!/usr/bin/env node
/**
 * Samehadaku terbaru (TV + mobile): anime-terbaru, anime-movie, jadwal rilis.
 *   npm run scrape:samehadaku
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { syncSamehadakuCatalog } from "./lib/samehadaku-sync.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = join(ROOT, "public", "data");
const mobileDir = join(dataDir, "mobile");

try {
  const result = await syncSamehadakuCatalog(dataDir, [mobileDir]);
  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  console.error("[scrape:samehadaku]", err);
  process.exit(1);
}
