/**
 * Scrape Anoboy One Piece → merge B-Tube (Blogger) ke katalog TV + mobile.
 *
 *   node scripts/merge-anoboy-one-piece.js
 *   node scripts/merge-anoboy-one-piece.js --resume
 *   node scripts/merge-anoboy-one-piece.js --only-batches
 *   node scripts/merge-anoboy-one-piece.js --only-latest
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const TV_FILE = path.join(ROOT, "public/data/anime.json");
const MOBILE_FILE = path.join(ROOT, "public/data/mobile/anime.json");
const STATE_FILE = path.join(ROOT, "scripts/_anoboy-scrape/one-piece-state.json");

const SLUG = "one-piece";
const TITLE_PREFIX = "One Piece";
const EP_SLUG_PREFIX = "one-piece-episode";
const SEARCH_URL = "https://anoboy.xyz/?s=one+piece+episode";
const MAX_EP = 1300;

const BATCHES = [
  {
    id: "1-100",
    url: "https://anoboy.xyz/2016/03/one-piece-episode-1-sampai-100-streaming-online/",
  },
  {
    id: "101-200",
    url: "https://anoboy.xyz/2016/09/one-piece-ep-101-sampai-200-streaming-online/",
  },
  {
    id: "201-300",
    url: "https://anoboy.xyz/2016/09/one-piece-ep-201-300-streaming-online/",
  },
  {
    id: "301-400",
    url: "https://anoboy.xyz/2016/09/one-piece-ep-301-sampai-400-online/",
  },
  {
    id: "401-500",
    url: "https://anoboy.xyz/2016/09/one-piece-ep-401-sampai-500-stream-online/",
  },
  {
    id: "501-600",
    url: "https://anoboy.xyz/2016/09/one-piece-ep-501-sampai-600-stream/",
  },
  {
    id: "601-700",
    url: "https://anoboy.xyz/2016/09/one-piece-ep-601-sampai-700-stream-online/",
  },
  {
    id: "701-800",
    url: "https://anoboy.xyz/2018/12/one-piece-ep-701-sampai-800-streaming-online/",
  },
  {
    id: "801-900",
    url: "https://anoboy.xyz/2018/12/one-piece-ep-801-sampai-900-streaming-online/",
  },
  {
    id: "901-1000",
    url: "https://anoboy.xyz/2022/06/one-piece-ep-901-sampai-1000-streaming/",
  },
];

const argv = process.argv.slice(2);
const resume = argv.includes("--resume");
const onlyBatches = argv.includes("--only-batches");
const onlyLatest = argv.includes("--only-latest");
const mergeOnly = argv.includes("--merge-only");

function readArr(file) {
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeArr(file, arr) {
  fs.writeFileSync(file, JSON.stringify(arr, null, 2) + "\n", "utf8");
}

function loadState() {
  if ((!resume && !mergeOnly) || !fs.existsSync(STATE_FILE)) {
    return { doneBatches: [], doneEps: {}, players: [] };
  }
  try {
    return {
      doneBatches: [],
      doneEps: {},
      players: [],
      ...JSON.parse(fs.readFileSync(STATE_FILE, "utf8")),
    };
  } catch {
    return { doneBatches: [], doneEps: {}, players: [] };
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n", "utf8");
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
  const t = `${p?.server || ""} ${p?.label || ""} ${p?.source || ""}`.toLowerCase();
  return t.includes("anoboy");
}

function parseEpisodeNumbers(text) {
  const raw = String(text || "")
    .replace(/^(EP|Yup|BT-HD|BTHD|BT)\s*/i, "")
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
    if (b < 10) {
      const end = Math.floor(a / 10) * 10 + b;
      if (end >= a) return end === a ? [a] : [a, end];
    }
    return [a];
  }

  const n = Number((raw.match(/(\d+)/) || [])[1]);
  return n > 0 ? [n] : [];
}

function parseMainEpisodeFromUrl(url) {
  try {
    const slug = decodeURIComponent(
      new URL(url).pathname.split("/").filter(Boolean).pop() || "",
    );
    if (/live-?action|film|movie|special|spesial|heroines|fan-letter|gyojin|download|sampai/i.test(slug)) {
      return null;
    }
    const m = slug.match(/^one-piece-episode-(\d+)(?:-hiatus)?$/i);
    if (!m) return null;
    const n = Number(m[1]);
    return n >= 1 && n <= MAX_EP ? n : null;
  } catch {
    return null;
  }
}

