import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDocName, isItemCollection, rewriteItemPosters } from "./catalog-meta.js";
import { toCard } from "./catalog.js";

const dataDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public/data");
const cache = new Map();

async function loadJson(name) {
  const file = path.join(dataDir, `${name}.json`);
  let mtime = 0;
  try {
    mtime = (await stat(file)).mtimeMs;
  } catch {
    return null;
  }
  const hit = cache.get(file);
  if (hit && hit.mtime === mtime) return hit.data;
  const data = JSON.parse(await readFile(file, "utf8"));
  cache.set(file, { mtime, data });
  return data;
}

function asList(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.items)) return data.items;
  return [];
}

function text(value) {
  return String(value || "").trim().toLowerCase();
}

function ratingNum(item) {
  const n = Number(String(item?.rating ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function yearNum(item) {
  const n = Number(String(item?.tahun ?? item?.year ?? "").slice(0, 4));
  return Number.isFinite(n) ? n : null;
}

function slugOf(item) {
  return text(item?.slug || item?.anime_slug || item?.series_slug || item?.id);
}

function matchesQuery(item, query) {
  if (!query) return true;
  const q = text(query);
  return text(item?.nama).includes(q) || text(item?.judul).includes(q) || slugOf(item).includes(q);
}

function matchesGenre(item, genres) {
  if (!genres.length) return true;
  const own = (Array.isArray(item?.genre) ? item.genre : []).map((g) => text(g));
  return genres.some((g) => own.includes(text(g)));
}

function parseGenres(raw) {
  return String(raw || "")
    .split(",")
    .map((g) => g.trim())
    .filter((g) => /^[A-Za-z0-9][A-Za-z0-9 \-]{0,40}$/.test(g))
    .slice(0, 8);
}

function shuffle(items) {
  const copy = items.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

async function collectionItems(name) {
  return asList(await loadJson(name));
}

async function withParentMeta(collection, items) {
  const parent = collection === "anime-latest" ? "anime" : collection === "series-latest" ? "series" : null;
  if (!parent || !items.length) return items;
  const parents = await collectionItems(parent);
  const bySlug = new Map(parents.map((item) => [slugOf(item), item]));
  return items.map((item) => {
    const meta = bySlug.get(text(item.anime_slug || item.series_slug || item.slug));
    if (!meta) return item;
    return {
      ...item,
      rating: item.rating || meta.rating,
      tahun: item.tahun || meta.tahun,
      quality: item.quality || meta.quality,
    };
  });
}

export async function listCollection(collection, { page = 1, limit = 50, q = "", genre = "", sort = "" } = {}) {
  if (!isItemCollection(collection)) return null;
  const sortKey = String(sort || "").toLowerCase();
  const isTopRandom = sortKey === "top_random";
  const safeLimit = isTopRandom
    ? Math.min(Math.max(Number(limit) || 10, 1), 10)
    : Math.min(Math.max(Number(limit) || 50, 1), 200);
  const safePage = isTopRandom ? 1 : Math.max(Number(page) || 1, 1);
  const genres = parseGenres(genre);
  let items = await collectionItems(collection);
  items = items.filter((item) => matchesQuery(item, q) && matchesGenre(item, genres));
  if (sortKey === "rating" || sortKey === "top" || isTopRandom) {
    items = items.filter((item) => ratingNum(item) != null);
  }
  if (isTopRandom) items = items.filter((item) => ratingNum(item) > 8);
  if (sortKey === "hot") {
    const maxYear = new Date().getFullYear() + 1;
    items = items.filter((item) => {
      const year = yearNum(item);
      return year && year >= 1970 && year <= maxYear && ratingNum(item) != null;
    });
  }
  if (isTopRandom) items = shuffle(items);
  else if (sortKey === "rating" || sortKey === "top") {
    items = items.slice().sort((a, b) => (ratingNum(b) || 0) - (ratingNum(a) || 0));
  } else if (sortKey === "hot") {
    items = items.slice().sort((a, b) => (yearNum(b) || 0) - (yearNum(a) || 0) || (ratingNum(b) || 0) - (ratingNum(a) || 0));
  }
  const total = isTopRandom ? Math.min(items.length, safeLimit) : items.length;
  const slice = isTopRandom ? items.slice(0, safeLimit) : items.slice((safePage - 1) * safeLimit, safePage * safeLimit);
  const cards = (await withParentMeta(collection, slice)).map((item) => toCard(item, collection));
  return { collection, page: safePage, limit: safeLimit, total, items: cards };
}

export async function searchCatalog({ q = "", limit = 40 } = {}) {
  const query = String(q || "").trim();
  if (!query) return { q: "", total: 0, items: [] };
  const safeLimit = Math.min(Math.max(Number(limit) || 40, 1), 80);
  const names = ["movies", "series", "horror", "marvel", "indonesia", "anime", "anime-movies"];
  const found = [];
  for (const name of names) {
    const items = await collectionItems(name);
    for (const item of items) {
      if (matchesQuery(item, query)) found.push(toCard(item, name));
    }
  }
  return { q: query, total: found.length, items: found.slice(0, safeLimit) };
}

export async function listHero({ limit = 10 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 24);
  const names = ["movies", "series", "horror", "indonesia", "anime", "anime-movies"];
  const pool = [];
  for (const name of names) {
    const items = await collectionItems(name);
    for (const item of items) {
      if (!item?.thumbnail) continue;
      if (!(ratingNum(item) > 8)) continue;
      pool.push(toCard(item, name));
    }
  }
  const seen = new Set();
  const items = [];
  for (const item of shuffle(pool)) {
    const key = text(item.slug || item.nama);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    items.push(item);
    if (items.length >= safeLimit) break;
  }
  return { items };
}

export async function listCollectionAll(collection) {
  if (!isItemCollection(collection)) return null;
  return collectionItems(collection);
}

export async function getItem(collection, slug) {
  if (!isItemCollection(collection)) return null;
  const wanted = text(slug);
  const items = await collectionItems(collection);
  const item = items.find((row) => slugOf(row) === wanted);
  return item ? rewriteItemPosters(item) : null;
}

export async function getDoc(name) {
  if (!isDocName(name)) return null;
  return loadJson(name);
}
