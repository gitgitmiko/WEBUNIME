import "dotenv/config";
import express from "express";
import cookieParser from "cookie-parser";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { embedProxyMiddleware } from "../plugins/embed-proxy.js";
import { createAuthRouter, createLoginGuard } from "./auth.js";
import { createCatalogAdminRouter } from "./catalog-admin.js";
import { createCatalogReadRouter } from "./catalog-api.js";
import { createUserLibraryRouter } from "./user-library-api.js";
import { ensureUserLibrarySchema } from "./user-library.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");
const port = Number(process.env.PORT) || 4173;
const host = process.env.HOST || "127.0.0.1";

const app = express();

app.disable("x-powered-by");
app.set("trust proxy", 1);

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});

app.use(cookieParser());

// Auth JSON kecil
app.use("/api/auth", express.json({ limit: "32kb" }), createAuthRouter());

// Sync katalog dari GitHub Actions (payload besar)
app.use(
  "/api/admin/catalog",
  express.json({ limit: "120mb" }),
  createCatalogAdminRouter()
);

app.use(express.json({ limit: "32kb" }));
app.use(createLoginGuard());
app.use("/api/v1", createCatalogReadRouter());
app.use("/api/v1", createUserLibraryRouter());
app.use(embedProxyMiddleware);

app.use(
  express.static(dist, {
    index: false,
    fallthrough: true,
    maxAge: process.env.NODE_ENV === "production" ? "1h" : 0,
  })
);

app.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  const accept = String(req.headers.accept || "");
  if (accept && !accept.includes("text/html") && accept !== "*/*") {
    return res.status(404).end();
  }
  res.sendFile(path.join(dist, "index.html"), (err) => {
    if (err) next(err);
  });
});

app.use((err, _req, res, _next) => {
  console.error("[server]", err);
  if (!res.headersSent) {
    res.status(500).json({ error: "Kesalahan server." });
  }
});

app.listen(port, host, async () => {
  try {
    await ensureUserLibrarySchema();
    console.log("User library schema ready");
  } catch (err) {
    console.error("User library schema failed:", err.message);
  }
  console.log(`WEBUNIME listening on http://${host}:${port}`);
});
