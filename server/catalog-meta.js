/** Koleksi array (satu item = satu baris). */
export const ITEM_COLLECTIONS = [
  "movies",
  "series",
  "horror",
  "indonesia",
  "anime",
  "anime-movies",
  "anime-latest",
  "series-latest",
];

/** Dokumen utuh (jadwal, status, peta players). */
export const DOC_NAMES = [
  "anime-schedule",
  "sync-status",
  "players",
  "series-players",
  "horror-players",
  "indonesia-players",
];

export function isItemCollection(name) {
  return ITEM_COLLECTIONS.includes(name);
}

export function isDocName(name) {
  return DOC_NAMES.includes(name);
}

export function itemSlug(item, collection) {
  if (!item || typeof item !== "object") return null;
  const raw =
    item.slug ||
    item.anime_slug ||
    item.series_slug ||
    item.id ||
    `${collection}-${item.nama || item.judul || "item"}`;
  const slug = String(raw)
    .trim()
    .toLowerCase()
    .slice(0, 191);
  return slug || null;
}

export function itemMeta(item) {
  return {
    title: String(item.nama || item.judul || "").slice(0, 512) || null,
    year: item.tahun != null ? String(item.tahun).slice(0, 32) : null,
    thumbnail: item.thumbnail != null ? String(item.thumbnail) : null,
    rating: item.rating != null ? String(item.rating).slice(0, 64) : null,
  };
}
