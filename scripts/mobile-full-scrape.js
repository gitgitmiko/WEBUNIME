#!/usr/bin/env node
/**
 * Full scrape Samehadaku → public/data/mobile/anime.json (+ push loop).
 * Tidak menulis ke root TV anime.json.
 */
import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile, unlink, copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MOBILE = join(ROOT, "public", "data", "mobile");
const LOG = join(ROOT, "scripts", "_mobile-scrape.log");
const DONE = join(ROOT, "scripts", "_mobile-scrape.done.json");
const TARGET_MIN = 700;
const MAX_PASSES = 5;

async function log(line) {
  const msg = `[${new Date().toISOString()}] ${line}`;
  console.log(msg);
  await appendFile(LOG, msg + "\n", "utf8").catch(() => {});
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: ROOT,
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
      process.stdout.write(d);
      appendFile(LOG, d.toString()).catch(() => {});
    });
    child.stderr.on("data", (d) => {
      out += d;
      process.stderr.write(d);
      appendFile(LOG, d.toString()).catch(() => {});
    });
    child.on("exit", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${cmd} ${args.join(" ")} => ${code}\n${out}`)),
    );
  });
}

async function animeCount() {
  try {
    const a = JSON.parse(await readFile(join(MOBILE, "anime.json"), "utf8"));
    return Array.isArray(a) ? a.length : 0;
  } catch {
    return 0;
  }
}

async function detectMaxPages() {
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      channel: "chrome",
      args: ["--disable-blink-features=AutomationControlled"],
    });
  } catch {
    browser = await chromium.launch({ headless: true });
  }
  const page = await browser.newPage({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  });
  try {
    let lastGood = 1;
    for (let p = 1; p <= 80; p++) {
      const url =
        p <= 1
          ? "https://v2.samehadaku.how/daftar-anime-2/?title&status&type&order=update"
          : `https://v2.samehadaku.how/daftar-anime-2/page/${p}/?title&status&type&order=update`;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
      await page.waitForTimeout(2000);
      const html = await page.content();
      const cards = (html.match(/animepost/gi) || []).length;
      const links = [...html.matchAll(/\/anime\/([a-z0-9\-]+)/gi)].length;
      if (cards > 0 || links >= 5) lastGood = p;
      else if (p > lastGood + 1) break;
    }
    return lastGood;
  } finally {
    await browser.close();
  }
}

async function pushData(msg) {
  await run("git", ["add", "public/data/mobile"]);
  const status = await run("git", ["status", "--porcelain", "public/data/mobile"]);
  if (!status.trim()) {
    await log("No mobile data changes (" + msg + ")");
    return false;
  }
  const msgFile = join(ROOT, "scripts", "_commit-msg.txt");
  await writeFile(msgFile, msg + "\n", "utf8");
  try {
    await run("git", ["commit", "-F", msgFile]);
    await run("git", ["push", "origin", "HEAD"]);
    await log("Pushed: " + msg);
    return true;
  } finally {
    await unlink(msgFile).catch(() => {});
  }
}

async function syncSideFiles() {
  // Salin schedule/movies/latest root → mobile jika ada (best-effort)
  for (const f of ["anime-latest.json", "anime-movies.json", "anime-schedule.json"]) {
    try {
      await copyFile(join(ROOT, "public", "data", f), join(MOBILE, f));
    } catch {
      /* ignore */
    }
  }
  try {
    await run("node", ["scripts/scrape-anime-schedule.js"]);
    await copyFile(
      join(ROOT, "public", "data", "anime-schedule.json"),
      join(MOBILE, "anime-schedule.json"),
    );
  } catch (e) {
    await log("schedule warn: " + (e.message || e));
  }
  try {
    await run("node", ["scripts/scrape-latest.js"]);
    await copyFile(
      join(ROOT, "public", "data", "anime-latest.json"),
      join(MOBILE, "anime-latest.json"),
    );
  } catch (e) {
    await log("latest warn: " + (e.message || e));
  }
}

async function main() {
  await mkdir(MOBILE, { recursive: true });
  await writeFile(LOG, "", "utf8");
  await log("START mobile full scrape");
  const maxPages = await detectMaxPages();
  await log(`maxPages=${maxPages}`);

  for (let pass = 1; pass <= MAX_PASSES; pass++) {
    const before = await animeCount();
    if (before >= TARGET_MIN && pass > 1) {
      await log(`Target reached ${before}`);
      break;
    }
    const delay = 700 + pass * 100;
    await log(`Pass ${pass}: scrape-anime --pages ${maxPages} --delay ${delay} (current=${before})`);
    try {
      await run("node", [
        "scripts/scrape-anime.js",
        "--pages",
        String(maxPages),
        "--delay",
        String(delay),
      ]);
    } catch (err) {
      await log("Pass warn: " + (err.message || err));
    }
    const after = await animeCount();
    await log(`Pass ${pass} done: ${before} → ${after}`);
    await pushData(`chore(mobile): Samehadaku scrape pass ${pass} (${after} anime)`);
    if (pass > 1 && after - before < 5) {
      await log("Little growth, stop");
      break;
    }
  }

  await syncSideFiles();
  await pushData(`chore(mobile): sync latest/schedule after full scrape (${await animeCount()} anime)`);

  const result = {
    ok: true,
    finishedAt: new Date().toISOString(),
    count: await animeCount(),
    maxPages,
  };
  await writeFile(DONE, JSON.stringify(result, null, 2) + "\n", "utf8");
  await log("DONE " + JSON.stringify(result));
}

main().catch(async (err) => {
  await log("FATAL " + (err?.stack || err));
  await writeFile(
    DONE,
    JSON.stringify({ ok: false, error: String(err?.message || err), finishedAt: new Date().toISOString() }, null, 2) +
      "\n",
    "utf8",
  );
  process.exit(1);
});
