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

/** Baris lama tanpa userId milik akun dasbor (id 1). */
function owns(row, userId) {
  return Number(row.userId ?? 1) === Number(userId);
}

let writeQueue = Promise.resolve();

/** Banyak akun menulis file yang sama: antrikan agar tidak saling menimpa. */
function update(fn) {
  const run = writeQueue.then(async () => {
    const data = await load();
    await fn(data);
    await save(data);
  });
  writeQueue = run.catch(() => {});
  return run;
}

export async function ensureUserLibrarySchema() {
  await update(() => {});
}

export async function listFavorites(userId, limit = 100) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 200);
  const data = await load();
  return data.favorites.filter((row) => owns(row, userId)).slice(0, safeLimit);
}

export async function isFavorite(userId, collection, slug) {
  const data = await load();
  const key = String(slug || "").toLowerCase();
  return data.favorites.some(
    (row) => owns(row, userId) && row.collection === collection && row.slug === key
  );
}

export async function addFavorite(userId, { collection, slug, title, thumbnail }) {
  const key = clean(slug, 191)?.toLowerCase();
  const col = clean(collection, 32);
  if (!key || !col) return;
  await update((data) => {
    const row = {
      userId: Number(userId),
      collection: col,
      slug: key,
      title: clean(title, 512),
      thumbnail: clean(thumbnail, 2000),
      createdAt: new Date().toISOString(),
    };
    const index = data.favorites.findIndex(
      (item) => owns(item, userId) && item.collection === col && item.slug === key
    );
    if (index >= 0) data.favorites[index] = { ...data.favorites[index], ...row, createdAt: data.favorites[index].createdAt };
    else data.favorites.unshift(row);
  });
}

export async function removeFavorite(userId, collection, slug) {
  const key = String(slug || "").toLowerCase();
  await update((data) => {
    data.favorites = data.favorites.filter(
      (row) => !(owns(row, userId) && row.collection === collection && row.slug === key)
    );
  });
}

export async function listHistory(userId, limit = 40) {
  const safeLimit = Math.min(Math.max(Number(limit) || 40, 1), 100);
  const data = await load();
  return data.history.filter((row) => owns(row, userId)).slice(0, safeLimit);
}

export async function upsertHistory(
  userId,
  { collection, slug, episodeSlug, episodeNum, title, thumbnail, progressSeconds }
) {
  const col = clean(collection, 32);
  const key = clean(slug, 191)?.toLowerCase();
  if (!col || !key) return;
  await update((data) => {
    const row = {
      userId: Number(userId),
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
      (item) =>
        owns(item, userId) &&
        item.collection === col &&
        item.slug === key &&
        item.episodeSlug === row.episodeSlug
    );
    if (index >= 0) data.history.splice(index, 1);
    data.history.unshift(row);
    // Batas 200 riwayat per akun.
    let kept = 0;
    data.history = data.history.filter((item) => !owns(item, userId) || ++kept <= 200);
  });
}

export async function listWatchedEpisodes(userId, collection, slug) {
  const data = await load();
  const key = String(slug || "").toLowerCase();
  return data.history
    .filter((row) => owns(row, userId) && row.collection === collection && row.slug === key && row.episodeSlug)
    .map((row) => ({ episodeSlug: row.episodeSlug, episodeNum: row.episodeNum }));
}

export async function removeHistory(userId, collection, slug) {
  const key = String(slug || "").toLowerCase();
  await update((data) => {
    data.history = data.history.filter(
      (row) => !(owns(row, userId) && row.collection === collection && row.slug === key)
    );
  });
}