async function scrapeBatch(page, batch) {
  console.log(`[anoboy] batch ${batch.id} ...`);
  await page.goto(batch.url, {
    waitUntil: "domcontentloaded",
    timeout: 120000,
  });
  await page.waitForTimeout(2200);

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
          serverLabel: s.label,
          video: a.getAttribute("data-video"),
        });
      }
    }
    return out;
  });

  const players = [];
  for (const row of rows) {
    if (!/b-?tube/i.test(row.serverLabel || "")) continue;
    if (/zipy|zippyshare|yupbatch/i.test(row.video || "")) continue;
    const url = bloggerFromAnoboyPath(row.video);
    if (!url) continue;
    const episodes = parseEpisodeNumbers(row.text);
    for (const episode of episodes) {
      if (episode < 1 || episode > MAX_EP) continue;
      players.push({
        episode,
        server: "anoboy",
        label: "Anoboy B-Tube",
        url,
        source_page: batch.url,
      });
    }
  }
  console.log(`[anoboy] batch ${batch.id}: ${players.length} blogger links`);
  return players;
}

async function collectSearchEpisodes(page) {
  const byEp = new Map();
  let maxPages = 1;
  for (let n = 1; n <= 40; n += 1) {
    const url =
      n <= 1 ? SEARCH_URL : `https://anoboy.xyz/page/${n}/?s=one+piece+episode`;
    console.log(`[anoboy] search hlm ${n} ...`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForTimeout(1600);
    const listing = await page.evaluate(() => {
      const cards = [...document.querySelectorAll(".column-content a")].filter(
        (a) => a.querySelector("img") && /anoboy\.xyz\/\d{4}\/\d{2}\//.test(a.href),
      );
      const seen = new Set();
      const items = [];
      for (const a of cards) {
        if (seen.has(a.href)) continue;
        seen.add(a.href);
        items.push({
          href: a.href,
          title: (a.textContent || "")
            .replace(/\s+/g, " ")
            .replace(/\s+UP\s+\S+.*$/i, "")
            .trim(),
        });
      }
      const pag = (
        document.querySelector(".wp-pagenavi, .pagination")?.textContent || ""
      ).replace(/\s+/g, " ");
      const max = pag.match(/Page\s+\d+\s+of\s+(\d+)/i);
      return { items, maxPages: max ? Number(max[1]) : 0 };
    });
    if (listing.maxPages) maxPages = listing.maxPages;
    for (const item of listing.items) {
      const ep = parseMainEpisodeFromUrl(item.href);
      if (!ep) continue;
      if (!byEp.has(ep)) byEp.set(ep, item.href);
    }
    if (n >= maxPages) break;
  }
  const items = [...byEp.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([episode, href]) => ({ episode, href }));
  console.log(`[anoboy] search: ${items.length} episode utama (max ${MAX_EP})`);
  return items;
}

async function scrapeEpisodePage(page, item) {
  await page.goto(item.href, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(1200);
  const data = await page.evaluate(() => {
    const mirrors = [
      ...document.querySelectorAll("a[data-video], a#allmiror"),
    ].map((a) => ({
      text: (a.textContent || "").replace(/\s+/g, " ").trim(),
      video: a.getAttribute("data-video") || "",
    }));
    const iframeEl =
      document.querySelector("#mediaplayer") ||
      document.querySelector("#tontonin") ||
      document.querySelector("iframe");
    const iframe = iframeEl?.src || iframeEl?.getAttribute("src") || "";
    return { mirrors, iframe };
  });

  let url = bloggerFromAnoboyPath(data.iframe);
  if (!url) {
    for (const row of data.mirrors) {
      if (/zipy|zippyshare|yup/i.test(row.video || row.text || "")) continue;
      url = bloggerFromAnoboyPath(row.video);
      if (url) break;
    }
  }
  if (!url) return null;
  return {
    episode: item.episode,
    server: "anoboy",
    label: "Anoboy B-Tube",
    url,
    source_page: item.href,
  };
}

function canonicalSlug(n) {
  return `${EP_SLUG_PREFIX}-${n}`;
}

function findEpisodeRows(anime, n) {
  const want = canonicalSlug(n);
  const rows = (anime.episodes || []).filter((e) => {
    if (Number(e.episode) === n) return true;
    return String(e.slug || "") === want;
  });
  // Canonical slug first so new players land on the primary row too.
  rows.sort((a, b) => {
    const ac = String(a.slug || "") === want ? 0 : 1;
    const bc = String(b.slug || "") === want ? 0 : 1;
    return ac - bc;
  });
  return rows;
}

function upsertAnoboyPlayer(ep, p) {
  if (!Array.isArray(ep.players)) ep.players = [];
  const exists = ep.players.some(
    (x) => isAnoboyPlayer(x) && (x.url === p.url || x.label === p.label),
  );
  if (exists) return false;
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
  return true;
}

function mergePlayersIntoAnime(anime, anoboyPlayers) {
  if (!anime.episodes) anime.episodes = [];
  let added = 0;
  let createdEps = 0;
  let skipped = 0;

  for (const p of anoboyPlayers) {
    let rows = findEpisodeRows(anime, p.episode);
    if (!rows.length) {
      const ep = {
        episode: p.episode,
        title: `${TITLE_PREFIX} Episode ${p.episode}`,
        slug: canonicalSlug(p.episode),
        source: p.source_page,
        date: "",
        players: [],
      };
      anime.episodes.push(ep);
      createdEps += 1;
      rows = [ep];
    }

    let anyAdded = false;
    for (const ep of rows) {
      if (Number(ep.episode) !== p.episode) ep.episode = p.episode;
      if (upsertAnoboyPlayer(ep, p)) anyAdded = true;
    }
    if (anyAdded) added += 1;
    else skipped += 1;
  }

  anime.episodes.sort((a, b) => Number(a.episode) - Number(b.episode));
  anime.episodes_count = anime.episodes.length;
  return { added, createdEps, skipped, totalEps: anime.episodes.length };
}

function syncTitleToTv(mobileAnime) {
  const tv = readArr(TV_FILE);
  const tIdx = tv.findIndex((a) => a.slug === SLUG);
  if (tIdx >= 0) tv[tIdx] = structuredClone(mobileAnime);
  else tv.push(structuredClone(mobileAnime));
  writeArr(TV_FILE, tv);
}

function writeCatalog(players) {
  const mobile = readArr(MOBILE_FILE);
  const mobileIdx = mobile.findIndex((a) => a.slug === SLUG);
  if (mobileIdx < 0) throw new Error(`${SLUG} tidak ada di mobile anime.json`);
  const stats = mergePlayersIntoAnime(mobile[mobileIdx], players);
  writeArr(MOBILE_FILE, mobile);
  syncTitleToTv(mobile[mobileIdx]);
  return stats;
}

function dedupePlayers(list) {
  const map = new Map();
  for (const p of list) map.set(`${p.episode}::${p.label}`, p);
  return [...map.values()].sort((a, b) => a.episode - b.episode);
}

async function main() {
  const state = loadState();
  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const page = await browser.newPage({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  });

  try {
    if (mergeOnly) {
      const players = dedupePlayers(state.players);
      console.log(`[merge-only] ${players.length} players from state`);
      if (!players.length) throw new Error("state kosong, jalankan scrape dulu");
      const stats = writeCatalog(players);
      const nums = players.map((p) => p.episode);
      console.log("[merge] mobile+tv", stats);
      console.log(
        `[coverage] ${nums.length} eps, min ${Math.min(...nums)} max ${Math.max(...nums)}`,
      );
      return;
    }

    if (!onlyLatest) {
      for (const batch of BATCHES) {
        if (state.doneBatches.includes(batch.id)) {
          console.log(`[skip] batch ${batch.id}`);
          continue;
        }
        try {
          const rows = await scrapeBatch(page, batch);
          state.players.push(...rows);
          state.doneBatches.push(batch.id);
          saveState(state);
        } catch (err) {
          console.warn(`[anoboy] gagal batch ${batch.id}:`, err.message);
        }
      }
    }

    if (!onlyBatches) {
      const listing = await collectSearchEpisodes(page);
      const have = new Set(
        state.players.map((p) => p.episode).filter((n) => n > 0),
      );
      const jobs = listing.filter(
        (item) => item.episode > 1000 || !have.has(item.episode),
      );
      console.log(`[anoboy] scrape halaman episode: ${jobs.length}`);
      let i = 0;
      for (const item of jobs) {
        i += 1;
        if (state.doneEps[String(item.episode)]) continue;
        try {
          const row = await scrapeEpisodePage(page, item);
          if (row) {
            state.players.push(row);
            state.doneEps[String(item.episode)] = item.href;
          } else {
            console.warn(`[anoboy] kosong ep ${item.episode}`);
            state.doneEps[String(item.episode)] = `empty:${item.href}`;
          }
        } catch (err) {
          console.warn(`[anoboy] gagal ep ${item.episode}:`, err.message);
        }
        if (i % 15 === 0) {
          saveState(state);
          console.log(`[progress] ${i}/${jobs.length} episode pages`);
        }
      }
      saveState(state);
    }

    const players = dedupePlayers(state.players);
    console.log(`[anoboy] unique blogger players: ${players.length}`);
    if (!players.length) throw new Error("tidak ada player Anoboy untuk merge");

    const stats = writeCatalog(players);
    const nums = players.map((p) => p.episode);
    const missing = [];
    for (let n = 1; n <= MAX_EP; n += 1) {
      if (!nums.includes(n)) missing.push(n);
    }
    console.log("[merge] mobile+tv", stats);
    console.log(
      `[coverage] ${nums.length} eps, min ${Math.min(...nums)} max ${Math.max(...nums)}, missing ${missing.length}`,
    );
    if (missing.length && missing.length <= 40) {
      console.log("[missing]", missing.join(", "));
    } else if (missing.length) {
      console.log(
        "[missing sample]",
        missing.slice(0, 25).join(", "),
        `... +${missing.length - 25}`,
      );
    }
  } finally {
    await browser.close();
  }
  console.log("\n[done]");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
