/** Koleksi array (satu item = satu baris). */
export const ITEM_COLLECTIONS = [
  "movies",
  "series",
  "horror",
  "marvel",
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

/** Host poster mati (DNS) → mirror aktif. cover.showcdnx.com dibiarkan. */
export function rewriteDeadPosterHost(url) {
  if (!url || typeof url !== "string") return url || "";
  return url
    .replace(/https?:\/\/(?:poster|image)\.showcdnx\.com/gi, "https://poster.assetsy.de")
    .replace(/https?:\/\/(?:www\.)?anoboy\.xyz/gi, "https://anoboy.quest");
}

export function rewriteItemPosters(item) {
  if (!item || typeof item !== "object") return item;
  const out = { ...item };
  if (out.thumbnail) out.thumbnail = rewriteDeadPosterHost(out.thumbnail);
  if (out.thumbnail_landscape) {
    out.thumbnail_landscape = rewriteDeadPosterHost(out.thumbnail_landscape);
  }
  return out;
}

export function itemMeta(item) {
  const thumb =
    item.thumbnail != null ? rewriteDeadPosterHost(String(item.thumbnail)) : null;
  return {
    title: String(item.nama || item.judul || "").slice(0, 512) || null,
    year: item.tahun != null ? String(item.tahun).slice(0, 32) : null,
    thumbnail: thumb,
    rating: item.rating != null ? String(item.rating).slice(0, 64) : null,
  };
}
