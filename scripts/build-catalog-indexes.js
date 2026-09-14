#!/usr/bin/env node
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeCatalogIndexes } from "./lib/catalog-indexes.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = join(root, "public", "data");
const rows = await writeCatalogIndexes(dataDir);
for (const row of rows) {
  console.log(`✓ ${row.file} (${row.count} items)`);
}
