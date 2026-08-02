/**
 * Ekstraksi kandidat gambar landscape dari HTML detail
 * + normalisasi host poster mati.
 */

const LANDSCAPE_HINT =
  /banner|backdrop|cover|landscape|wide|slider|hero|featured|1920|1280|16.?9|w780|original|fanart/i;
const PORTRAIT_HINT = /poster|thumb|portrait|-\d{2,3}x\d{3,4}\.(jpe?g|png|webp)/i;

export function rewriteDeadPosterHost(url) {
  if (!url || typeof url !== "string") return url || "";
  return url
    .replace(/https?:\/\/poster\.showcdnx\.com/gi, "https://poster.lk21official.cc")
    .replace(/https?:\/\/image\.showcdnx\.com/gi, "https://poster.lk21official.cc")
    .replace(/https?:\/\/cover\.showcdnx\.com/gi, "https://cover.lk21official.cc");
}

export function absUrl(href, base = "https://tv12.lk21official.cc") {
  const raw = String(href || "").trim();
  if (!raw) return "";
  try {
    return new URL(raw, base).href;
  } catch {
    return raw;
  }
}

function normalizeUrl(url, base) {
  return rewriteDeadPosterHost(absUrl(url, base));
}

function pathKey(url) {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`.toLowerCase().replace(/\/+$/, "");
  } catch {
    return String(url || "").toLowerCase();
  }
}

function isLikelyLandscapeUrl(url) {
  if (LANDSCAPE_HINT.test(url)) return true;
  // TMDB backdrop selalu landscape
  if (/image\.tmdb\.org/i.test(url) && /\/backdrop|\/w\d{3,4}\//i.test(url)) return true;
  return false;
}

function isLikelyPortraitUrl(url) {
  if (isLikelyLandscapeUrl(url)) return false;
  return PORTRAIT_HINT.test(url);
}

function metaContent(html, names) {
  for (const name of names) {
    const re1 = new RegExp(
      `(?:name|property)=["']${name}["'][^>]*content=["']([^"']+)["']`,
      "i"
    );
    const re2 = new RegExp(
      `content=["']([^"']+)["'][^>]*(?:name|property)=["']${name}["']`,
      "i"
    );
    const m = html.match(re1) || html.match(re2);
    if (m?.[1]) return m[1];
  }
  return "";
}

/**
 * Ambil URL gambar lebar dari HTML detail (bukan poster potret).
 * @param {string} html
 * @param {{ portraitUrl?: string, base?: string }} [opts]
 * @returns {string|null}
 */
export function extractSiteLandscape(html, opts = {}) {
  const portrait = normalizeUrl(opts.portraitUrl || "", opts.base);
  const portraitKey = portrait ? pathKey(portrait) : "";
  const base = opts.base || "https://tv12.lk21official.cc";
  const scored = [];

  const push = (raw, score) => {
    const url = normalizeUrl(raw, base);
    if (!url || !/^https?:\/\//i.test(url)) return;
    if (portraitKey && pathKey(url) === portraitKey) return;
    if (isLikelyPortraitUrl(url) && !isLikelyLandscapeUrl(url)) return;
    scored.push({ url, score: score + (isLikelyLandscapeUrl(url) ? 20 : 0) });
  };

  const twitter = metaContent(html, ["twitter:image", "twitter:image:src"]);
  if (twitter) push(twitter, 50);

  const og = metaContent(html, ["og:image", "og:image:secure_url"]);
  if (og && isLikelyLandscapeUrl(og)) push(og, 40);

  const imgRe =
    /<img\b([^>]*?)src=["']([^"']+)["']([^>]*)>|<img\b([^>]*?)data-src=["']([^"']+)["']([^>]*)>/gi;
  let m;
  while ((m = imgRe.exec(html)) !== null) {
    const attrs = `${m[1] || m[4] || ""} ${m[3] || m[6] || ""}`;
    const src = m[2] || m[5] || "";
    if (!src || /data:|svg|icon|avatar|logo|emoji/i.test(src)) continue;
    let score = 10;
    if (/banner|backdrop|cover|slider|hero|featured|landscape|wide/i.test(attrs)) score += 35;
    if (/wp-post-image|attachment-post-thumbnail/i.test(attrs)) score -= 30;
    push(src, score);
  }

  // Aspect hint di style width/height (lebar > tinggi * 1.4)
  const styleImgRe =
    /<img\b[^>]*(?:width=["'](\d+)["'][^>]*height=["'](\d+)["']|height=["'](\d+)["'][^>]*width=["'](\d+)["'])[^>]*src=["']([^"']+)["'][^>]*>/gi;
  while ((m = styleImgRe.exec(html)) !== null) {
    const w = Number(m[1] || m[4] || 0);
    const h = Number(m[2] || m[3] || 0);
    const src = m[5];
    if (w > 0 && h > 0 && w / h >= 1.4) push(src, 45);
  }

  scored.sort((a, b) => b.score - a.score);
  const best = scored.find((c) => c.score >= 40) || scored.find((c) => isLikelyLandscapeUrl(c.url));
  return best?.url || null;
}

export function cleanSearchTitle(raw) {
  return String(raw || "")
    .replace(/\s*\(\d{4}\)\s*$/g, "")
    .replace(/\s+Subtitle Indonesia.*$/i, "")
    .replace(/\s+Sub Indo.*$/i, "")
    .replace(/\s+–\s*Samehadaku.*$/i, "")
    .replace(/\s+di\s+Lk21.*$/i, "")
    .replace(/^Nonton\s+(?:Serial\s+)?/i, "")
    .trim();
}

export function extractYear(item) {
  const y = String(item?.tahun || "").match(/\b(19|20)\d{2}\b/)?.[0];
  if (y) return y;
  const fromTitle = String(item?.judul || item?.nama || "").match(/\((\d{4})\)\s*$/);
  return fromTitle?.[1] || "";
}

export function hasValidLandscape(item) {
  const u = item?.thumbnail_landscape;
  return typeof u === "string" && /^https?:\/\//i.test(u.trim());
}
