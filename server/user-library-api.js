import { Router } from "express";
import { ITEM_COLLECTIONS } from "./catalog-meta.js";
import {
  addFavorite,
  isFavorite,
  listFavorites,
  listHistory,
  removeFavorite,
  removeHistory,
  upsertHistory,
} from "./user-library.js";

function requireUser(req, res) {
  if (!req.user?.id) {
    res.status(401).json({ error: "Login wajib." });
    return null;
  }
  return req.user;
}

function parseItemBody(body = {}) {
  const collection = String(body.collection || "").trim();
  const slug = String(body.slug || "")
    .trim()
    .toLowerCase();
  if (!ITEM_COLLECTIONS.includes(collection)) {
    return { error: "collection tidak valid." };
  }
  if (!slug || slug.length > 191) {
    return { error: "slug tidak valid." };
  }
  return {
    collection,
    slug,
    title: body.title != null ? String(body.title) : null,
    thumbnail: body.thumbnail != null ? String(body.thumbnail) : null,
    episodeSlug: body.episodeSlug != null ? String(body.episodeSlug) : null,
    progressSeconds: body.progressSeconds,
  };
}

export function createUserLibraryRouter() {
  const router = Router();

  router.get("/me/favorites", async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    try {
      const items = await listFavorites(user.id);
      return res.json({ items });
    } catch (err) {
      console.error("[favorites/list]", err);
      return res.status(500).json({ error: "Gagal memuat favorit." });
    }
  });

  router.get("/me/favorites/check", async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    const collection = String(req.query.collection || "").trim();
    const slug = String(req.query.slug || "")
      .trim()
      .toLowerCase();
    if (!ITEM_COLLECTIONS.includes(collection) || !slug) {
      return res.status(400).json({ error: "collection/slug wajib." });
    }
    try {
      const favored = await isFavorite(user.id, collection, slug);
      return res.json({ favorite: favored });
    } catch (err) {
      console.error("[favorites/check]", err);
      return res.status(500).json({ error: "Gagal cek favorit." });
    }
  });

  router.post("/me/favorites", async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    const parsed = parseItemBody(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    try {
      await addFavorite(user.id, parsed);
      return res.status(201).json({ ok: true, favorite: true });
    } catch (err) {
      console.error("[favorites/add]", err);
      return res.status(500).json({ error: "Gagal menambah favorit." });
    }
  });

  router.delete("/me/favorites/:collection/:slug", async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    const collection = String(req.params.collection || "").trim();
    const slug = String(req.params.slug || "")
      .trim()
      .toLowerCase();
    if (!ITEM_COLLECTIONS.includes(collection) || !slug) {
      return res.status(400).json({ error: "collection/slug wajib." });
    }
    try {
      await removeFavorite(user.id, collection, slug);
      return res.json({ ok: true, favorite: false });
    } catch (err) {
      console.error("[favorites/remove]", err);
      return res.status(500).json({ error: "Gagal menghapus favorit." });
    }
  });

  router.get("/me/history", async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    try {
      const items = await listHistory(user.id);
      return res.json({ items });
    } catch (err) {
      console.error("[history/list]", err);
      return res.status(500).json({ error: "Gagal memuat riwayat." });
    }
  });

  router.post("/me/history", async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    const parsed = parseItemBody(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    try {
      await upsertHistory(user.id, parsed);
      return res.json({ ok: true });
    } catch (err) {
      console.error("[history/upsert]", err);
      return res.status(500).json({ error: "Gagal menyimpan riwayat." });
    }
  });

  router.delete("/me/history/:collection/:slug", async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    const collection = String(req.params.collection || "").trim();
    const slug = String(req.params.slug || "")
      .trim()
      .toLowerCase();
    if (!ITEM_COLLECTIONS.includes(collection) || !slug) {
      return res.status(400).json({ error: "collection/slug wajib." });
    }
    try {
      await removeHistory(user.id, collection, slug);
      return res.json({ ok: true });
    } catch (err) {
      console.error("[history/remove]", err);
      return res.status(500).json({ error: "Gagal menghapus riwayat." });
    }
  });

  return router;
}
