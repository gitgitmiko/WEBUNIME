/**
 * Test resmi Hydrax: iframe langsung ke abyssplayer.com (pola yang lulus).
 * Proxy /__px__ tidak bisa memutar media sssrr (Referer + Cloudflare).
 *
 * Usage: node scripts/test-hydrax.mjs
 * Exit 0 = lulus
 */
import { chromium } from "playwright";

const SLUG = process.env.HYDRAX_SLUG || "BHi3cEL0e";
const ABYSS = `https://abyssplayer.com/${SLUG}`;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

await page.setContent(
  `<!doctype html><iframe id="f" src="${ABYSS}" style="width:100%;height:90vh;border:0" allow="autoplay; fullscreen" allowfullscreen></iframe>`,
  { waitUntil: "domcontentloaded" }
);
await new Promise((r) => setTimeout(r, 8000));

const frame = page.frames().find((f) => f.url().includes("abyssplayer"));
if (!frame) {
  console.log(JSON.stringify({ passed: false, error: "iframe abyssplayer tidak muncul" }, null, 2));
  await browser.close();
  process.exit(1);
}

try {
  const overlay = frame.locator("#overlay");
  if (await overlay.count()) await overlay.click({ timeout: 2000 }).catch(() => {});
} catch {}

await new Promise((r) => setTimeout(r, 10000));

const info = await frame.evaluate(() => {
  const v = document.querySelector("video");
  let st = null;
  try {
    st = typeof jwplayer === "function" ? jwplayer().getState() : null;
  } catch (e) {
    st = e.message;
  }
  return {
    href: location.href,
    ready: v ? v.readyState : -1,
    src: v ? String(v.currentSrc || "").slice(0, 120) : "",
    st,
    body: (document.body.innerText || "").slice(0, 600),
  };
});

const markers = [
  "No playable sources found",
  "Slug is not found",
  "Player has been destroyed",
  "AdBlock/Sandbox",
  "cannot be played",
  "224003",
];
const fail = markers.filter((m) => info.body.toLowerCase().includes(m.toLowerCase()));
const mediaOk =
  info.ready >= 2 ||
  info.st === "playing" ||
  info.st === "buffering" ||
  info.st === "paused" ||
  (info.ready >= 1 && /hour|minute|second/i.test(info.body));
const passed = fail.length === 0 && mediaOk;

console.log(JSON.stringify({ passed, fail, mediaOk, mode: "direct-iframe", info }, null, 2));
await browser.close();
process.exit(passed ? 0 : 1);
