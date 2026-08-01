const QUALITY_NAMES = new Map([
  ["bluray", "BluRay"],
  ["blu-ray", "BluRay"],
  ["webdl", "WEB-DL"],
  ["web-dl", "WEB-DL"],
  ["webrip", "WEBRip"],
  ["web-rip", "WEBRip"],
  ["fullhd", "FHD"],
  ["full-hd", "FHD"],
  ["fhd", "FHD"],
  ["hd", "HD"],
  ["hdtv", "HDTV"],
  ["cam", "CAM"],
  ["hdcam", "HDCAM"],
  ["ts", "TS"],
  ["telesync", "TS"],
  ["sd", "SD"],
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
 * Halaman detail memiliki link /quality/bluray yang lebih spesifik daripada
 * badge listing (biasanya hanya HD), jadi link selalu diprioritaskan.
 */
export function extractLk21Quality(html, fallback = "") {
  const source = String(html || "");
  const detailQuality = source.match(
    /href=["'][^"']*\/quality\/([^"'/?#]+)[^"']*["']/i
  )?.[1];
  if (detailQuality) return normalizeQuality(detailQuality);

  const badgeClass = source.match(
    /class=["'][^"']*\blabel-([a-z0-9_-]+)\b[^"']*["']/i
  )?.[1];
  if (badgeClass) return normalizeQuality(badgeClass);

  const badgeText = source.match(
    /class=["'][^"']*\blabel\b[^"']*["'][^>]*>\s*([^<]+)\s*</i
  )?.[1];
  return normalizeQuality(badgeText) || normalizeQuality(fallback);
}

/**
 * Badge HD tidak boleh menurunkan sumber yang lebih spesifik seperti BluRay.
 */
export function shouldRefreshLk21Quality(current, listed) {
  const oldValue = normalizeQuality(current);
  const newValue = normalizeQuality(listed);
  if (!newValue) return false;
  if (!oldValue) return true;
  if (oldValue === newValue) return false;
  if (
    newValue === "HD" &&
    ["BluRay", "WEB-DL", "WEBRip", "FHD", "HDTV"].includes(oldValue)
  ) {
    return false;
  }
  return true;
}
