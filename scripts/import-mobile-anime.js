/**
 * Remigrasi koleksi anime dari public/data/mobile → MySQL.
 * Menghapus isi koleksi lama lalu insert ulang (replaceCollection).
 *
 *   node scripts/import-mobile-anime.js
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { putDoc, replaceCollection } from "../server/catalog.js";
import { getPool } from "../server/db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mobileDir = path.resolve(__dirname, "../public/data/mobile");

const ITEM_NAMES = ["anime", "anime-movies", "anime-latest"];
const DOC_NAMES = ["anime-schedule"];

function readJson(name) {
  const file = path.join(mobileDir, `${name}.json`);
  if (!fs.existsSync(file)) throw new Error(`Missing ${file}`);
  const raw = fs.readFileSync(file, "utf8");
  return JSON.parse(raw);
}

async function main() {
  console.log(`[import-mobile] source=${mobileDir}`);

  for (const name of ITEM_NAMES) {
    const items = readJson(name);
    if (!Array.isArray(items)) throw new Error(`${name}.json harus array`);
    console.log(`[import-mobile] replace ${name} (${items.length} items)...`);
    const t0 = Date.now();
    const r = await replaceCollection(name, items);
    console.log(`[import-mobile] OK ${name}: ${r.count} in ${Date.now() - t0}ms`);
  }

  for (const name of DOC_NAMES) {
    const payload = readJson(name);
    console.log(`[import-mobile] put doc ${name}...`);
    const r = await putDoc(name, payload);
    console.log(`[import-mobile] OK doc ${name}`, r);
  }

  const pool = getPool();
  const [rows] = await pool.execute(
    `SELECT collection, COUNT(*) AS c,
            ROUND(SUM(LENGTH(payload))/1024/1024, 2) AS mb
     FROM catalog_items
     WHERE collection IN ('anime','anime-movies','anime-latest')
     GROUP BY collection
     ORDER BY collection`,
  );
  console.log("[import-mobile] DB now:", rows);
  await pool.end();
  console.log("[import-mobile] selesai.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
