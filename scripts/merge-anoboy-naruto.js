/**
 * Scrape Anoboy Naruto Shippuden batch pages → merge B-Tube (Blogger)
 * players into public/data/anime.json + public/data/mobile/anime.json.
 *
 *   node scripts/merge-anoboy-naruto.js              # all batches
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
const SLUG = "naruto-shippuden";

const BATCHES = [
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
];

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
  // /uploads/adsbatch720.php?url=TOKEN
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

async function scrapeBatch(page, batch) {
  console.log(`[anoboy] scrape ${batch.id} ...`);
  await page.goto(batch.url, { waitUntil: "domcontentloaded", timeout: 120000 });
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
        const text = (a.textContent || "").replace(/\s+/g, " ").trim();
        const m = text.match(/(\d+)/);
        out.push({
          episode: m ? Number(m[1]) : null,
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
    if (!row.episode) continue;
    // Prefer B-Tube / adsbatch (Blogger). Skip zippyshare mirrors.
    if (/zipy|zippyshare/i.test(row.video || "")) continue;
    if (!/adsbatch|blogger|b-tube|btube/i.test(`${row.serverLabel} ${row.video}`)) {
      // still try blogger token extract
    }
    const url = bloggerFromAnoboyPath(row.video);
    if (!url) continue;
    players.push({
      episode: row.episode,
      server: "anoboy",
      label: `Anoboy ${row.serverLabel || "B-Tube"}`,
      url,
      source_page: batch.url,
    });
  }

  console.log(`[anoboy] ${batch.id}: ${players.length} blogger players`);
  return players;
}

function mergePlayersIntoAnime(anime, anoboyPlayers) {
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
        title: `Naruto: Shippuuden Episode ${p.episode}`,
        slug: `naruto-shippuden-episode-${p.episode}`,
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

    // remove older anoboy same-label then add fresh
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
    // renumber
    ep.players.forEach((x, i) => {
      x.no = i + 1;
    });
    added += 1;
  }

  anime.episodes.sort((a, b) => Number(a.episode) - Number(b.episode));
  return { added, createdEps, skipped, totalEps: anime.episodes.length };
}

async function main() {
  const batches = onlyArg
    ? BATCHES.filter((b) => b.id === onlyArg)
    : BATCHES;
  if (!batches.length) {
    throw new Error(`Batch tidak ditemukan untuk --only ${onlyArg}`);
  }

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  });

  const allPlayers = [];
  for (const batch of batches) {
    try {
      allPlayers.push(...(await scrapeBatch(page, batch)));
    } catch (e) {
      console.warn(`[anoboy] gagal ${batch.id}:`, e.message);
    }
  }
  await browser.close();

  // dedupe by episode+label keep last
  const dedup = new Map();
  for (const p of allPlayers) {
    dedup.set(`${p.episode}::${p.label}`, p);
  }
  const players = [...dedup.values()].sort((a, b) => a.episode - b.episode);
  console.log(`[anoboy] total unique blogger players: ${players.length}`);

  if (!players.length) {
    throw new Error("Tidak ada player Blogger dari Anoboy.");
  }

  const mobile = readArr(MOBILE_FILE);
  const mobileIdx = mobile.findIndex((a) => a.slug === SLUG);
  if (mobileIdx < 0) {
    throw new Error("naruto-shippuden tidak ada di mobile anime.json");
  }

  const mobileStats = mergePlayersIntoAnime(mobile[mobileIdx], players);
  writeArr(MOBILE_FILE, mobile);
  console.log("[merge] mobile", mobileStats);

  // TV: samakan entri naruto-shippuden dengan mobile (TV sebelumnya belum punya judul ini).
  const tv = readArr(TV_FILE);
  const src = mobile[mobileIdx];
  const tIdx = tv.findIndex((a) => a.slug === SLUG);
  if (tIdx >= 0) tv[tIdx] = structuredClone(src);
  else tv.push(structuredClone(src));
  writeArr(TV_FILE, tv);
  console.log("[merge] tv synced from mobile, eps=", src.episodes.length);

  const ep401 = src.episodes.find((e) => e.episode === 401);
  console.log(
    "[sample] ep401 players:",
    (ep401?.players || []).map((p) => `${p.label} → ${(p.url || "").slice(0, 60)}`),
  );
  console.log("[done] TV + mobile updated for", SLUG);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
