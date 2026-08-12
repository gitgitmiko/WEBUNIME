import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPool } from "./db.js";
import { DOC_NAMES, ITEM_COLLECTIONS } from "./catalog-meta.js";
import { putDoc, replaceCollection } from "./catalog.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(__dirname, "../public/data");

async function ensureSchema() {
  const sqlPath = path.join(__dirname, "sql/catalog.sql");
  const sql = fs.readFileSync(sqlPath, "utf8");
  const pool = getPool();
  for (const stmt of sql.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) {
    await pool.query(stmt);
  }
}

async function importFile(name, kind) {
  const file = path.join(dataDir, `${name}.json`);
  if (!fs.existsSync(file)) {
    console.warn(`skip missing ${file}`);
    return null;
  }
  const raw = fs.readFileSync(file, "utf8");
  const data = JSON.parse(raw);
  if (kind === "items") {
    if (!Array.isArray(data)) throw new Error(`${name}.json harus array`);
    const r = await replaceCollection(name, data);
    console.log(`OK items ${name}: ${r.count}`);
    return r;
  }
  const r = await putDoc(name, data);
  console.log(`OK doc ${name}`);
  return r;
}

async function main() {
  await ensureSchema();
  for (const name of ITEM_COLLECTIONS) {
    await importFile(name, "items");
  }
  for (const name of DOC_NAMES) {
    await importFile(name, "doc");
  }
  console.log("Import selesai.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
