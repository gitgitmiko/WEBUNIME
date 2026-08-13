/**
 * Scrape Anoboy → merge B-Tube (Blogger) ke katalog TV + mobile.
 *
 *   node scripts/merge-anoboy-naruto.js                 # shippuden + kecil
 *   node scripts/merge-anoboy-naruto.js --series shippuden
 *   node scripts/merge-anoboy-naruto.js --series kecil
 *   node scripts/merge-anoboy-naruto.js --only 401-500
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const TV_FILE = path.join(ROOT, "public/data/anime.json");
const MOBILE_FILE = path.join(ROOT, "public/data/mobile/anime.json");

const SERIES = {
  shippuden: {
    slug: "naruto-shippuden",
    titlePrefix: "Naruto: Shippuuden",
    epSlugPrefix: "naruto-shippuden-episode",
    batches: [
      {
        id: "1-100",
        url: "https://anoboy.xyz/2018/02/naruto-shippuden-episode-1-100/",
      },
      {
        id: "101-200",
        url: "https://anoboy.xyz/2018/02/naruto-shippuden-episode-101-200/",
      },
      {
        id: "201-300",
        url: "https://anoboy.xyz/2018/02/naruto-shippuden-episode-201-300/",
      },
      {
        id: "301-400",
        url: "https://anoboy.xyz/2018/02/naruto-shippuden-episode-301-400/",
      },
      {
        id: "401-500",
        url: "https://anoboy.xyz/2018/02/naruto-shippuden-episode-401-500/",
      },
    ],
  },
  kecil: {
    slug: "naruto-kecil",
    titlePrefix: "Naruto Kecil",
    epSlugPrefix: "naruto-kecil-episode",
    batches: [
      {
        id: "1-100",
        url: "https://anoboy.xyz/2018/01/naruto-episode-1-100-streaming/",
      },
      {
        id: "101-220",
        url: "https://anoboy.xyz/2018/01/naruto-episode-101-220-tamat-streaming/",
      },
    ],
  },
};

const seriesArg = (() => {
  const i = process.argv.indexOf("--series");
  return i >= 0 ? String(process.argv[i + 1] || "").trim().toLowerCase() : "all";
})();
const onlyArg = (() => {
  const i = process.argv.indexOf("--only");
  return i >= 0 ? String(process.argv[i + 1] || "").trim() : "";
})();

function readArr(file) {
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeArr(file, arr) {
  fs.writeFileSync(file, JSON.stringify(arr, null, 2) + "\n", "utf8");
}

function bloggerFromAnoboyPath(videoPath) {
  if (!videoPath) return null;
  const m = String(videoPath).match(/[?&]url=([^&]+)/i);
  if (!m) return null;
  const token = decodeURIComponent(m[1]);
  if (!/^AD6v5/i.test(token)) return null;
  return `https://www.blogger.com/video.g?token=${token}`;
}

function isAnoboyPlayer(p) {
  const t = `${p?.server || ""} ${p?.label || ""}`.toLowerCase();
  return t.includes("anoboy");
}

/** Parse "EP 57&58", "EP 101-2", "EP 01", "Yup 12" → [57,58] / [101,102] / [1] */
function parseEpisodeNumbers(text) {
  const raw = String(text || "")
    .replace(/^(EP|Yup)\s*/i, "")
    .trim();
  if (!raw) return [];

  if (/&/.test(raw)) {
    return [
      ...new Set(
        [...raw.matchAll(/(\d+)/g)]
          .map((m) => Number(m[1]))
          .filter((n) => n > 0),
      ),
    ];
  }

  const range = raw.match(/^(\d+)\s*[-–]\s*(\d+)$/);
  if (range) {
    const a = Number(range[1]);
    const b = Number(range[2]);
    if (b >= a) return [a, b];
    // Anoboy shorthand: 101-2 → 101,102 ; 119-0 → 119,120
    if (b < 10) {
      const end = Math.floor(a / 10) * 10 + b;
      if (end >= a) return end === a ? [a] : [a, end];
    }
    return [a];
  }

  const n = Number((raw.match(/(\d+)/) || [])[1]);
  return n > 0 ? [n] : [];
}

async function scrapeBatch(page, batch) {
  console.log(`[anoboy] scrape ${batch.id} ...`);
  await page.goto(batch.url, {
    waitUntil: "domcontentloaded",
    timeout: 120000,
  });
  await page.waitForTimeout(2500);

  const rows = await page.evaluate(() => {
    const out = [];
    const servers = [...document.querySelectorAll("button.server")]
      .map((b) => ({
        id: b.id,
        label: (b.textContent || "").replace(/\s+/g, " ").trim(),
      }))
      .filter((s) => s.label);

    for (const s of servers) {
      const box = document.querySelector(`div.${s.id}`);
      if (!box) continue;
      for (const a of box.querySelectorAll("a[data-video]")) {
        out.push({
          text: (a.textContent || "").replace(/\s+/g, " ").trim(),
          serverId: s.id,
          serverLabel: s.label,
          video: a.getAttribute("data-video"),
        });
      }
    }
    return out;
  });

  const players = [];
  for (const row of rows) {
    if (/zipy|zippyshare|yupbatch/i.test(row.video || "")) continue;
    const url = bloggerFromAnoboyPath(row.video);
    if (!url) continue;
    const episodes = parseEpisodeNumbers(row.text);
    for (const episode of episodes) {
      players.push({
        episode,
        server: "anoboy",
        label: `Anoboy ${row.serverLabel || "B-Tube"}`,
        url,
        source_page: batch.url,
      });
    }
  }

  console.log(`[anoboy] ${batch.id}: ${players.length} blogger player-links`);
  return players;
}

