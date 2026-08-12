import { Router } from "express";
import { timingSafeEqual } from "node:crypto";
import { DOC_NAMES, ITEM_COLLECTIONS, isDocName, isItemCollection } from "./catalog-meta.js";
import { putDoc, replaceCollection } from "./catalog.js";

function safeSecretEqual(provided, expected) {
  if (!expected || !provided) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function readSyncSecret(req) {
  const auth = String(req.headers.authorization || "");
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return String(req.headers["x-catalog-sync-token"] || "").trim();
}

function requireSyncSecret(req, res) {
  const expected = process.env.CATALOG_SYNC_SECRET || "";
  if (!expected || expected.length < 16) {
    res.status(503).json({ error: "CATALOG_SYNC_SECRET belum dikonfigurasi." });
    return false;
  }
  if (!safeSecretEqual(readSyncSecret(req), expected)) {
    res.status(401).json({ error: "Token sync tidak valid." });
    return false;
  }
  return true;
}

/**
 * POST /api/admin/catalog/sync
 * Body: { collection: "movies", items: [...] }
 *    atau { doc: "anime-schedule", payload: {...} }
 *    atau { collections: { movies: [...], series: [...] }, docs: { ... } }
 */
export function createCatalogAdminRouter() {
  const router = Router();

  router.get("/ping", (req, res) => {
    if (!requireSyncSecret(req, res)) return;
    res.json({
      ok: true,
      itemCollections: ITEM_COLLECTIONS,
      docs: DOC_NAMES,
    });
  });

  router.post("/sync", async (req, res) => {
    if (!requireSyncSecret(req, res)) return;
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const results = [];

    try {
      if (body.collection && Array.isArray(body.items)) {
        if (!isItemCollection(body.collection)) {
          return res.status(400).json({ error: `Koleksi tidak dikenal: ${body.collection}` });
        }
        results.push(await replaceCollection(body.collection, body.items));
      }

      if (body.doc != null) {
        if (!isDocName(body.doc)) {
          return res.status(400).json({ error: `Dokumen tidak dikenal: ${body.doc}` });
        }
        results.push(await putDoc(body.doc, body.payload));
      }

      if (body.collections && typeof body.collections === "object") {
        for (const [name, items] of Object.entries(body.collections)) {
          if (!isItemCollection(name)) {
            return res.status(400).json({ error: `Koleksi tidak dikenal: ${name}` });
          }
          if (!Array.isArray(items)) {
            return res.status(400).json({ error: `collections.${name} harus array` });
          }
          results.push(await replaceCollection(name, items));
        }
      }

      if (body.docs && typeof body.docs === "object") {
        for (const [name, payload] of Object.entries(body.docs)) {
          if (!isDocName(name)) {
            return res.status(400).json({ error: `Dokumen tidak dikenal: ${name}` });
          }
          results.push(await putDoc(name, payload));
        }
      }

      if (!results.length) {
        return res.status(400).json({
          error: "Body kosong. Kirim collection+items, doc+payload, collections, atau docs.",
        });
      }

      return res.json({ ok: true, results });
    } catch (err) {
      console.error("[catalog/sync]", err);
      return res.status(500).json({ error: err.message || "Gagal sync katalog." });
    }
  });

  return router;
}
