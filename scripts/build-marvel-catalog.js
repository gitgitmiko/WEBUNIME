#!/usr/bin/env node
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeMarvelCatalog } from "./lib/marvel-catalog.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const row = await writeMarvelCatalog(join(root, "public", "data"));
console.log(`✓ ${row.file} (${row.count} items)`);
