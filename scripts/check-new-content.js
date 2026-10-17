#!/usr/bin/env node
/**
 * Cek halaman pertama sumber. Exit code: 0 = ada konten baru, 10 = tidak ada, 1 = gagal total.
 *   node scripts/check-new-content.js
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { checkFirstPageForNew } from "./lib/catalog-sync.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const report = await checkFirstPageForNew(ROOT);
console.log(JSON.stringify(report));
if (report.hasNew) process.exit(0);
process.exit(report.errors.length >= 2 ? 1 : 10);
