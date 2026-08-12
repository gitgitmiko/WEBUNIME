/**
 * Tes P2P LK21 (Outcry) via /__px__/playcdn.de
 * Usage: node scripts/test-p2p.mjs
 */
import http from "node:http";
import { chromium } from "playwright";
import { embedProxyMiddleware } from "../plugins/embed-proxy.js";

const VIDEONODE =
  process.env.P2P_URL ||
  "https://videonode.de/iframe/p2p/LQ09LTcAWiMrNRYobgJmandVHgsHPTseGg5OKXBRZzxzTw";

const server = http.createServer((req, res) =>
  embedProxyMiddleware(req, res, () => {
    res.statusCode = 404;
    res.end("nf");
  })
);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const resolved = await (await fetch(`${base}/api/resolve?url=${encodeURIComponent(VIDEONODE)}`)).json();
console.log("resolve", resolved);

const html = await (await fetch(`${base}${resolved.embed}`)).text();
console.log("html", {
  overlayGone: !/id=["']overlay["']/.test(html),
  maintGone: !/Player P2P Maintenance/i.test(html),
  shim: /IS_P2P=true/.test(html),
});

const browser = await chromium.launch({
  headless: true,
  args: ["--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage();
const media = [];
const fails = [];
page.on("response", (r) => {
  const u = r.url();
  if (/m3u8|\.ts|\/zzz\//i.test(u)) media.push({ s: r.status(), u: u.slice(0, 160) });
  if (r.status() >= 400 && /zzz|m3u8|\.ts|api2/i.test(u)) {
    fails.push({ s: r.status(), u: u.slice(0, 160) });
  }
});

await page.goto(`${base}${resolved.embed}`, { waitUntil: "domcontentloaded", timeout: 60000 });

let info = null;
for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  info = await page.evaluate(() => {
    const v = document.querySelector("video");
    let st = null;
    try {
      st = typeof jwplayer === "function" ? jwplayer().getState() : null;
    } catch (e) {
      st = String(e.message || e);
    }
    return {
      ready: v?.readyState ?? -1,
      src: (v?.currentSrc || "").slice(0, 140),
      dur: v && Number.isFinite(v.duration) ? Math.round(v.duration) : null,
      st,
      overlay: !!document.getElementById("overlay"),
      text: (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 200),
    };
  });
  if (info.ready >= 2 || info.st === "playing" || info.st === "buffering" || (info.dur && info.dur > 30)) {
    break;
  }
}

const mediaOk =
  info.ready >= 2 ||
  info.st === "playing" ||
  info.st === "buffering" ||
  info.st === "paused" ||
  (info.dur && info.dur > 30);
const proxiedZzz = media.some((m) => /__px__\/playcdn\.de\/zzz\//i.test(m.u) && m.s < 400);
const doublePx = media.some((m) => /__px__\/[^/]+\/__px__\//i.test(m.u));
const passed = mediaOk && !info.overlay && !doublePx && fails.filter((f) => /__px__\/.*__px__\//.test(f.u)).length === 0;

console.log(
  JSON.stringify(
    {
      passed,
      mediaOk,
      proxiedZzz,
      doublePx,
      info,
      media: media.slice(0, 15),
      fails: fails.slice(0, 10),
    },
    null,
    2
  )
);

await browser.close();
server.close();
process.exit(passed ? 0 : 1);
