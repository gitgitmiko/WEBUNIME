/**
 * Regresi Cast: express.json tidak boleh mengosongkan body captcha verify.
 */
import express from "express";
import { chromium } from "playwright";
import { embedProxyMiddleware } from "../plugins/embed-proxy.js";

const ID = "uu3esfpz5w6v";
const app = express();
// Simulasi bug lama vs fix: json skip untuk __px__
const jsonApi = express.json({ limit: "32kb" });
app.use((req, res, next) => {
  const path = (req.url || "").split("?")[0] || "";
  if (path.startsWith("/__px__/")) return next();
  return jsonApi(req, res, next);
});
app.use(embedProxyMiddleware);

const server = await new Promise((resolve) => {
  const s = app.listen(0, "127.0.0.1", () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;
const headers = {
  "Content-Type": "application/json",
  "X-Embed-Origin": "playeriframe.sbs",
  "X-Embed-Referer": "https://playeriframe.sbs/",
  "X-Embed-Parent": "https://playeriframe.sbs/",
};

const start = await (
  await fetch(`${base}/__px__/gn1r5n.org/api/videos/${ID}/embed/captcha/image`, {
    method: "POST",
    headers,
    body: "{}",
  })
).json();

const results = [];
for (let selection = 0; selection < 6; selection++) {
  const s =
    selection === 0
      ? start
      : await (
          await fetch(`${base}/__px__/gn1r5n.org/api/videos/${ID}/embed/captcha/image`, {
            method: "POST",
            headers,
            body: "{}",
          })
        ).json();
  const res = await fetch(
    `${base}/__px__/gn1r5n.org/api/videos/${ID}/embed/captcha/image/${encodeURIComponent(s.challenge_id)}/verify`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ selection }),
    }
  );
  const t = await res.text();
  results.push({ selection, status: res.status, body: t.slice(0, 120), target: s.target });
  if (res.status === 200 && /"status":"ok"/.test(t)) break;
  if (res.status === 400) break;
}

console.log(JSON.stringify({ start: { target: start.target, tiles: start.tiles }, results }, null, 2));

const broken = results.some((r) => r.status === 400 && /invalid request body/i.test(r.body));
const okish = results.some((r) => r.status === 200 && /"status":"(ok|retry)"/.test(r.body));

// Juga pastikan UI play → tidak langsung verifyError bila PoW
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto(`${base}/__px__/gn1r5n.org/e/${ID}`, { waitUntil: "domcontentloaded" });
await new Promise((r) => setTimeout(r, 4000));
await page.locator(".captcha-gate__play").first().click({ timeout: 5000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 10000));
const ui = await page.evaluate(() => ({
  text: document.body.innerText.replace(/\s+/g, " ").slice(0, 200),
  verifyError: /Something went wrong\. Try again/i.test(document.body.innerText),
}));
console.log("ui", ui);
await browser.close();
server.close();

const passed = okish && !broken && !ui.verifyError;
console.log(JSON.stringify({ passed, okish, broken }));
process.exit(passed ? 0 : 1);
