#!/usr/bin/env node
/**
 * Resolve /iframe3/ → embedUrl via curl.exe (Node fetch kena CF fingerprint).
 * Pola App TV: warm GET + cookie + POST /api.php
 *
 *   node scripts/resolve-iframe3-players.js --file public/data/players.stb.json
 */
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function parseArgs(argv) {
  const out = {
    limit: 0,
    file: join(ROOT, "public/data/players.json"),
    delay: 200,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--limit" && argv[i + 1]) out.limit = Math.max(0, Number(argv[++i]) || 0);
    else if (a === "--file" && argv[i + 1]) out.file = argv[++i];
    else if (a === "--delay" && argv[i + 1]) out.delay = Math.max(0, Number(argv[++i]) || 0);
  }
  return out;
}

function parseIframe3(url) {
  try {
    const u = new URL(url);
    if (!/playeriframe\.|videonode\./i.test(u.hostname)) return null;
    const m = u.pathname.match(
      /^\/iframe3\/(hydrax|turbovip|turbo|cast|p2p)\/([^/]+)\/?$/i,
    );
    if (!m) return null;
    let server = m[1].toLowerCase();
    if (server === "turbo") server = "turbovip";
    return { server, id: m[2].trim(), origin: u.origin };
  } catch {
    return null;
  }
}

function curlJson(parsed, jarPath) {
  const bases = [parsed.origin, "https://videonode.de"].filter(
    (v, i, a) => v && a.indexOf(v) === i,
  );
  for (const base of bases) {
    const warmUrl = `${base}/iframe3/${parsed.server}/${parsed.id}`;
    const warm = spawnSync(
      "curl.exe",
      [
        "-sS",
        "--max-time",
        "25",
        "-c",
        jarPath,
        "-b",
        jarPath,
        "-A",
        UA,
        "-H",
        "Accept: text/html,application/xhtml+xml",
        "-H",
        "Referer: https://tv12.lk21official.cc/",
        "-o",
        "NUL",
        "-w",
        "%{http_code}",
        warmUrl,
      ],
      { encoding: "utf8" },
    );
    if (warm.status !== 0) continue;
    const api = spawnSync(
      "curl.exe",
      [
        "-sS",
        "--max-time",
        "25",
        "-c",
        jarPath,
        "-b",
        jarPath,
        "-A",
        UA,
        "-H",
        "Content-Type: application/x-www-form-urlencoded",
        "-H",
        `Origin: ${base}`,
        "-H",
        `Referer: ${warmUrl}`,
        "-X",
        "POST",
        "--data",
        `host=${parsed.server}&id=${parsed.id}`,
        `${base}/api.php`,
      ],
      { encoding: "utf8" },
    );
    if (api.status !== 0) continue;
    const text = String(api.stdout || "").trim();
    if (/sorry, you have been blocked/i.test(text)) continue;
    try {
      const j = JSON.parse(text);
      const embedUrl = String(j?.embedUrl || "").trim();
      if (/^https?:\/\//i.test(embedUrl)) return embedUrl;
    } catch {
      /* next */
    }
  }
  return null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const raw = await readFile(opts.file, "utf8");
  const players = JSON.parse(raw);
  const entries = Array.isArray(players) ? players : Object.values(players);
  const tmp = await mkdtemp(join(tmpdir(), "wu-iframe3-"));
  const jarPath = join(tmp, "cookies.txt");

  let need = 0;
  let ok = 0;
  let fail = 0;

  try {
    for (const entry of entries) {
      const list = Array.isArray(entry?.players) ? entry.players : [];
      for (const p of list) {
        const parsed = parseIframe3(String(p?.url || ""));
        if (!parsed) continue;
        need++;
        if (opts.limit && ok + fail >= opts.limit) continue;
        const embed = curlJson(parsed, jarPath);
        if (embed) {
          p.url = embed;
          p.resolved_from = "iframe3";
          ok++;
          if (ok % 20 === 0) console.log(`… ok ${ok} fail ${fail}`);
        } else {
          fail++;
          if (fail <= 6 || fail % 50 === 0) {
            console.warn(`fail ${entry.slug || "?"} ${parsed.server}`);
          }
        }
        if (opts.delay) await sleep(opts.delay);
      }
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  await writeFile(opts.file, JSON.stringify(players, null, 2) + "\n", "utf8");
  console.log(JSON.stringify({ file: opts.file, need, ok, fail, saved: true }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
