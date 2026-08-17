import { Router } from "express";
import { DOC_NAMES, ITEM_COLLECTIONS, isDocName, isItemCollection } from "./catalog-meta.js";
import {
  getDoc,
  getItem,
  listCollection,
  listCollectionAll,
  listHero,
  searchCatalog,
} from "./catalog.js";

/**
 * API baca katalog (wajib auth via login guard / cookie / Bearer).
 */
export function createCatalogReadRouter() {
  const router = Router();

  router.get("/", (_req, res) => {
    res.json({
      itemCollections: ITEM_COLLECTIONS,
      docs: DOC_NAMES,
      endpoints: {
        list: "/api/v1/catalog/:collection?page=&limit=&q=&genre=",
        all: "/api/v1/catalog/:collection/all",
        item: "/api/v1/catalog/:collection/:slug",
        search: "/api/v1/search?q=&limit=",
        hero: "/api/v1/hero?limit=",
        doc: "/api/v1/docs/:name",
      },
    });
  });

  router.get("/hero", async (req, res) => {
    try {
      const data = await listHero({ limit: req.query.limit });
      res.setHeader("Cache-Control", "private, max-age=60");
      return res.json(data);
    } catch (err) {
      console.error("[catalog/hero]", err);
      return res.status(500).json({ error: "Gagal memuat hero." });
    }
  });

  router.get("/search", async (req, res) => {
    try {
      const data = await searchCatalog({ q: req.query.q, limit: req.query.limit });
      res.setHeader("Cache-Control", "private, max-age=15");
      return res.json(data);
    } catch (err) {
      console.error("[catalog/search]", err);
      return res.status(500).json({ error: "Gagal mencari katalog." });
    }
  });

  router.get("/catalog/:collection/all", async (req, res) => {
    const { collection } = req.params;
    if (!isItemCollection(collection)) {
      return res.status(404).json({ error: "Koleksi tidak ditemukan." });
    }
    try {
      const items = await listCollectionAll(collection);
      res.setHeader("Cache-Control", "private, max-age=60");
      return res.json(items);
    } catch (err) {
      console.error("[catalog/all]", err);
      return res.status(500).json({ error: "Gagal memuat katalog." });
    }
  });

  router.get("/catalog/:collection/:slug", async (req, res) => {
    const { collection, slug } = req.params;
    if (!isItemCollection(collection)) {
      return res.status(404).json({ error: "Koleksi tidak ditemukan." });
    }
    if (slug === "all") return; // handled above
    try {
      const item = await getItem(collection, slug);
      if (!item) return res.status(404).json({ error: "Item tidak ditemukan." });
      res.setHeader("Cache-Control", "private, max-age=60");
      return res.json(item);
    } catch (err) {
      console.error("[catalog/item]", err);
      return res.status(500).json({ error: "Gagal memuat item." });
    }
  });

  router.get("/catalog/:collection", async (req, res) => {
    const { collection } = req.params;
    if (!isItemCollection(collection)) {
      return res.status(404).json({ error: "Koleksi tidak ditemukan." });
    }
    try {
      const data = await listCollection(collection, {
        page: req.query.page,
        limit: req.query.limit,
        q: req.query.q,
        genre: req.query.genre,
      });
      res.setHeader("Cache-Control", "private, max-age=30");
      return res.json(data);
    } catch (err) {
      console.error("[catalog/list]", err);
      return res.status(500).json({ error: "Gagal memuat katalog." });
    }
  });

  router.get("/docs/:name", async (req, res) => {
    const { name } = req.params;
    if (!isDocName(name)) {
      return res.status(404).json({ error: "Dokumen tidak ditemukan." });
    }
    try {
      const doc = await getDoc(name);
      if (doc == null) return res.status(404).json({ error: "Dokumen kosong." });
      res.setHeader("Cache-Control", "private, max-age=60");
      return res.json(doc);
    } catch (err) {
      console.error("[catalog/doc]", err);
      return res.status(500).json({ error: "Gagal memuat dokumen." });
    }
  });

  return router;
}
