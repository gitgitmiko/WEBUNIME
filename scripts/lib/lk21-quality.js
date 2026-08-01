const QUALITY_NAMES = new Map([
  ["hd", "HD"],
  ["hdtv", "HDTV"],
  ["fullhd", "FHD"],
  ["full-hd", "FHD"],
  ["fhd", "FHD"],
  ["cam", "CAM"],
  ["hdcam", "HDCAM"],
  ["ts", "TS"],
  ["telesync", "TS"],
  ["sd", "SD"],
  ["bluray", "BluRay"],
  ["blu-ray", "BluRay"],
  ["webdl", "WEB-DL"],
  ["web-dl", "WEB-DL"],
  ["webrip", "WEBRip"],
  ["web-rip", "WEBRip"],
  ["dvd", "DVD"],
  ["dvdrip", "DVDRip"],
]);

function normalizeQuality(raw) {
  const value = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
  if (!value) return "";
  return QUALITY_NAMES.get(value) || value.toUpperCase();
}

/**
 * Kualitas hanya ada sebagai badge di kartu listing. Halaman detail tidak
 * memuatnya: link /quality/... di sana adalah menu navigasi global dan badge
 * lain milik kartu film terkait, sehingga keduanya bukan sumber yang sahih.
 *
 * @param {string} block satu blok <article> dari halaman listing
 */
export function extractLk21Quality(block) {
  const source = String(block || "");
  const badgeClass = source.match(
    /class=["'][^"']*\blabel-([a-z0-9-]+)\b[^"']*["']/i
  )?.[1];
  if (badgeClass) return normalizeQuality(badgeClass);

  const badgeText = source.match(
    /class=["'][^"']*\blabel\b[^"']*["'][^>]*>\s*([^<]+?)\s*</i
  )?.[1];
  return normalizeQuality(badgeText);
}

/** Badge listing selalu mencerminkan kualitas rilis terbaru di LK21. */
export function shouldRefreshLk21Quality(current, listed) {
  const newValue = normalizeQuality(listed);
  if (!newValue) return false;
  return normalizeQuality(current) !== newValue;
}
