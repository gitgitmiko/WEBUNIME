import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../data/library.json");

function clean(value, max) {
  const text = String(value || "").trim();
  return text ? text.slice(0, max) : null;
}

async function load() {
  try {
    const data = JSON.parse(await readFile(file, "utf8"));
    return {
      favorites: Array.isArray(data.favorites) ? data.favorites : [],
      history: Array.isArray(data.history) ? data.history : [],
    };
  } catch {
    return { favorites: [], history: [] };
  }
}

async function save(data) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(data), "utf8");
}

export async function ensureUserLibrarySchema() {
  const data = await load();
  await save(data);
}

export async function listFavorites(_userId, limit = 100) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 200);
  const data = await load();
  return data.favorites.slice(0, safeLimit);
}

export async function isFavorite(_userId, collection, slug) {
  const data = await load();
  const key = String(slug || "").toLowerCase();
  return data.favorites.some((row) => row.collection === collection && row.slug === key);
}

export async function addFavorite(_userId, { collection, slug, title, thumbnail }) {
  const data = await load();
  const key = clean(slug, 191)?.toLowerCase();
  const col = clean(collection, 32);
  if (!key || !col) return;
  const row = {
    collection: col,
    slug: key,
    title: clean(title, 512),
    thumbnail: clean(thumbnail, 2000),
    createdAt: new Date().toISOString(),
  };
  const index = data.favorites.findIndex((item) => item.collection === col && item.slug === key);
  if (index >= 0) data.favorites[index] = { ...data.favorites[index], ...row, createdAt: data.favorites[index].createdAt };
  else data.favorites.unshift(row);
  await save(data);
}

export async function removeFavorite(_userId, collection, slug) {
  const data = await load();
  const key = String(slug || "").toLowerCase();
  data.favorites = data.favorites.filter((row) => !(row.collection === collection && row.slug === key));
  await save(data);
}

export async function listHistory(_userId, limit = 40) {
  const safeLimit = Math.min(Math.max(Number(limit) || 40, 1), 100);
  const data = await load();
  return data.history.slice(0, safeLimit);
}

export async function upsertHistory(
  _userId,
  { collection, slug, episodeSlug, episodeNum, title, thumbnail, progressSeconds }
) {
  const data = await load();
  const col = clean(collection, 32);
  const key = clean(slug, 191)?.toLowerCase();
  if (!col || !key) return;
  const row = {
    collection: col,
    slug: key,
    episodeSlug: clean(episodeSlug, 191),
    episodeNum: Number(episodeNum) || null,
    title: clean(title, 512),
    thumbnail: clean(thumbnail, 2000),
    progressSeconds: Number(progressSeconds) || 0,
    lastWatchedAt: new Date().toISOString(),
  };
  const index = data.history.findIndex(
    (item) => item.collection === col && item.slug === key && item.episodeSlug === row.episodeSlug
  );
  if (index >= 0) data.history.splice(index, 1);
  data.history.unshift(row);
  data.history = data.history.slice(0, 200);
  await save(data);
}

export async function listWatchedEpisodes(_userId, collection, slug) {
  const data = await load();
  const key = String(slug || "").toLowerCase();
  return data.history
    .filter((row) => row.collection === collection && row.slug === key && row.episodeSlug)
    .map((row) => ({ episodeSlug: row.episodeSlug, episodeNum: row.episodeNum }));
}

export async function removeHistory(_userId, collection, slug) {
  const data = await load();
  const key = String(slug || "").toLowerCase();
  data.history = data.history.filter((row) => !(row.collection === collection && row.slug === key));
  await save(data);
}
