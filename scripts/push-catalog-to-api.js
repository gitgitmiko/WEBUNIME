import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const dataDir = path.join(root, "public", "data");

const ITEM_COLLECTIONS = [
  "movies",
  "series",
  "horror",
  "indonesia",
  "anime",
  "anime-movies",
  "anime-latest",
  "series-latest",
];
const DOC_NAMES = [
  "anime-schedule",
  "sync-status",
  "players",
  "series-players",
  "horror-players",
  "indonesia-players",
];

const apiBase = (process.env.CATALOG_API_BASE || "https://gitgitmiko.my.id").replace(/\/$/, "");
const secret = process.env.CATALOG_SYNC_SECRET || "";

if (!secret || secret.length < 16) {
  console.error("CATALOG_SYNC_SECRET wajib (min 16 karakter).");
  process.exit(1);
}

async function postSync(body) {
  const res = await fetch(`${apiBase}/api/admin/catalog/sync`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`sync failed ${res.status}: ${text.slice(0, 500)}`);
  }
  return data;
}

function readJson(name) {
  const file = path.join(dataDir, `${name}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

async function main() {
  console.log(`Push katalog → ${apiBase}`);
  for (const name of ITEM_COLLECTIONS) {
    const items = readJson(name);
    if (!items) {
      console.warn(`skip missing ${name}.json`);
      continue;
    }
    if (!Array.isArray(items)) throw new Error(`${name}.json bukan array`);
    const r = await postSync({ collection: name, items });
    console.log(`OK ${name}`, r.results?.[0] || r);
  }
  for (const name of DOC_NAMES) {
    const payload = readJson(name);
    if (payload == null) {
      console.warn(`skip missing ${name}.json`);
      continue;
    }
    const r = await postSync({ doc: name, payload });
    console.log(`OK doc ${name}`, r.results?.[0] || r);
  }
  console.log("Push selesai.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
