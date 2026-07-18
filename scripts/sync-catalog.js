#!/usr/bin/env node
/** Manual: node scripts/sync-catalog.js [--force] */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { syncCatalogIncremental } from "./lib/catalog-sync.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const force = process.argv.includes("--force");

const result = await syncCatalogIncremental(ROOT, { force });
console.log(JSON.stringify(result, null, 2));
