/**
 * Vite plugin: GET/POST /api/sync-catalog
 * Sync inkremental:
 * - LK21: latest / series / horror
 * - Samehadaku: anime-terbaru (episode baru) + anime-movie (judul baru)
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { syncCatalogIncremental } from "../scripts/lib/catalog-sync.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function handleSync(req, res) {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const force = url.searchParams.get("force") === "1";

  syncCatalogIncremental(ROOT, { force })
    .then((result) => sendJson(res, 200, result))
    .catch((err) => {
      console.error("[catalog-sync]", err);
      sendJson(res, 500, { ok: false, error: err.message || String(err) });
    });
}

function middleware(req, res, next) {
  const path = req.url?.split("?")[0] || "";
  if (path !== "/api/sync-catalog") return next();
  if (req.method !== "GET" && req.method !== "POST") {
    res.statusCode = 405;
    res.end("Method Not Allowed");
    return;
  }
  return handleSync(req, res);
}

export function catalogSyncPlugin() {
  return {
    name: "webunime-catalog-sync",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
