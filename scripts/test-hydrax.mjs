/**
 * Test Hydrax via /__hydrax__ → /__px__ (sanitasi AdBlock + media sssrr).
 * Usage: node scripts/test-hydrax.mjs
 */
import http from "node:http";
import { chromium } from "playwright";
import { embedProxyMiddleware } from "../plugins/embed-proxy.js";

const SLUG = process.env.HYDRAX_SLUG || "BHi3cEL0e";
const ABYSS = `https://abyssplayer.com/${SLUG}`;

function startProxyServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      embedProxyMiddleware(req, res, () => {
        res.statusCode = 404;
        res.end("not found");
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

const { server, base } = await startProxyServer();
const embed = `${base}/__hydrax__?u=${encodeURIComponent(ABYSS)}`;

// Smoke: sssrr proxy tidak 404 karena Origin
const smokeUrl = `${base}/__px__/rzc8up3i3.sssrr.org/sora/937652883/Z1hKWFhyNGJQd2VteklmdDB1YlFaa3V3eXlTdlIyNVFObDdKWTlydjg0dWxVTjhTTHc`;
const smoke = await fetch(smokeUrl, {
  headers: { Range: "bytes=0-64" },
  redirect: "manual",
});
const smokeBuf = Buffer.from(await smoke.arrayBuffer());
const smokeLoc = smoke.headers.get("location") || "";
const smokeOk =
  (smoke.status === 206 || smoke.status === 200) &&
  smokeBuf.length > 0 &&
  (smoke.headers.get("content-type") || "").includes("video");
console.log(
  JSON.stringify(
    {
      smokeStatus: smoke.status,
      smokeLen: smokeBuf.length,
      smokeCt: smoke.headers.get("content-type"),
      smokeHex: smokeBuf.slice(0, 8).toString("hex"),
      smokeLoc: smokeLoc.slice(0, 80),
      smokeOk,
    },
    null,
    2
  )
);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.on("console", (msg) => {
  if (/error|slug|playable|AdBlock|source/i.test(msg.text())) console.log("[console]", msg.text().slice(0, 200));
});
page.on("pageerror", (err) => console.log("[pageerror]", String(err).slice(0, 200)));

await page.goto(embed, { waitUntil: "domcontentloaded", timeout: 60000 });

let playerFrame = null;
for (let i = 0; i < 40; i++) {
  playerFrame = page
    .frames()
    .find((f) => /__px__\/abyssplayer|\/BHi3cEL0e|abyssplayer\.com/i.test(f.url()) && !/__hydrax__/i.test(f.url()));
  if (playerFrame) break;
  await new Promise((r) => setTimeout(r, 500));
}

console.log(
  "frames",
  page.frames().map((f) => f.url().slice(0, 100))
);

if (playerFrame) {
  try {
    const overlay = playerFrame.locator("#overlay");
    if (await overlay.count()) await overlay.click({ timeout: 2000 }).catch(() => {});
  } catch {
    /* ignore */
  }
}

await new Promise((r) => setTimeout(r, 16000));

const info = playerFrame
  ? await playerFrame.evaluate(() => {
      const v = document.querySelector("video");
      let st = null;
      try {
        st = typeof jwplayer === "function" ? jwplayer().getState() : null;
      } catch (e) {
        st = e.message;
      }
      return {
        href: location.href.slice(0, 160),
        ready: v ? v.readyState : -1,
        src: v ? String(v.currentSrc || "").slice(0, 160) : "",
        dur: v && Number.isFinite(v.duration) ? Math.round(v.duration) : null,
        st,
        body: (document.body.innerText || "").slice(0, 500),
        htmlLen: document.documentElement?.innerHTML?.length || 0,
      };
    })
  : { error: "player frame missing", frames: page.frames().map((f) => f.url().slice(0, 100)) };

const markers = [
  "No playable sources found",
  "Slug is not found",
  "Player has been destroyed",
  "AdBlock/Sandbox",
  "cannot be played",
  "224003",
];
const fail = markers.filter((m) => String(info.body || "").toLowerCase().includes(m.toLowerCase()));
const mediaOk =
  info.ready >= 2 ||
  info.st === "playing" ||
  info.st === "buffering" ||
  info.st === "paused" ||
  (info.ready >= 1 && /hour|minute|second/i.test(String(info.body || "")));
const proxiedMedia = /__px__\//i.test(String(info.src || ""));
const passed = fail.length === 0 && mediaOk;

console.log(
  JSON.stringify(
    { passed, fail, mediaOk, proxiedMedia, mode: "hydrax-proxy", info },
    null,
    2
  )
);

await browser.close();
server.close();
process.exit(passed ? 0 : 1);