function mergePlayersIntoAnime(anime, anoboyPlayers, meta) {
  if (!anime.episodes) anime.episodes = [];
  const byEp = new Map(anime.episodes.map((e) => [Number(e.episode), e]));
  let added = 0;
  let createdEps = 0;
  let skipped = 0;

  for (const p of anoboyPlayers) {
    let ep = byEp.get(p.episode);
    if (!ep) {
      ep = {
        episode: p.episode,
        title: `${meta.titlePrefix} Episode ${p.episode}`,
        slug: `${meta.epSlugPrefix}-${p.episode}`,
        source: p.source_page,
        date: "",
        players: [],
      };
      anime.episodes.push(ep);
      byEp.set(p.episode, ep);
      createdEps += 1;
    }
    if (!Array.isArray(ep.players)) ep.players = [];

    const exists = ep.players.some(
      (x) => isAnoboyPlayer(x) && (x.url === p.url || x.label === p.label),
    );
    if (exists) {
      skipped += 1;
      continue;
    }

    ep.players = ep.players.filter(
      (x) => !(isAnoboyPlayer(x) && x.label === p.label),
    );
    ep.players.push({
      no: ep.players.length + 1,
      server: p.server,
      label: p.label,
      url: p.url,
      default: ep.players.length === 0,
      source: "anoboy",
    });
    ep.players.forEach((x, i) => {
      x.no = i + 1;
    });
    added += 1;
  }

  anime.episodes.sort((a, b) => Number(a.episode) - Number(b.episode));
  return { added, createdEps, skipped, totalEps: anime.episodes.length };
}

function syncTitleToTv(slug, mobileAnime) {
  const tv = readArr(TV_FILE);
  const tIdx = tv.findIndex((a) => a.slug === slug);
  if (tIdx >= 0) tv[tIdx] = structuredClone(mobileAnime);
  else tv.push(structuredClone(mobileAnime));
  writeArr(TV_FILE, tv);
}

async function mergeSeries(page, key) {
  const meta = SERIES[key];
  if (!meta) throw new Error(`Series tidak dikenal: ${key}`);

  let batches = meta.batches;
  if (onlyArg) {
    batches = batches.filter((b) => b.id === onlyArg);
    if (!batches.length) {
      console.warn(`[skip] ${key}: tidak ada batch --only ${onlyArg}`);
      return null;
    }
  }

  const allPlayers = [];
  for (const batch of batches) {
    try {
      allPlayers.push(...(await scrapeBatch(page, batch)));
    } catch (e) {
      console.warn(`[anoboy] gagal ${key}/${batch.id}:`, e.message);
    }
  }

  const dedup = new Map();
  for (const p of allPlayers) {
    dedup.set(`${p.episode}::${p.label}`, p);
  }
  const players = [...dedup.values()].sort((a, b) => a.episode - b.episode);
  console.log(`[anoboy] ${key} unique blogger players: ${players.length}`);
  if (!players.length) {
    console.warn(`[anoboy] ${key}: kosong, skip merge`);
    return null;
  }

  const mobile = readArr(MOBILE_FILE);
  const mobileIdx = mobile.findIndex((a) => a.slug === meta.slug);
  if (mobileIdx < 0) {
    throw new Error(`${meta.slug} tidak ada di mobile anime.json`);
  }

  const stats = mergePlayersIntoAnime(mobile[mobileIdx], players, meta);
  writeArr(MOBILE_FILE, mobile);
  syncTitleToTv(meta.slug, mobile[mobileIdx]);
  console.log(`[merge] ${key} mobile+tv`, stats);

  const sampleEp = mobile[mobileIdx].episodes.find((e) =>
    e.players?.some((p) => isAnoboyPlayer(p)),
  );
  if (sampleEp) {
    console.log(
      `[sample] ${key} ep${sampleEp.episode}:`,
      sampleEp.players.map((p) => p.label).join(" | "),
    );
  }
  return stats;
}

async function main() {
  const keys =
    seriesArg === "all"
      ? Object.keys(SERIES)
      : seriesArg.split(",").map((s) => s.trim()).filter(Boolean);

  for (const k of keys) {
    if (!SERIES[k]) throw new Error(`Series tidak dikenal: ${k}`);
  }

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  });

  for (const key of keys) {
    console.log(`\n==== ${key} ====`);
    await mergeSeries(page, key);
  }

  await browser.close();
  console.log("\n[done]");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
